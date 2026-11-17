export { transcriptFingerprint } from './transcript-fingerprint';
import { transcriptFingerprint } from './transcript-fingerprint';
import { all, databaseDriver, db, get, id, now, put, transaction } from './db';
import { asrReady } from './asr';
import { isUsable } from './search';
import type { Asset, TranscriptionState, TranscriptionStatus } from '../shared/types';

export interface TranscriptionJob {
  id: string; projectId: string; status: TranscriptionStatus; fingerprint: string;
  createdAt: string; updatedAt: string; runAt: number; leaseUntil: number;
  leaseToken: string | null; attempts: number; failures: number;
  error: string | null; submissionStarted: boolean;
}
export const isMediaAsset = (asset: Asset) => !!asset.storageKey && ['video', 'audio'].includes(asset.kind);
const activeStatuses = new Set<TranscriptionStatus>(['queued', 'processing', 'retrying']);
export function publicTranscription(job: TranscriptionJob): TranscriptionState {
  return { status: job.status, updatedAt: job.updatedAt, error: job.error, ...(job.status === 'retrying' ? { nextAttemptAt: new Date(job.runAt).toISOString() } : {}) };
}
export async function withTranscription(asset: Asset): Promise<Asset> {
  const job = (await get('transcription_jobs', asset.id));
  return job ? { ...asset, transcription: publicTranscription(job) } : asset;
}
export async function assetsWithTranscription() {
  const jobs = new Map((await all('transcription_jobs')).map(job => [job.id, job]));
  return (await all('assets')).map(asset => { const job = jobs.get(asset.id); return job ? { ...asset, transcription: publicTranscription(job) } : asset; });
}
// Call inside the same transaction as the upload/update so the task cannot be lost.
export async function enqueueTranscription(asset: Asset, retry = false): Promise<TranscriptionJob | undefined> {
  if (!isMediaAsset(asset)) return;
  const old = (await get('transcription_jobs', asset.id));
  if (old && (activeStatuses.has(old.status) || old.status === 'completed' || old.status === 'skipped')) return old;
  if (old && ['failed', 'cancelled'].includes(old.status) && !retry) return old;
  const status: TranscriptionStatus = asset.hasAudio === false ? 'skipped' : !isUsable(asset) ? 'waiting_authorization' : !asrReady() ? 'waiting_configuration' : 'queued';
  return (await put('transcription_jobs', { id: asset.id, projectId: asset.projectId, status, fingerprint: transcriptFingerprint(asset), createdAt: now(), updatedAt: now(), runAt: Date.now(), leaseUntil: 0, leaseToken: null, attempts: 0, failures: 0, error: status === 'skipped' ? '视频没有音轨，已跳过语音转写' : null, submissionStarted: !retry && !!(await get('asr_jobs', asset.id)) }));
}
export async function reconcileAssetTranscription(asset: Asset, manualTranscript = false) {
  const job = (await get('transcription_jobs', asset.id));
  if (!job) return;
  if (manualTranscript) {
    (await put('transcription_jobs', { ...job, status: 'cancelled', error: '已使用人工逐字稿，后台结果不会覆盖', updatedAt: now(), leaseUntil: 0, leaseToken: null }));
  } else if (!isUsable(asset) && activeStatuses.has(job.status)) {
    (await put('transcription_jobs', { ...job, status: 'waiting_authorization', error: null, updatedAt: now(), leaseUntil: 0, leaseToken: null }));
  } else if (['waiting_authorization', 'waiting_configuration'].includes(job.status)) {
    (await enqueueTranscription(asset));
  }
}
export async function wakeTranscriptionJobs() {
  return transaction(async () => {
  // Adopt previously submitted ASR tasks, but never automatically bill for old unprocessed assets.
  for (const remote of (await all('asr_jobs'))) {
    const asset = (await get('assets', remote.id));
    if (asset && !(await get('transcription_jobs', asset.id))) (await enqueueTranscription(asset));
  }
  const waiting = (await db.query<{ data: TranscriptionJob }>("SELECT data FROM transcription_jobs WHERE status IN ('waiting_authorization','waiting_configuration')")).rows;
  for (const row of waiting) {
    const job: TranscriptionJob = row.data;
    const asset = (await get('assets', job.id)); if (!asset) continue;
    if (job.fingerprint !== transcriptFingerprint(asset)) {
      (await put('transcription_jobs', { ...job, status: 'cancelled', error: '逐字稿已变更，自动转写已停止', updatedAt: now() }));
    } else if (isUsable(asset) && asrReady()) (await enqueueTranscription(asset));
  }
  });
}
export async function claimTranscription(leaseMs: number): Promise<TranscriptionJob | undefined> {
  return (await transaction(async () => {
    const time = Date.now();
    const row = (await db.query<{ data: TranscriptionJob }>(`SELECT data FROM transcription_jobs WHERE (status IN ('queued','retrying') AND run_at<=$1) OR (status='processing' AND lease_until<=$2) ORDER BY run_at,id LIMIT 1${databaseDriver === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : ''}`, [time, time])).rows[0];
    if (!row) return;
    const job: TranscriptionJob = row.data, asset = (await get('assets', job.id));
    if (!asset) return;
    if (transcriptFingerprint(asset) !== job.fingerprint) {
      (await put('transcription_jobs', { ...job, status: 'cancelled', error: '逐字稿已变更，自动转写已停止', updatedAt: now(), leaseUntil: 0, leaseToken: null })); return;
    }
    if (!isUsable(asset) || !asrReady()) {
      (await put('transcription_jobs', { ...job, status: !isUsable(asset) ? 'waiting_authorization' : 'waiting_configuration', updatedAt: now(), leaseUntil: 0, leaseToken: null })); return;
    }
    return (await put('transcription_jobs', { ...job, status: 'processing', leaseToken: id(), leaseUntil: time + leaseMs, attempts: job.attempts + 1, updatedAt: now() }));
  }));
}
export async function ownsTranscription(job: TranscriptionJob) {
  const current = (await get('transcription_jobs', job.id));
  return current?.status === 'processing' && current.leaseToken === job.leaseToken && current.leaseUntil > Date.now();
}
export async function updateClaim(job: TranscriptionJob, patch: Partial<TranscriptionJob>) {
  return transaction(async () => {
  const current = (await get('transcription_jobs', job.id));
  if (current?.status !== 'processing' || current.leaseToken !== job.leaseToken) return;
  const updated = { ...current, ...patch, updatedAt: now() };
  const result = await db.query(`UPDATE transcription_jobs SET status=$1,run_at=$2,lease_until=$3,data=$4 WHERE id=$5 AND status='processing' AND ${databaseDriver === 'postgres' ? "data->>'leaseToken'" : "json_extract(data,'$.leaseToken')"}=$6 AND lease_until>$7`, [updated.status, updated.runAt, updated.leaseUntil, JSON.stringify(updated), job.id, job.leaseToken, Date.now()]);
  return result.rowCount ? updated : undefined;
  });
}
