import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { all, get, put, transaction, dataDir, id, now } from './db';
import { ApiError, required } from './errors';
import { douyinText, douyinStages, type DouyinExtraction, type DouyinSnapshot } from '../shared/douyin';

const exec = promisify(execFile);
export interface StoredDouyinExtraction extends DouyinExtraction { leaseToken: string | null; leaseUntil: number }
const publicJob = ({ leaseToken: _token, leaseUntil: _until, ...job }: StoredDouyinExtraction): DouyinExtraction => job;
const inputSchema = z.object({ requestId: z.string().uuid(), projectId: z.string().trim().min(1).max(200).optional(), shareText: z.string().trim().min(1).max(3000), position: z.enum(['bottom', 'middle', 'full']).default('bottom') }).strict();
const directory = join(dataDir, 'douyin');

export function douyinShareUrl(text: string) {
  const raw = text.match(/https:\/\/[^\s<>"']+/)?.[0]?.replace(/[，。；）)]+$/, '');
  let url: URL; try { url = new URL(raw || ''); } catch { throw new ApiError('请粘贴抖音分享链接或完整分享文字'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['v.douyin.com', 'www.douyin.com', 'm.douyin.com', 'www.iesdouyin.com', 'iesdouyin.com'].includes(url.hostname) || !/^\/(?:[A-Za-z0-9_-]+\/?|(?:share\/)?video\/\d+\/?|note\/\d+\/?)$/.test(url.pathname)) throw new ApiError('请使用有效的抖音移动端视频分享链接');
  return url.href;
}
let capabilityCache: { until: number; available: boolean } | undefined;
export async function douyinAvailable() {
  if (capabilityCache && capabilityCache.until > Date.now()) return capabilityCache.available;
  const checks = await Promise.allSettled([
    ...['python3', 'curl', 'ffmpeg', 'ffprobe'].map(command => exec(command, [command.startsWith('ff') ? '-version' : '--version'], { timeout: 5000, maxBuffer: 200000 })),
    process.platform === 'darwin' ? exec('swiftc', ['--version'], { timeout: 5000 }) : exec('python3', ['-c', 'import rapidocr, onnxruntime'], { timeout: 15000 }),
  ]);
  const available = checks.every(result => result.status === 'fulfilled');
  capabilityCache = { until: Date.now() + 30000, available }; return available;
}
export async function douyinSnapshot(projectId?: string): Promise<DouyinSnapshot> {
  return { jobs: (await all('douyin_extractions')).filter(job => !projectId || !job.projectId || job.projectId === projectId).map(publicJob), available: await douyinAvailable() };
}
export async function enqueueDouyin(input: unknown) {
  const data = inputSchema.parse(input), sourceUrl = douyinShareUrl(data.shareText);
  if (data.projectId) required(await get('projects', data.projectId), '项目不存在');
  const existing = await get('douyin_extractions', data.requestId);
  if (existing) { if (existing.sourceUrl !== sourceUrl || existing.position !== data.position || existing.projectId !== data.projectId) throw new ApiError('请求编号已被使用，请重新提交', 409); return publicJob(existing); }
  if (!await douyinAvailable()) throw new ApiError('文案提取服务暂不可用，请联系管理员', 503);
  return transaction(async () => {
    const duplicate = await get('douyin_extractions', data.requestId);
    if (duplicate) { if (duplicate.sourceUrl !== sourceUrl || duplicate.position !== data.position || duplicate.projectId !== data.projectId) throw new ApiError('请求编号已被使用', 409); return publicJob(duplicate); }
    if ((await all('douyin_extractions')).filter(job => job.status === 'queued' || job.status === 'processing').length >= 10) throw new ApiError('已有较多提取任务，请等当前任务完成后再试', 429);
    return publicJob(await put('douyin_extractions', { id: data.requestId, projectId: data.projectId, sourceUrl, position: data.position, status: 'queued', stage: 'queued', title: '抖音视频', videoId: null, duration: null, text: '', cues: [], reviewStatus: 'unreviewed', error: null, timings: {}, createdAt: now(), updatedAt: now(), revision: 1, leaseToken: null, leaseUntil: 0 }));
  });
}
export async function retryDouyin(key: string) {
  if (!await douyinAvailable()) throw new ApiError('文案提取服务暂不可用', 503);
  return transaction(async () => { const job = required(await get('douyin_extractions', key), '提取记录不存在'); if (job.status !== 'failed') return publicJob(job); return publicJob(await put('douyin_extractions', { ...job, status: 'queued', stage: 'queued', error: null, leaseToken: null, leaseUntil: 0, updatedAt: now() })); });
}
export async function saveDouyin(key: string, input: unknown) {
  const data = z.object({ revision: z.number().int().positive(), texts: z.array(z.string().trim().min(1).max(2000).refine(text => !/\r?\n\s*\r?\n/.test(text), '单条字幕不能包含空行')).min(1).max(5000) }).strict().parse(input);
  return transaction(async () => {
    const job = required(await get('douyin_extractions', key), '提取记录不存在');
    if (job.status !== 'completed') throw new ApiError('请等待文案提取完成', 409);
    if (job.revision !== data.revision) throw new ApiError('此文案已在其他页面更新，请刷新后再保存', 409);
    if (data.texts.length !== job.cues.length) throw new ApiError('请保留字幕条数，逐句校对文字');
    const cues = job.cues.map((cue, index) => ({ ...cue, text: data.texts[index] }));
    if (douyinText(cues).length > 100000) throw new ApiError('文案过长');
    return publicJob(await put('douyin_extractions', { ...job, cues, text: douyinText(cues), reviewStatus: 'reviewed', revision: job.revision + 1, updatedAt: now() }));
  });
}
async function updateOwned(job: StoredDouyinExtraction, patch: Partial<StoredDouyinExtraction>) {
  return transaction(async () => { const current = required(await get('douyin_extractions', job.id)); if (current.leaseToken !== job.leaseToken) throw new ApiError('提取任务已转交其他进程', 409); return put('douyin_extractions', { ...current, ...patch, updatedAt: now() }); });
}
const resultSchema = z.object({ status: z.literal('completed'), title: z.string().max(3000), videoId: z.string().regex(/^\d+$/), duration: z.number().positive().max(300), timings: z.record(z.number().nonnegative()), cues: z.array(z.object({ id: z.number().int().positive(), start: z.number().nonnegative(), end: z.number().positive(), text: z.string().min(1).max(2000) })).min(1).max(5000) });
export async function processNextDouyin(options: { signal?: AbortSignal } = {}) {
  const job = await transaction(async () => { const next = (await all('douyin_extractions')).reverse().find(job => job.status === 'queued' || job.status === 'processing' && job.leaseUntil < Date.now()); return next ? put('douyin_extractions', { ...next, status: 'processing', stage: 'resolving', leaseToken: id(), leaseUntil: Date.now() + 120000, error: null, updatedAt: now() }) : null; });
  if (!job) return false;
  const runDir = join(directory, job.id, job.leaseToken!);
  await mkdir(runDir, { recursive: true });
  let owned = Promise.resolve();
  const heartbeat = setInterval(() => { owned = owned.then(async () => { await updateOwned(job, { leaseUntil: Date.now() + 120000 }); }).catch(() => {}); }, 15000);
  try {
    options.signal?.throwIfAborted();
    const script = resolve('scripts/douyin-subtitles/extract.py');
    await new Promise<void>((resolveDone, reject) => {
      const roi = { bottom: '0,0.65,1,0.32', middle: '0,0.3,1,0.4', full: '0,0,1,1' }[job.position];
      const child = spawn('python3', [script, job.sourceUrl, '--output', runDir, '--max-duration', '300', '--max-mb', '128', '--roi', roi], { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      let reported = '', stderr = '';
      const stop = () => { if (child.pid) { try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch {} } };
      const timeout = setTimeout(stop, 15 * 60 * 1000);
      options.signal?.addEventListener('abort', stop, { once: true });
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => { try { const event = JSON.parse(line); if (event.stage === 'failed') reported = String(event.error || '提取失败'); if (douyinStages[event.stage] && event.stage !== 'completed' && event.stage !== 'failed') owned = owned.then(async () => { await updateOwned(job, { stage: event.stage }); }).catch(() => {}); } catch {} });
      child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-2000); });
      const finish = () => { clearTimeout(timeout); options.signal?.removeEventListener('abort', stop); lines.close(); };
      child.once('error', error => { finish(); reject(error); });
      child.once('close', code => { finish(); if (code === 0) resolveDone(); else reject(new Error(reported || stderr || '提取任务中断或超时，请重试')); });
      if (options.signal?.aborted) stop();
    });
    await owned;
    const batch = z.array(z.object({ status: z.literal('completed'), result: z.string() })).length(1).parse(JSON.parse(await readFile(join(runDir, 'batch.json'), 'utf8')));
    const result = resultSchema.parse(JSON.parse(await readFile(batch[0].result, 'utf8')));
    if (result.cues.some((cue, i) => cue.end <= cue.start || cue.end > result.duration + .01 || i > 0 && cue.start < result.cues[i - 1].end)) throw new Error('识别结果时间轴无效');
    await updateOwned(job, { status: 'completed', stage: 'completed', title: result.title, videoId: result.videoId, duration: result.duration, cues: result.cues, text: douyinText(result.cues), timings: result.timings, leaseToken: null, leaseUntil: 0, error: null });
  } catch (error) {
    await owned;
    const message = error instanceof Error ? error.message : '文案提取失败';
    // Never expose command output, signed media URLs, local paths or provider bodies.
    const safe = /未识别到中文字幕/.test(message) ? '没有识别到画面下方的中文字幕，请确认视频包含中文字幕' : /不超过.*秒/.test(message) ? '目前支持 5 分钟以内的视频' : /没有返回指定视频|没有可下载|图文/.test(message) ? '暂时无法获取此视频，请确认链接公开可访问且为视频作品' : '文案提取失败，请稍后重试或更换链接';
    await updateOwned(job, { status: options.signal?.aborted ? 'queued' : 'failed', stage: options.signal?.aborted ? 'queued' : 'failed', error: options.signal?.aborted ? null : safe, leaseToken: null, leaseUntil: 0 }).catch(() => {});
  } finally { clearInterval(heartbeat); await owned; await rm(runDir, { recursive: true, force: true }).catch(() => {}); }
  return true;
}
export function startDouyinWorker() {
  let stopped = false, running: Promise<unknown> | null = null;
  const controller = new AbortController();
  const tick = () => { if (stopped || running) return; running = processNextDouyin({ signal: controller.signal }).catch(() => { console.error('Douyin extraction cycle failed'); }).finally(() => { running = null; }); };
  const timer = setInterval(tick, 1000); timer.unref(); tick();
  return { stop: async () => { stopped = true; clearInterval(timer); controller.abort(); await running; } };
}
