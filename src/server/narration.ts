import { createHash, randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { all, get, now, put, transaction, type Records } from './db';
import { ApiError, required } from './errors';
import { hasCommand, inspect, maxUploadBytes, saveUpload, uploadDir } from './media';
import { publicVoice, readyDubbingVoice } from './dubbing';
import { narrationShotsSchema, narrationSegmentsSchema, validateNarrationShots, validateNarrationSegments } from './narration-schema';
import { analyzeNarration, visionConfiguration, visionReady, type NarrationFrame } from './narration-vision';
import { composeNarrationVideo, extractNarrationFrames, prepareNarrationAudio, saveNarrationMedia } from './narration-media';
import { assertNarrationDuration, planNarration } from './narration-timing';
import { speechClip, speechClipKey } from './speech-clips';
import { TtsError, ttsReady } from './tts';
import { cachedNarrationTranslations, translateNarration, translationKey, translationReady, type NarrationTranslationCache } from './narration-translation';
import { currentNarrationTranslation } from '../shared/narration-captions';
import { assertDubbingExpression } from './dubbing-settings';
import { resolveDubbingSettings, supportsDubbingExpression } from '../shared/dubbing-settings';
import { MAX_NARRATION_SECONDS, narrationIdentity, narrationSegments, narrationSegmentIdentity, type NarrationSegment, type NarrationProject, type NarrationRender, type NarrationSnapshot } from '../shared/narration';
import type { DubbingMedia } from '../shared/types';

interface Lease { leaseToken: string | null; leaseUntil: number }
export interface StoredNarration extends Omit<NarrationProject, 'segments' | 'subtitleMode'>, Lease {
  segments?: NarrationSegment[]; subtitleMode?: NarrationProject['subtitleMode']; translationCache?: NarrationTranslationCache;
  media: DubbingMedia; thumbnailKey: string | null; fileHash: string; frames: NarrationFrame[];
  analysisSubmitted: boolean; analysisConfig: string | null;
}
interface RenderClip { key: string; submissionStarted: boolean; audioUrl: string | null; output: DubbingMedia | null }
export interface StoredNarrationRender extends Omit<NarrationRender, 'segments' | 'alignedSegments' | 'subtitleMode' | 'burnedCaptions' | 'hasCleanVideo' | 'language'>, Lease { segments?: NarrationSegment[]; alignedSegments?: NarrationSegment[] | null; subtitleMode?: NarrationRender['subtitleMode']; burnedCaptions?: boolean; language?: 'zh' | 'en'; translationSubmitted?: boolean; translationConfig?: string; cleanOutput?: DubbingMedia | null; clips: (RenderClip | null)[]; output: DubbingMedia | null }
type WorkTable = 'narrations' | 'narration_renders';
const idle: Lease = { leaseToken: null, leaseUntil: 0 };
function publicProject(p: StoredNarration): NarrationProject {
  const { id, title, name, duration, hasOriginalAudio, voiceId, language, style, revision, status, stage, summary, shots, error, autoRenderPending, createdAt, updatedAt } = p;
  return { id, title, name, duration, hasOriginalAudio, voiceId, language, style, revision, subtitleMode: p.subtitleMode ?? 'original', status, stage, summary, shots, segments: cachedNarrationTranslations(narrationSegments(p), p.language, p.translationCache), error, autoRenderPending, createdAt, updatedAt };
}
function publicRender(r: StoredNarrationRender): NarrationRender {
  const { id, projectId, revision, title, voiceId, voiceName, shots, originalVolume, status, completedShots, stage, error, hasVideo, createdAt, updatedAt } = r;
  return { id, projectId, revision, title, voiceId, voiceName, shots, segments: narrationSegments(r), alignedSegments: r.alignedSegments ?? null, originalVolume, subtitleMode: r.subtitleMode ?? 'original', burnedCaptions: !!r.burnedCaptions, hasCleanVideo: !!r.cleanOutput, language: r.language ?? 'zh', status, completedShots, stage, error, hasVideo, createdAt, updatedAt };
}
export async function narrationSnapshot(): Promise<NarrationSnapshot> {
  const [projects, renders, voices, ffmpeg, ffprobe] = await Promise.all([all('narrations'), all('narration_renders'), all('voices'), hasCommand('ffmpeg'), hasCommand('ffprobe')]);
  return { projects: projects.map(publicProject), renders: renders.map(publicRender), voices: voices.map(publicVoice), capabilities: { vision: visionReady(), tts: ttsReady(), translation: translationReady(), media: ffmpeg && ffprobe, authRequired: !!process.env.HUB_ACCESS_TOKEN, maxUploadMB: maxUploadBytes() / 1024 / 1024, maxSeconds: MAX_NARRATION_SECONDS } };
}
export async function uploadNarration(form: FormData) {
  const data = z.object({ requestId: z.string().uuid(), voiceId: z.string().uuid(), language: z.enum(['zh', 'en']).default('zh'), style: z.enum(['natural', 'documentary', 'warm', 'lively']).default('natural'), subtitleMode: z.enum(['original', 'bilingual']).default('original') }).parse(Object.fromEntries(['requestId', 'voiceId', 'language', 'style', 'subtitleMode'].flatMap(k => form.get(k) === null ? [] : [[k, form.get(k)]])));
  if (!visionReady()) throw new ApiError('请先配置云端视频理解服务');
  await readyDubbingVoice(data.voiceId);
  const file = form.get('file');
  if (!(file instanceof File) || !file.size || file.size > maxUploadBytes() || !/\.(mp4|mov|webm)$/i.test(file.name)) throw new ApiError(`请选择不超过 ${maxUploadBytes() / 1024 / 1024} MB 的 MP4、MOV 或 WebM 视频`);
  const fileHash = createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex');
  const duplicate = (p: StoredNarration) => { if (p.fileHash !== fileHash || p.voiceId !== data.voiceId || p.language !== data.language || p.style !== data.style || (p.subtitleMode ?? 'original') !== data.subtitleMode) throw new ApiError('上传编号已使用，请重新提交', 409); return publicProject(p); };
  const previous = await get('narrations', data.requestId); if (previous) return duplicate(previous);
  if (!await hasCommand('ffmpeg') || !await hasCommand('ffprobe')) throw new ApiError('视频处理服务暂不可用');
  const media = await saveUpload(file, '', [], 'authorized', '', ''); let retained = false;
  try {
    const info = await inspect(join(uploadDir, media.storageKey));
    if (media.kind !== 'video' || !info.video || !media.duration || media.duration < 2 || media.duration > MAX_NARRATION_SECONDS) throw new ApiError(`请选择 2 秒至 ${MAX_NARRATION_SECONDS / 60} 分钟的有效视频`);
    const result = await transaction(async () => {
      const existing = await get('narrations', data.requestId); if (existing) return duplicate(existing);
      await readyDubbingVoice(data.voiceId);
      const { id, name, kind, mime, size, storageKey, duration, hasAudio } = media;
      const stored = await put('narrations', { ...idle, id: data.requestId, title: file.name.replace(/\.[^.]+$/, '').slice(0, 120), name: file.name.slice(0, 180), duration: duration!, hasOriginalAudio: !!hasAudio,
        voiceId: data.voiceId, language: data.language, style: data.style, subtitleMode: data.subtitleMode, revision: 0, status: 'queued', stage: '等待分析画面', summary: '', shots: [], error: null,
        media: { id, name, kind: kind as 'video', mime, size, storageKey, duration, hasAudio }, thumbnailKey: media.thumbnailKey, fileHash, frames: [], analysisSubmitted: false, analysisConfig: null, autoRenderPending: true, createdAt: now(), updatedAt: now() });
      retained = true; return publicProject(stored);
    });
    return result;
  } finally { if (!retained) await Promise.all([media.storageKey, media.thumbnailKey].filter(Boolean).map(k => unlink(join(uploadDir, k!)).catch(() => {}))); }
}
export async function saveNarration(key: string, input: unknown) {
  const data = z.object({ revision: z.number().int().positive(), title: z.string().trim().min(1).max(120), shots: narrationShotsSchema.optional(), segments: narrationSegmentsSchema.optional() }).strict().refine(d => !!d.shots || !!d.segments, '请提供旁白段落').parse(input);
  return transaction(async () => {
    const p = required(await get('narrations', key), '视频不存在');
    if (p.status !== 'ready') throw new ApiError('请等待画面分析完成');
    if (data.shots) validateNarrationShots(data.shots, p.shots);
    const segments = (data.segments ?? narrationSegments({ shots: data.shots! })).map(s => ({ ...s, text: s.text.trim() }));
    validateNarrationSegments(segments, p.duration);
    const unchanged = p.title === data.title && JSON.stringify(narrationSegmentIdentity(publicProject(p).segments)) === JSON.stringify(narrationSegmentIdentity(segments)) && (!data.shots || JSON.stringify(narrationIdentity(p.shots)) === JSON.stringify(narrationIdentity(data.shots)));
    if (unchanged) return publicProject(p);
    if (p.revision !== data.revision) throw new ApiError('分镜已被其他页面修改，请刷新后再编辑', 409);
    return publicProject(await put('narrations', { ...p, title: data.title, shots: data.shots ?? p.shots, segments, revision: p.revision + 1, error: null, updatedAt: now() }));
  });
}
const renderSchema = z.object({ requestId: z.string().uuid(), revision: z.number().int().positive(), voiceId: z.string().uuid(), originalVolume: z.number().finite().min(0).max(1).default(0), subtitleMode: z.enum(['original', 'bilingual']).default('original') }).strict();
export async function enqueueNarrationRender(projectId: string, input: unknown) {
  const data = renderSchema.parse(input);
  return transaction(async () => {
    const existing = await get('narration_renders', data.requestId);
    if (existing) {
      if (existing.projectId !== projectId || existing.revision !== data.revision || existing.voiceId !== data.voiceId || existing.originalVolume !== data.originalVolume || (existing.subtitleMode ?? 'original') !== data.subtitleMode) throw new ApiError('成片请求编号已使用，请重新提交', 409);
      return publicRender(existing);
    }
    const p = required(await get('narrations', projectId), '视频不存在');
    if (p.status !== 'ready' || p.revision !== data.revision) throw new ApiError('分镜版本已更新，请保存并刷新后生成', 409);
    const segments = publicProject(p).segments; validateNarrationSegments(segments, p.duration);
    if (data.subtitleMode === 'bilingual' && segments.some(s => s.text.trim() && !currentNarrationTranslation(s, p.language)) && !translationReady()) throw new ApiError('请配置 AI 服务以自动翻译字幕，或先填写每句译文');
    const { voice } = await readyDubbingVoice(data.voiceId);
    segments.filter(s => s.text.trim()).forEach(s => assertDubbingExpression(voice.model, s.settings));
    return publicRender(await put('narration_renders', { ...idle, id: data.requestId, projectId, revision: p.revision, title: p.title, voiceId: voice.id, voiceName: voice.name, shots: p.shots, segments, alignedSegments: null, originalVolume: data.originalVolume, subtitleMode: data.subtitleMode, language: p.language, burnedCaptions: false, cleanOutput: null,
      status: 'queued', completedShots: 0, stage: '等待生成旁白', error: null, hasVideo: false, clips: [], output: null, createdAt: now(), updatedAt: now() }));
  });
}
export async function retryNarration(key: string) {
  return transaction(async () => {
    const p = required(await get('narrations', key), '视频不存在'); if (p.status !== 'failed') return publicProject(p);
    if (!visionReady()) throw new ApiError('请先配置云端视频理解服务');
    await readyDubbingVoice(p.voiceId);
    return publicProject(await put('narrations', { ...p, ...idle, status: 'queued', stage: '等待重新分析', analysisSubmitted: false, error: null, updatedAt: now() }));
  });
}
export async function retryNarrationRender(key: string) {
  return transaction(async () => {
    const r = required(await get('narration_renders', key), '成片任务不存在'); if (r.status !== 'failed') return publicRender(r);
    await readyDubbingVoice(r.voiceId);
    return publicRender(await put('narration_renders', { ...r, ...idle, status: 'queued', stage: '等待继续生成', error: null, translationSubmitted: false, clips: r.clips.map(c => c ? { ...c, submissionStarted: !!c.audioUrl || !!c.output } : null), updatedAt: now() }));
  });
}
export async function narrationFile(key: string, source: boolean, frameId?: string, clean = false) {
  if (source || frameId) {
    const p = required(await get('narrations', key), '视频不存在');
    if (source) return p.media;
    const f = required(p.frames.find(f => f.shotId === frameId), '分镜画面不存在');
    return { storageKey: f.storageKey, name: '分镜.jpg', kind: 'image', mime: 'image/jpeg' };
  }
  const render = required(await get('narration_renders', key), '成片不存在');
  return required((clean ? render.cleanOutput : render.output) || undefined, clean ? '此旧版本未保留无字幕成片，请重新生成' : '视频尚未生成');
}
async function claim<T extends WorkTable>(table: T, leaseMs: number): Promise<Records[T] | null> {
  return transaction(async () => {
    const job = (await all(table)).reverse().find(j => j.status === 'queued' || ['analyzing', 'processing'].includes(j.status) && j.leaseUntil < Date.now());
    if (!job) return null;
    return put(table, { ...job, status: table === 'narrations' ? 'analyzing' : 'processing', leaseToken: randomUUID(), leaseUntil: Date.now() + leaseMs, updatedAt: now() } as Records[T]);
  });
}
async function updateOwned<T extends WorkTable>(table: T, job: Records[T], patch: Partial<Records[T]>) {
  return transaction(async () => {
    const current = required(await get(table, job.id));
    if (current.leaseToken !== job.leaseToken) throw new ApiError('任务已由其他进程接管', 409);
    return put(table, { ...current, ...patch, updatedAt: now() });
  });
}
async function analyzeProject(job: StoredNarration, signal: AbortSignal) {
  if (job.analysisSubmitted) throw new ApiError('上次画面分析结果未确认，已停止自动重提；点击重试分析会重新使用服务额度');
  const config = visionConfiguration(); if (!config) throw new ApiError('视频理解服务未配置');
  let current = job;
  if (!current.frames.length) {
    await updateOwned('narrations', job, { stage: '识别镜头并提取画面' });
    const extracted = await extractNarrationFrames(job.media, signal);
    try { current = await updateOwned('narrations', job, extracted); }
    catch (error) { await Promise.all(extracted.frames.map(f => unlink(join(uploadDir, f.storageKey)).catch(() => {}))); throw error; }
  }
  const frames = await Promise.all(current.frames.map(async f => ({ ...f, data: await readFile(join(uploadDir, f.storageKey)) })));
  signal.throwIfAborted();
  current = await updateOwned('narrations', current, { analysisSubmitted: true, analysisConfig: config.fingerprint, stage: '理解画面并编写连贯旁白' });
  const result = await analyzeNarration(current.shots, frames, current.language, current.style, config, signal);
  const voice = await get('voices', current.voiceId);
  if (voice && !supportsDubbingExpression(voice.model)) result.segments = result.segments.map(s => ({ ...s, settings: { ...s.settings, tone: 'natural', emotion: 'neutral' } }));
  await updateOwned('narrations', current, { ...result, status: 'ready', revision: 1, stage: '画面与旁白已生成', error: null, ...idle });
}
async function autoRender() {
  return transaction(async () => {
    const p = (await all('narrations')).reverse().find(p => p.status === 'ready' && p.autoRenderPending);
    if (!p) return false;
    try { await enqueueNarrationRender(p.id, { requestId: p.id, revision: p.revision, voiceId: p.voiceId, originalVolume: 0, subtitleMode: p.subtitleMode ?? 'original' }); await put('narrations', { ...p, autoRenderPending: false, updatedAt: now() }); }
    catch (error) { await put('narrations', { ...p, autoRenderPending: false, error: error instanceof ApiError ? error.message : '自动配音未开始，请选择音色后生成成片', updatedAt: now() }); }
    return true;
  });
}
async function renderProject(job: StoredNarrationRender, signal: AbortSignal) {
  const p = required(await get('narrations', job.projectId), '来源视频不存在');
  const { voice, config } = await readyDubbingVoice(job.voiceId);
  const previous = (await all('narration_renders')).filter(r => r.projectId === p.id && r.id !== job.id);
  let segments = cachedNarrationTranslations(narrationSegments(job), p.language, p.translationCache);
  let current = job, totalDuration = 0;
  if (job.subtitleMode === 'bilingual' && segments.some(s => s.text.trim() && !currentNarrationTranslation(s, p.language))) {
    if (job.translationSubmitted) throw new ApiError('上次字幕翻译结果未确认，已停止自动重提；点击继续生成可能再次使用翻译额度');
    segments = await translateNarration(segments, p.language, signal, async translationConfig => { current = await updateOwned('narration_renders', current, { translationSubmitted: true, translationConfig, stage: '自动翻译双语字幕' }); });
  }
  if (job.subtitleMode === 'bilingual') {
    current = await updateOwned('narration_renders', current, { segments });
    await transaction(async () => {
      const project = required(await get('narrations', p.id));
      const entries = segments.filter(s => currentNarrationTranslation(s, p.language)).map(s => [translationKey(s.text, p.language), s.translation!] as const);
      const cache = Object.fromEntries([...Object.entries(project.translationCache ?? {}).filter(([key]) => !entries.some(([next]) => next === key)), ...entries].slice(-180));
      await put('narrations', { ...project, translationCache: cache });
    });
  }
  const durations: (number | null)[] = [];
  const clips: (RenderClip | null)[] = job.clips.length ? [...job.clips] : segments.map(s => {
    if (!s.text) return null;
    const key = speechClipKey(config, voice.providerVoiceId!, { text: s.text, settings: resolveDubbingSettings(s.settings), pauseAfterMs: 0 });
    const saved = previous.flatMap(r => r.clips).find(c => c?.key === key && c.output);
    return saved ? { ...saved } : { key, submissionStarted: false, audioUrl: null, output: null };
  });
  async function saveClip(index: number, patch: Partial<RenderClip>) { clips[index] = { ...clips[index]!, ...patch }; current = await updateOwned('narration_renders', current, { clips: [...clips] }); }
  const audio: (Buffer | null)[] = [];
  for (let i = 0; i < segments.length; i++) {
    signal.throwIfAborted();
    const shot = segments[i], part = { text: shot.text, settings: resolveDubbingSettings(shot.settings), pauseAfterMs: 0 }, clip = clips[i];
    await updateOwned('narration_renders', current, { stage: `制作第 ${i + 1} / ${segments.length} 段旁白`, completedShots: i });
    if (!shot.text) { audio.push(null); durations.push(null); continue; }
    if (!clip || clip.key !== speechClipKey(config, voice.providerVoiceId!, part)) throw new ApiError('分镜合成设置不一致，请重新创建成片');
    let buffer: Buffer | undefined;
    if (clip.output) {
      try { buffer = await readFile(join(uploadDir, clip.output.storageKey)); }
      catch { await saveClip(i, { output: null, submissionStarted: false }); }
    }
    if (!buffer) {
      if (clips[i]!.submissionStarted && !clips[i]!.audioUrl) throw new ApiError(`第 ${i + 1} 段上次配音结果未确认，已停止自动重提；点击重试可能再次使用语音额度`);
      try { buffer = await speechClip(config, voice.providerVoiceId!, part, { signal, audioUrl: clips[i]!.audioUrl, beforeSubmit: () => saveClip(i, { submissionStarted: true }), submitted: audioUrl => saveClip(i, { audioUrl }) }); }
      catch (error) { if (error instanceof TtsError && error.expiredAudio) await saveClip(i, { audioUrl: null }); throw error; }
      const output = await saveNarrationMedia(buffer, `旁白${i + 1}.mp3`, 'audio');
      try { await saveClip(i, { output, audioUrl: null }); } catch (error) { await unlink(join(uploadDir, output.storageKey)).catch(() => {}); throw error; }
    }
    const prepared = await prepareNarrationAudio(buffer, signal), duration = prepared.duration;
    audio.push(prepared.pcm);
    durations.push(duration); totalDuration += duration;
    assertNarrationDuration(totalDuration, p.duration);
  }
  const plan = planNarration(segments, durations, p.duration);
  await updateOwned('narration_renders', current, { completedShots: segments.length, alignedSegments: plan.alignedSegments, stage: '安排旁白时间并导出视频' });
  const result = await composeNarrationVideo(p.media, plan.alignedSegments, audio.filter((a): a is Buffer => !!a), plan.speed, job.originalVolume, p.language, signal, job.subtitleMode ?? 'original');
  const output = await saveNarrationMedia(result.video, `${job.title}.mp4`, 'video');
  let cleanOutput: DubbingMedia | null = null;
  try {
    if (result.cleanVideo) cleanOutput = await saveNarrationMedia(result.cleanVideo, `${job.title}-无字幕.mp4`, 'video');
    signal.throwIfAborted(); await updateOwned('narration_renders', current, { status: 'completed', hasVideo: true, output, cleanOutput, burnedCaptions: job.subtitleMode === 'bilingual', stage: '成片已完成', error: null, ...idle });
  } catch (error) { await Promise.all([output, cleanOutput].filter(Boolean).map(m => unlink(join(uploadDir, m!.storageKey)).catch(() => {}))); throw error; }
}
export async function processNextNarration(options: { signal?: AbortSignal; leaseMs?: number } = {}) {
  if (await autoRender()) return true;
  const leaseMs = options.leaseMs ?? 30000;
  const analysis = visionReady() ? await claim('narrations', leaseMs) : null;
  const render = !analysis && ttsReady() ? await claim('narration_renders', leaseMs) : null;
  if (!analysis && !render) return false;
  const table = analysis ? 'narrations' : 'narration_renders', job = (analysis || render)!;
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
  const heartbeat = setInterval(() => { void updateOwned(table, job, { leaseUntil: Date.now() + leaseMs }).catch(() => controller.abort()); }, 5000); heartbeat.unref();
  try { signal.throwIfAborted(); if (analysis) await analyzeProject(analysis, signal); else await renderProject(render!, signal); }
  catch (error) {
    await updateOwned(table, job, { status: signal.aborted ? 'queued' : 'failed', error: signal.aborted ? null : error instanceof ApiError || error instanceof TtsError ? error.message : '视频旁白处理失败，请重试', stage: signal.aborted ? '等待继续处理' : '处理未完成', ...idle }).catch(() => {});
  } finally { clearInterval(heartbeat); }
  return true;
}
