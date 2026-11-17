import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { all, get, id, now, put, remove, transaction, type Records } from './db';
import { ApiError, required } from './errors';
import { hasCommand, saveUpload, transcribe, uploadDir } from './media';
import { asrConfiguration, asrReady, AsrError } from './asr';
import { createRemoteVoice, deleteRemoteVoice, downloadSpeech, queryRemoteVoice, synthesizeRemote, ttsConfiguration, ttsReady, TtsError, type TtsConfig } from './tts';
import { MAX_DUBBING_TEXT, type Dubbing, type DubbingMedia, type DubbingSnapshot, type DubbingSource, type VoiceProfile } from '../shared/types';
import { resolveDubbingSettings } from '../shared/dubbing-settings';
import { dubbingSettingsShape } from './dubbing-settings';
import { assertScriptExpression, dubbingPartsSchema, validateDubbingScript } from './dubbing-script';
import { speechPlan, dubbingPartsIdentity } from '../shared/dubbing-script';
import { speechClip, speechClipKey } from './speech-clips';
import { assembleDubbingAudio } from './dubbing-audio';

interface WorkState { leaseToken: string | null; leaseUntil: number; runAt: number; submissionStarted: boolean }
export interface StoredVoice extends VoiceProfile, WorkState { sample: DubbingMedia; providerVoiceId: string | null; providerBaseUrl: string | null; account: string | null; sampleHash: string; deleteRequestedAt?: string; remoteDeletedAt?: string }
interface StoredClip { key: string; submissionStarted: boolean; audioUrl: string | null; output: DubbingMedia | null }
export interface StoredDubbing extends Dubbing, WorkState { output: DubbingMedia | null; audioUrl: string | null; clipResults?: StoredClip[] }
export interface StoredDubbingSource extends DubbingSource, WorkState { media: DubbingMedia; fileHash: string; asrTaskId: string | null; asrConfig: string | null; submittedAt: string | null; failures: number }
export function publicVoice(v: StoredVoice): VoiceProfile { const { id, name, sampleDuration, model, status, error, consentAt, createdAt, updatedAt } = v; return { id, name, sampleDuration, model, status: v.deleteRequestedAt ? status === 'failed' ? 'delete_failed' : 'deleting' : status, error, consentAt, createdAt, updatedAt }; }
export function publicDubbing(d: StoredDubbing): Dubbing { const { id, title, text, voiceId, voiceName, sourceId, status, hasAudio, error, createdAt, updatedAt } = d; return { projectId: d.projectId, id, title, text, voiceId, voiceName, sourceId, ...resolveDubbingSettings(d), ...(d.parts ? { parts: d.parts, completedParts: status === 'completed' ? d.parts.length : (d.clipResults || []).filter(clip => clip.output).length } : {}), status, hasAudio, error, createdAt, updatedAt }; }
export function publicSource(s: StoredDubbingSource): DubbingSource { const { id, name, duration, status, segments, error, createdAt, updatedAt } = s; return { projectId: s.projectId, id, name, duration, status, segments, error, createdAt, updatedAt }; }
const idle: WorkState = { leaseToken: null, leaseUntil: 0, runAt: 0, submissionStarted: false };
const identity = z.string().trim().min(1).max(200);
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
function configRequired() { const config = ttsConfiguration(); if (!config) throw new ApiError('尚未配置语音服务；已上传的声音样本会保留'); return config; }
function voiceConfig(voice: StoredVoice, config: TtsConfig) {
  if (voice.account && (voice.account !== config.account || voice.providerBaseUrl !== config.baseUrl)) throw new ApiError('音色所属的语音服务配置已变化，请恢复原配置或重新创建音色');
  return { ...config, model: voice.model };
}
export async function readyDubbingVoice(key: string) {
  const voice = required(await get('voices', key), '音色不存在');
  if (voice.deleteRequestedAt || voice.status !== 'ready' || !voice.providerVoiceId) throw new ApiError('请选择已创建完成的音色');
  return { voice, config: voiceConfig(voice, configRequired()) };
}
async function sourceRequired(sourceId: string | null) {
  if (!sourceId) return null;
  const source = required(await get('dubbing_sources', sourceId), '来源视频已被删除');
  if (source.status !== 'completed' || !source.segments.length) throw new ApiError('来源视频尚无转写文案，请等待提取完成');
  return source;
}
// Share media validation/storage only; these files never enter the business asset library.
async function saveIndependentMedia(file: File): Promise<DubbingMedia> {
  const media = await saveUpload(file, '', [], 'authorized', '', '');
  if (media.thumbnailKey) await unlink(join(uploadDir, media.thumbnailKey)).catch(() => {});
  if (media.kind !== 'video' && media.kind !== 'audio') { await unlink(join(uploadDir, media.storageKey)).catch(() => {}); throw new ApiError('请选择视频或音频文件'); }
  const { id, name, kind, mime, size, storageKey, duration, hasAudio } = media;
  return { id, name, kind, mime, size, storageKey, duration, hasAudio };
}
export async function dubbingSnapshot(projectId?: string): Promise<DubbingSnapshot> {
  const [ffmpeg, ffprobe, voices, dubbings, sources] = await Promise.all([hasCommand('ffmpeg'), hasCommand('ffprobe'), all('voices'), all('dubbings'), all('dubbing_sources')]);
  const tts = ttsReady();
  return { voices: voices.map(publicVoice), dubbings: dubbings.filter(d => !projectId || !d.projectId || d.projectId === projectId).map(publicDubbing), sources: sources.filter(s => !projectId || !s.projectId || s.projectId === projectId).map(publicSource), capabilities: { tts, ttsModel: tts ? ttsConfiguration()?.model : undefined, asr: asrReady(), ffmpeg, ffprobe, authRequired: !!process.env.HUB_ACCESS_TOKEN } };
}
export async function dubbingFile(key: string, sample: boolean, source: boolean) {
  if (sample) return required(await get('voices', key), '音色不存在').sample;
  if (source) return required(await get('dubbing_sources', key), '来源视频不存在').media;
  return required(required(await get('dubbings', key), '配音不存在').output || undefined, '配音尚未完成');
}
export async function createVoice(form: FormData) {
  const { requestId, name } = z.object({ requestId: z.string().uuid(), name: z.string().trim().min(1).max(80), consent: z.literal('true') }).parse(Object.fromEntries(['requestId', 'name', 'consent'].map(key => [key, form.get(key)])));
  const file = form.get('file');
  if (!(file instanceof File) || !file.size || file.size > 10 * 1024 * 1024 || !/\.(wav|mp3|m4a)$/i.test(file.name)) throw new ApiError('请选择不超过 10 MB 的 WAV、MP3 或 M4A 录音');
  const sampleHash = createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex');
  const sameRequest = (v: StoredVoice) => { if (v.name !== name || v.sampleHash !== sampleHash) throw new ApiError('上传请求编号已被使用，请重新提交', 409); return publicVoice(v); };
  const existing = await get('voices', requestId); if (existing) return sameRequest(existing);
  if (!await hasCommand('ffprobe') || !await hasCommand('ffmpeg')) throw new ApiError('声音上传需要可用的音频处理服务');
  const sample = await saveIndependentMedia(file); let retained = false;
  try {
    if (sample.duration === null || sample.duration < 5 || sample.duration > 60) throw new ApiError('录音需要 5～60 秒，推荐 10～20 秒清晰、连续的单人朗读');
    const result = await transaction(async () => {
      const duplicate = await get('voices', requestId); if (duplicate) return sameRequest(duplicate);
      const config = ttsConfiguration();
      return publicVoice(await put('voices', { ...idle, id: requestId, name, sample, sampleDuration: sample.duration, model: config?.model || process.env.TTS_MODEL || 'cosyvoice-v3-flash', providerVoiceId: null, providerBaseUrl: null, account: null, sampleHash, status: config ? 'queued' : 'waiting_configuration', error: null, consentAt: now(), createdAt: now(), updatedAt: now() }));
    });
    retained = (await get('voices', result.id))?.sample.id === sample.id; return result;
  } finally { if (!retained) await unlink(join(uploadDir, sample.storageKey)).catch(() => {}); }
}
export async function uploadDubbingSource(form: FormData) {
  const projectId = identity.optional().parse(form.get('projectId') ?? undefined);
  if (projectId) required(await get('projects', projectId), '项目不存在');
  const requestId = z.string().uuid().parse(form.get('requestId')); z.literal('true').parse(form.get('consent'));
  const file = form.get('file'); if (!(file instanceof File) || !/\.(mp4|mov|webm|wav|mp3|m4a|ogg|flac)$/i.test(file.name)) throw new ApiError('请选择视频或音频文件');
  const fileHash = createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex');
  const sameRequest = (s: StoredDubbingSource) => { if (s.fileHash !== fileHash || s.name !== file.name || s.projectId !== projectId) throw new ApiError('上传请求编号已被使用', 409); return publicSource(s); };
  const existing = await get('dubbing_sources', requestId); if (existing) return sameRequest(existing);
  if (!await hasCommand('ffprobe') || !await hasCommand('ffmpeg')) throw new ApiError('视频上传需要可用的音频处理服务');
  const media = await saveIndependentMedia(file); let retained = false;
  try {
    const result = await transaction(async () => {
      const duplicate = await get('dubbing_sources', requestId); if (duplicate) return sameRequest(duplicate);
      return publicSource(await put('dubbing_sources', { ...idle, id: requestId, projectId, name: media.name, duration: media.duration, media, fileHash, status: media.hasAudio === false ? 'skipped' : asrReady() ? 'queued' : 'waiting_configuration', segments: [], error: null, asrTaskId: null, asrConfig: null, submittedAt: null, failures: 0, createdAt: now(), updatedAt: now() }));
    });
    retained = (await get('dubbing_sources', result.id))?.media.id === media.id; return result;
  } finally { if (!retained) await unlink(join(uploadDir, media.storageKey)).catch(() => {}); }
}
export async function enqueueDubbing(input: unknown) {
  const { requestId, ...data } = z.object({ requestId: z.string().uuid(), projectId: identity.optional(), title: z.string().trim().min(1).max(120), voiceId: identity, text: z.string().trim().min(1).max(MAX_DUBBING_TEXT), sourceId: identity.nullable().default(null), parts: dubbingPartsSchema, ...dubbingSettingsShape }).strict().parse(input);
  validateDubbingScript(data.text, data.parts);
  return transaction(async () => {
    if (data.projectId) required(await get('projects', data.projectId), '项目不存在');
    const existing = await get('dubbings', requestId);
    if (existing) { const previous = { ...existing, ...resolveDubbingSettings(existing) }; if (existing.projectId !== data.projectId || Object.entries(data).some(([key, value]) => key === 'parts' ? JSON.stringify(dubbingPartsIdentity(existing.parts)) !== JSON.stringify(dubbingPartsIdentity(data.parts)) : previous[key as keyof StoredDubbing] !== value)) throw new ApiError('生成请求编号已被使用，请重新提交', 409); return publicDubbing(existing); }
    const voice = required(await get('voices', data.voiceId), '音色不存在');
    if (voice.deleteRequestedAt || voice.status !== 'ready' || !voice.providerVoiceId) throw new ApiError('请选择已创建完成的音色');
    assertScriptExpression(voice.model, resolveDubbingSettings(data), data.parts); voiceConfig(voice, configRequired());
    const source = await sourceRequired(data.sourceId);
    if (source?.projectId && source.projectId !== data.projectId) throw new ApiError('来源视频属于其他项目');
    return publicDubbing(await put('dubbings', { ...idle, ...data, id: requestId, voiceName: voice.name, status: 'queued', hasAudio: false, output: null, audioUrl: null, error: null, createdAt: now(), updatedAt: now() }));
  });
}
export async function retryVoice(key: string) {
  return transaction(async () => {
    const voice = required(await get('voices', key)); if (voice.status !== 'failed') return publicVoice(voice);
    if (voice.deleteRequestedAt) throw new ApiError('音色正在删除，请使用重试删除');
    voiceConfig(voice, configRequired());
    return publicVoice(await put('voices', { ...voice, ...idle, submissionStarted: !!voice.providerVoiceId, status: 'queued', error: null, updatedAt: now() }));
  });
}
export async function deleteVoice(key: string) {
  return transaction(async () => {
    const voice = await get('voices', key); if (!voice) return { deleted: true };
    if (voice.deleteRequestedAt && voice.status !== 'failed') return { deleted: false, voice: publicVoice(voice) };
    if (voice.status === 'processing') throw new ApiError('音色正在处理，请等待完成后再删除', 409);
    if ((await all('dubbings')).some(job => job.voiceId === key && ['queued', 'processing'].includes(job.status))) throw new ApiError('此音色正在生成配音，请等待配音完成后再删除', 409);
    if ((await all('narrations')).some(job => job.voiceId === key && (['queued', 'analyzing'].includes(job.status) || job.status === 'ready' && job.autoRenderPending)) || (await all('narration_renders')).some(job => job.voiceId === key && ['queued', 'processing'].includes(job.status))) throw new ApiError('此音色正在制作视频旁白，请等待任务完成后再删除', 409);
    if (voice.providerVoiceId && !voice.remoteDeletedAt) voiceConfig(voice, configRequired());
    if (!voice.providerVoiceId || voice.remoteDeletedAt) {
      // With no provider ID, no remote deletion can be submitted. Keep failed cleanup retryable.
      await unlink(join(uploadDir, voice.sample.storageKey)).catch(error => { if (error.code !== 'ENOENT') throw new ApiError('录音删除失败，请稍后重试'); });
      await remove('voices', key); return { deleted: true };
    }
    const queued = await put('voices', { ...voice, ...idle, deleteRequestedAt: voice.deleteRequestedAt || now(), status: 'queued', error: null, updatedAt: now() });
    return { deleted: false, voice: publicVoice(queued) };
  });
}
export async function retryDubbing(key: string) {
  return transaction(async () => {
    const job = required(await get('dubbings', key)); if (job.status !== 'failed') return publicDubbing(job);
    const voice = required(await get('voices', job.voiceId)); voiceConfig(voice, configRequired());
    if (voice.deleteRequestedAt || voice.status !== 'ready') throw new ApiError('请先选择可用的音色，已删除的音色无法重试配音'); await sourceRequired(job.sourceId);
    return publicDubbing(await put('dubbings', { ...job, ...idle, ...(job.clipResults ? { clipResults: job.clipResults.map(clip => ({ ...clip, submissionStarted: !!clip.audioUrl || !!clip.output })) } : {}), submissionStarted: !!job.audioUrl, status: 'queued', error: null, updatedAt: now() }));
  });
}
export async function retryDubbingSource(key: string) {
  if (!asrReady()) throw new ApiError('尚未配置文案提取服务');
  return transaction(async () => {
    const source = required(await get('dubbing_sources', key)); if (source.status !== 'failed') return publicSource(source);
    return publicSource(await put('dubbing_sources', { ...source, ...idle, submissionStarted: !!source.asrTaskId, failures: 0, status: 'queued', error: null, updatedAt: now() }));
  });
}
type WorkTable = 'voices' | 'dubbings' | 'dubbing_sources';
async function claim<T extends WorkTable>(table: T, leaseMs: number) {
  return transaction(async (): Promise<Records[T] | null> => {
    const candidate = (await all(table)).reverse().find(row => (['queued', 'waiting_configuration'].includes(row.status) || row.status === 'processing' && row.leaseUntil < Date.now()) && row.runAt <= Date.now());
    if (!candidate) return null;
    return put(table, { ...candidate, status: 'processing', leaseToken: id(), leaseUntil: Date.now() + leaseMs, updatedAt: now() });
  });
}
async function updateOwned<T extends WorkTable>(table: T, job: Records[T], patch: Partial<Records[T]>) {
  return transaction(async () => {
    const current = await get(table, job.id);
    if (!current || current.status !== 'processing' || current.leaseToken !== job.leaseToken) throw new ApiError('后台配音任务已更新', 409);
    return put(table, { ...current, ...patch, updatedAt: now() });
  });
}
const exec = promisify(execFile);
async function prepareSample(voice: StoredVoice, signal: AbortSignal) {
  const temp = join(uploadDir, id() + '.wav');
  try {
    await exec('ffmpeg', ['-v', 'error', '-y', '-i', join(uploadDir, voice.sample.storageKey), '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', temp], { timeout: 60000, signal });
    const data = await readFile(temp); if (data.length > 7 * 1024 * 1024) throw new ApiError('转换后的声音样本过大，请缩短录音'); return data;
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('声音样本无法处理，请检查录音文件'); }
  finally { await unlink(temp).catch(() => {}); }
}
async function processVoice(job: StoredVoice, config: TtsConfig, signal: AbortSignal) {
  if (job.deleteRequestedAt) {
    let current = job;
    if (current.providerVoiceId && !current.remoteDeletedAt) {
      await deleteRemoteVoice(voiceConfig(current, config), current.providerVoiceId, signal);
      current = await updateOwned('voices', current, { remoteDeletedAt: now() });
    }
    signal.throwIfAborted();
    await unlink(join(uploadDir, current.sample.storageKey)).catch(error => { if (error.code !== 'ENOENT') throw new ApiError('录音删除失败，请重试删除'); });
    await transaction(async () => {
      const owned = required(await get('voices', current.id));
      if (owned.leaseToken !== current.leaseToken || owned.status !== 'processing') throw new ApiError('音色删除任务已更新', 409);
      await remove('voices', current.id);
    });
    return;
  }
  if (job.submissionStarted && !job.providerVoiceId) throw new ApiError('上次音色创建结果未确认，已停止自动重提；点击重试会重新创建音色');
  let current = job;
  if (!current.providerVoiceId) {
    const audio = await prepareSample(current, signal);
    current = await updateOwned('voices', current, { submissionStarted: true, model: config.model, account: config.account, providerBaseUrl: config.baseUrl });
    const providerVoiceId = await createRemoteVoice(config, audio, signal); current = await updateOwned('voices', current, { providerVoiceId });
  }
  const status = await queryRemoteVoice(voiceConfig(current, config), current.providerVoiceId!, signal);
  await updateOwned('voices', current, { status: status === 'OK' ? 'ready' : 'queued', error: null, leaseToken: null, leaseUntil: 0, runAt: Date.now() + 3000 });
}
async function processSource(job: StoredDubbingSource, signal: AbortSignal) {
  const config = required(asrConfiguration() || undefined, '文案提取服务尚未配置');
  const configHash = fingerprint(config.baseUrl + config.model + config.key);
  if (job.asrTaskId && (job.asrConfig !== configHash || Date.now() - Date.parse(job.submittedAt || '') > 23 * 3600000)) throw new ApiError('原视频转写任务已过期或配置变化，请重新上传视频');
  if (job.submissionStarted && !job.asrTaskId) throw new ApiError('上次文案提取提交结果未确认，点击重试会重新提交识别');
  const segments = await transcribe(job.media, job.asrTaskId ? { taskId: job.asrTaskId } : undefined, async taskId => { await updateOwned('dubbing_sources', job, { asrTaskId: taskId }); }, { signal, beforeSubmit: async () => { await updateOwned('dubbing_sources', job, { submissionStarted: true, asrConfig: configHash, submittedAt: now() }); } });
  await updateOwned('dubbing_sources', job, { segments, status: 'completed', asrTaskId: null, error: null, leaseToken: null, leaseUntil: 0 });
}
async function processDubbing(job: StoredDubbing, config: TtsConfig, signal: AbortSignal) {
  const voice = required(await get('voices', job.voiceId), '音色不存在');
  if (voice.deleteRequestedAt || voice.status !== 'ready' || !voice.providerVoiceId) throw new ApiError('配音音色不可用');
  const bound = voiceConfig(voice, config); await sourceRequired(job.sourceId);
  if (job.parts) return processSegmentedDubbing(job, bound, voice.providerVoiceId, signal);
  if (job.submissionStarted && !job.audioUrl) throw new ApiError('上次配音提交结果未确认，已停止自动重提；点击重试可能再次产生合成费用');
  let current = job;
  if (!current.audioUrl) {
    current = await updateOwned('dubbings', current, { submissionStarted: true });
    const audioUrl = await synthesizeRemote(bound, voice.providerVoiceId, current.text, resolveDubbingSettings(current), signal); current = await updateOwned('dubbings', current, { audioUrl });
  }
  const audio = await downloadSpeech(bound, current.audioUrl!, signal);
  const output = await saveIndependentMedia(new File([new Uint8Array(audio)], `${current.title}.mp3`, { type: 'audio/mpeg' })); let retained = false;
  try {
    if (!output.hasAudio || !output.duration) throw new ApiError('语音服务未生成有效音频');
    signal.throwIfAborted();
    await updateOwned('dubbings', current, { status: 'completed', hasAudio: true, output, audioUrl: null, leaseToken: null, leaseUntil: 0, error: null }); retained = true;
  } finally { if (!retained) await unlink(join(uploadDir, output.storageKey)).catch(() => {}); }
}
async function processSegmentedDubbing(job: StoredDubbing, config: TtsConfig, voiceId: string, signal: AbortSignal) {
  const plan = speechPlan(job.parts!, resolveDubbingSettings(job));
  assertScriptExpression(config.model, resolveDubbingSettings(job), job.parts);
  let current = job;
  const clips = current.clipResults ? [...current.clipResults] : plan.map(part => ({ key: speechClipKey(config, voiceId, part), submissionStarted: false, audioUrl: null, output: null }));
  async function saveClip(index: number, patch: Partial<StoredClip>) {
    clips[index] = { ...clips[index], ...patch };
    current = await updateOwned('dubbings', current, { clipResults: [...clips] });
  }
  const audioParts: { audio: Buffer; pauseAfterMs: number }[] = [];
  for (let index = 0; index < plan.length; index++) {
    signal.throwIfAborted();
    if (!clips[index] || clips[index].key !== speechClipKey(config, voiceId, plan[index])) throw new ApiError('分段任务设置不一致，请重新生成配音');
    const clip = clips[index];
    if (clip.submissionStarted && !clip.audioUrl && !clip.output) throw new ApiError(`第 ${index + 1} 句上次配音提交结果未确认，已停止自动重提；点击重试可能再次产生合成费用`);
    let audio: Buffer;
    if (clip.output) {
      try { audio = await readFile(join(uploadDir, clip.output.storageKey)); }
      catch { throw new ApiError(`第 ${index + 1} 句已生成的文件缺失，请重新制作配音`); }
    } else {
      try {
        audio = await speechClip(config, voiceId, plan[index], { signal, audioUrl: clip.audioUrl, beforeSubmit: () => saveClip(index, { submissionStarted: true }), submitted: audioUrl => saveClip(index, { audioUrl }) });
      } catch (error) {
        if (error instanceof TtsError && error.expiredAudio) await saveClip(index, { audioUrl: null });
        throw error;
      }
      const output = await saveIndependentMedia(new File([new Uint8Array(audio)], `第${index + 1}句.mp3`, { type: 'audio/mpeg' }));
      try {
        if (!output.hasAudio || !output.duration) throw new ApiError(`第 ${index + 1} 句没有有效音频`);
        await saveClip(index, { output, audioUrl: null });
      } catch (error) { await unlink(join(uploadDir, output.storageKey)).catch(() => {}); throw error; }
    }
    audioParts.push({ audio, pauseAfterMs: plan[index].pauseAfterMs });
  }
  const audio = await assembleDubbingAudio(audioParts, signal);
  const output = await saveIndependentMedia(new File([new Uint8Array(audio)], `${job.title}.mp3`, { type: 'audio/mpeg' }));
  let retained = false;
  try {
    if (!output.duration || !output.hasAudio) throw new ApiError('分段配音没有有效音频');
    signal.throwIfAborted();
    await updateOwned('dubbings', current, { status: 'completed', hasAudio: true, output, clipResults: [], leaseToken: null, leaseUntil: 0, error: null }); retained = true;
  } finally { if (!retained) await unlink(join(uploadDir, output.storageKey)).catch(() => {}); }
  await Promise.all(clips.map(clip => clip.output ? unlink(join(uploadDir, clip.output.storageKey)).catch(() => {}) : undefined));
}
export async function processNextDubbing(options: { leaseMs?: number; signal?: AbortSignal } = {}) {
  const config = ttsReady() ? ttsConfiguration() : null, leaseMs = options.leaseMs ?? 30000;
  const voice = config ? await claim('voices', leaseMs) : null;
  const source = !voice && asrReady() ? await claim('dubbing_sources', leaseMs) : null;
  const table: WorkTable = voice ? 'voices' : source ? 'dubbing_sources' : 'dubbings';
  const job = voice || source || (config ? await claim('dubbings', leaseMs) : null); if (!job) return false;
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
  const heartbeat = setInterval(() => { void updateOwned(table, job, { leaseUntil: Date.now() + leaseMs }).catch(() => controller.abort()); }, 5000); heartbeat.unref();
  try {
    signal.throwIfAborted();
    if (voice) await processVoice(voice, config!, signal); else if (source) await processSource(source, signal); else await processDubbing(job as StoredDubbing, config!, signal);
  } catch (error) {
    const current = await get(table, job.id);
    const retryAsr = table === 'dubbing_sources' && error instanceof AsrError && !error.terminal && !!(current as StoredDubbingSource)?.asrTaskId && (error.pending || (current as StoredDubbingSource).failures < 3);
    const message = error instanceof ApiError || error instanceof TtsError || error instanceof AsrError ? error.message : '配音任务处理失败，请稍后重试';
    await updateOwned(table, job, { status: signal.aborted || retryAsr ? 'queued' : 'failed', error: signal.aborted || retryAsr ? null : message, runAt: Date.now() + (retryAsr ? 3000 : 0), leaseToken: null, leaseUntil: 0, ...(retryAsr ? { failures: (current as StoredDubbingSource).failures + (error instanceof AsrError && error.pending ? 0 : 1) } : {}), ...(table === 'dubbings' && error instanceof TtsError && error.expiredAudio ? { audioUrl: null } : {}) }).catch(() => {});
  } finally { clearInterval(heartbeat); }
  return true;
}
