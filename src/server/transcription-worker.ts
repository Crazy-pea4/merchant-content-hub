import { get, transaction } from './db';
import { AsrError, asrConfiguration } from './asr';
import { runTranscription, ApiError } from './service';
import { claimTranscription, ownsTranscription, transcriptFingerprint, updateClaim, wakeTranscriptionJobs, type TranscriptionJob } from './transcription-queue';
import { isUsable } from './search';

type WorkerOptions = { leaseMs?: number; heartbeatMs?: number; pollMs?: number };
const active = new Map<string, { job: TranscriptionJob; controller: AbortController }>();
export async function processNextTranscription(options: WorkerOptions = {}) {
  const leaseMs = options.leaseMs ?? 30000;
  const job = (await claimTranscription(leaseMs)); if (!job) return false;
  const controller = new AbortController(); active.set(job.leaseToken!, { job, controller });
  const valid = async () => {
    const asset = (await get('assets', job.id));
    return (await ownsTranscription(job)) && !!asset && isUsable(asset) && transcriptFingerprint(asset) === job.fingerprint;
  };
  const heartbeat = setInterval(async () => {
    try { if (!(await valid())) controller.abort(); else await updateClaim(job, { leaseUntil: Date.now() + leaseMs }); } catch { controller.abort(); }
  }, options.heartbeatMs ?? 5000); heartbeat.unref();
  try {
    const remote = (await get('asr_jobs', job.id)), config = asrConfiguration();
    if (job.submissionStarted && !remote) throw new AsrError('上次转写提交未确认，请点击重试转写', true);
    if (job.submissionStarted && remote && (config?.provider !== 'aliyun' || remote.model !== config.model || remote.baseUrl !== config.baseUrl || remote.fingerprint !== job.fingerprint || Date.now() - Date.parse(remote.createdAt) > 23 * 3600000)) throw new AsrError('原转写任务已过期或服务配置已变更，请点击重试转写', true);
    await runTranscription(job.id, {
      signal: controller.signal, isCurrent: valid,
      onSaved: async () => { if (!(await updateClaim(job, { status: 'completed', error: null, leaseToken: null, leaseUntil: 0 }))) throw new ApiError('后台任务已更新，结果将由当前任务保存', 409); },
      beforeSubmit: () => transaction(async () => { if (!(await valid()) || !(await updateClaim(job, { submissionStarted: true }))) throw new AsrError('转写任务已更新', true); })
    });
    (await updateClaim(job, { status: 'completed', error: null, leaseToken: null, leaseUntil: 0 }));
  } catch (error) {
    if (!(await ownsTranscription(job))) return true;
    const asset = (await get('assets', job.id));
    if (!asset) return true;
    if (!isUsable(asset) || transcriptFingerprint(asset) !== job.fingerprint) {
      (await updateClaim(job, { status: !isUsable(asset) ? 'waiting_authorization' : 'cancelled', error: !isUsable(asset) ? null : '逐字稿已变更，后台结果未覆盖', leaseToken: null, leaseUntil: 0 }));
    } else {
      const remote = (await get('asr_jobs', job.id));
      const retry = error instanceof AsrError && !error.terminal && !!remote && (error.pending || job.failures < 3);
      const safeMessage = error instanceof AsrError || error instanceof ApiError || error instanceof Error && /^(音轨提取|提取音轨|提取音频|ASR 服务|ASR 没有|尚未配置)/.test(error.message) ? (error as Error).message : '语音转写失败，请稍后重试';
      (await updateClaim(job, { status: retry ? 'retrying' : 'failed', error: retry && error instanceof AsrError && error.pending ? null : safeMessage, failures: job.failures + (error instanceof AsrError && error.pending ? 0 : 1), runAt: Date.now() + (error instanceof AsrError && error.pending ? 2000 : Math.min(300000, 10000 * 2 ** job.failures)), leaseToken: null, leaseUntil: 0 }));
    }
  } finally { clearInterval(heartbeat); active.delete(job.leaseToken!); }
  return true;
}
const workerKey = Symbol.for('fieldwork.transcription-worker');
export function startTranscriptionWorker(options: WorkerOptions = {}) {
  const registry = globalThis as typeof globalThis & { [workerKey]?: { stop: () => Promise<void> } };
  if (registry[workerKey]) return registry[workerKey]!;
  let stopped = false, running = false, lastWake = 0;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      if (Date.now() - lastWake > 10000) { (await wakeTranscriptionJobs()); lastWake = Date.now(); }
      if (stopped) return;
      await processNextTranscription(options);
    } catch { console.error('Background ASR worker cycle failed'); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, options.pollMs ?? 750); timer.unref();
  const stop = async () => {
    if (stopped) return; stopped = true; clearInterval(timer);
    for (const { job, controller } of active.values()) { (await updateClaim(job, { status: 'queued', runAt: Date.now(), leaseToken: null, leaseUntil: 0 })); controller.abort(); }
    delete registry[workerKey];
  };
  registry[workerKey] = { stop }; void tick(); return registry[workerKey]!;
}
