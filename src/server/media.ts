import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { dataDir, id, now } from './db';
import { asrConfiguration, submitAliyunAudio, waitForAliyunTranscript, type AsrJob } from './asr';
import { indexTags, parseTranscript } from './search';
import type { Asset, Segment } from '../shared/types';

const exec = promisify(execFile);
export const uploadDir = join(dataDir, 'uploads');
const mediaTypes: Record<string, [Asset['kind'], string]> = {
  '.mp4': ['video', 'video/mp4'], '.mov': ['video', 'video/quicktime'], '.webm': ['video', 'video/webm'],
  '.mp3': ['audio', 'audio/mpeg'], '.wav': ['audio', 'audio/wav'], '.m4a': ['audio', 'audio/mp4'], '.ogg': ['audio', 'audio/ogg'], '.flac': ['audio', 'audio/flac'],
  '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'], '.png': ['image', 'image/png'], '.webp': ['image', 'image/webp'],
  '.txt': ['document', 'text/plain; charset=utf-8'], '.srt': ['document', 'text/plain; charset=utf-8'], '.md': ['document', 'text/plain; charset=utf-8']
};
export async function hasCommand(name: 'ffmpeg' | 'ffprobe') {
  try { await exec(name, ['-version'], { timeout: 3000, maxBuffer: 100_000 }); return true; } catch { return false; }
}
export async function inspect(path: string): Promise<{ duration: number | null; video: boolean; audio: boolean; videoDuration: number | null; audioDuration: number | null }> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,duration', '-of', 'json', path], { timeout: 15000, maxBuffer: 100_000 });
  const info = JSON.parse(stdout);
  const duration = Number(info.format?.duration);
  const streams: { codec_type: string; duration?: string }[] = info.streams || [];
  const video = streams.find(s => s.codec_type === 'video');
  const audio = streams.find(s => s.codec_type === 'audio');
  const streamDuration = (v?: string) => v && Number.isFinite(Number(v)) ? Number(v) : null;
  return { duration: Number.isFinite(duration) && duration > 0 ? duration : null, video: !!video, audio: !!audio,
    videoDuration: streamDuration(video?.duration), audioDuration: streamDuration(audio?.duration) };
}
export function maxUploadBytes() { return Math.min(512, Math.max(1, Number(process.env.MAX_UPLOAD_MB) || 128)) * 1024 * 1024; }
export async function saveUpload(file: File, projectId: string, tags: string[], rights: Asset['rights'], expiresAt: string, note: string): Promise<Asset> {
  if (!file.size || file.size > maxUploadBytes()) throw new Error(`文件为空或超过 ${maxUploadBytes() / 1024 / 1024} MB 限制`);
  const ext = extname(file.name).toLowerCase();
  const type = mediaTypes[ext];
  if (!type) throw new Error('支持 MP4 / MOV / WebM、常见音频、JPG / PNG / WebP、TXT / SRT / MD');
  await mkdir(uploadDir, { recursive: true });
  const assetId = id();
  const storageKey = assetId + ext;
  const path = join(uploadDir, storageKey);
  const buffer = Buffer.from(await file.arrayBuffer());
  let duration: number | null = null, thumbnailKey: string | null = null, error: string | null = null;
  let segments: Segment[] = []; let hasAudio: boolean | undefined;
  if (type[0] === 'image') {
    const valid = ext === '.png' ? buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : ext === '.webp' ? buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' : buffer[0] === 255 && buffer[1] === 216;
    if (!valid) throw new Error('图片内容与文件扩展名不一致');
  }
  if (type[0] === 'document') {
    if (buffer.includes(0)) throw new Error('请上传 UTF-8 文本文件');
    segments = parseTranscript(buffer.toString('utf8').slice(0, 100_000));
  }
  await writeFile(path, buffer, { flag: 'wx' });
  try {
    if (type[0] === 'video' || type[0] === 'audio') {
      if (await hasCommand('ffprobe')) {
        let info;
        try { info = await inspect(path); } catch { throw new Error('无法解析媒体，请检查文件是否损坏或扩展名是否正确'); }
        if (type[0] === 'video' && !info.video || type[0] === 'audio' && !info.audio) throw new Error('文件缺少对应的视频或音频轨道');
        duration = info.duration; hasAudio = info.audio;
        if (info.video && await hasCommand('ffmpeg')) {
          const key = assetId + '.thumb.jpg';
          try { await exec('ffmpeg', ['-y', '-i', path, '-frames:v', '1', '-vf', 'scale=640:-2', join(uploadDir, key)], { timeout: 20000, maxBuffer: 1_000_000 }); thumbnailKey = key; }
          catch { error = '缩略图生成失败，原文件已保存'; }
        }
      } else error = '未安装 ffprobe：时长与媒体有效性尚未检测';
    }
    return { id: assetId, projectId, name: file.name.slice(0, 180), kind: type[0], mime: type[1], size: file.size, storageKey, thumbnailKey, duration, tags: indexTags(segments, tags), segments, hasAudio, transcriptSource: segments.length ? 'manual' : 'none', rights, expiresAt, note, error, createdAt: now() };
  } catch (error) { await unlink(path).catch(() => {}); throw error; }
}
export async function transcribe(asset: Pick<Asset, 'kind' | 'storageKey'>, pending?: Pick<AsrJob, 'taskId'>, submitted?: (taskId: string) => void | Promise<void>, options: { signal?: AbortSignal; beforeSubmit?: () => void | Promise<void> } = {}): Promise<Segment[]> {
  const config = asrConfiguration();
  if (!config) throw new Error('尚未配置真实 ASR；可先导入逐字稿或 SRT，系统不会生成虚构转写');
  if (!asset.storageKey || !['video', 'audio'].includes(asset.kind)) throw new Error('请先上传真实视频或音频');
  if (config.provider === 'aliyun' && pending) return waitForAliyunTranscript(config, pending.taskId, options);
  const filename = id() + (config.provider === 'aliyun' ? '.flac' : '.wav');
  const temp = join(uploadDir, filename);
  try {
    try { await exec('ffmpeg', ['-y', '-i', join(uploadDir, asset.storageKey), '-vn', '-ac', '1', '-ar', '16000', temp], { timeout: 60000, maxBuffer: 500_000, signal: options.signal }); }
    catch { throw new Error('音轨提取失败；需要 FFmpeg 和有效音频轨道'); }
    const data = await readFile(temp);
    if (config.provider === 'aliyun') {
      if (data.length > 128 * 1024 * 1024) throw new Error('提取音轨超过 128 MB，请拆分素材后重试');
      const taskId = await submitAliyunAudio(config, data, filename, options);
      await submitted?.(taskId);
      return await waitForAliyunTranscript(config, taskId, options);
    }
    if (data.length > 24 * 1024 * 1024) throw new Error('提取音频超过 24 MB，请拆分素材后重试');
    const form = new FormData();
    form.append('file', new Blob([data], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', config.model);
    form.append('response_format', 'verbose_json');
    options.signal?.throwIfAborted(); await options.beforeSubmit?.();
    const response = await fetch(config.baseUrl + '/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${config.key}` }, body: form, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000) });
    if (!response.ok) throw new Error(`ASR 服务调用失败（${response.status}），请检查配置与额度`);
    const result = await response.json();
    if (Array.isArray(result.segments) && result.segments.length) {
      const segments: Segment[] = result.segments.filter((s: Record<string, unknown>) => typeof s.text === 'string' && s.text.trim() && Number.isFinite(s.start) && Number(s.start) >= 0 && Number.isFinite(s.end) && Number(s.end) > Number(s.start)).map((s: { start: number; end: number; text: string }) => ({ start: s.start, end: s.end, text: s.text.trim() }));
      if (segments.length) return segments;
    }
    if (typeof result.text === 'string' && result.text.trim()) return [{ start: null, end: null, text: result.text.trim() }];
    throw new Error('ASR 没有返回可用文字');
  } finally { await unlink(temp).catch(() => {}); }
}
export async function roughCut(asset: Asset, start: number, end: number): Promise<Asset> {
  if (asset.kind !== 'video' || !asset.storageKey) throw new Error('粗剪需要真实视频文件');
  if (end <= start || start < 0 || end - start > 60 || asset.duration === null || end > asset.duration + 0.05) throw new Error('请输入素材范围内的起止时间，单次最多 60 秒');
  await mkdir(uploadDir, { recursive: true });
  const assetId = id(), storageKey = assetId + '.mp4';
  const path = join(uploadDir, storageKey);
  try {
    await exec('ffmpeg', ['-y', '-ss', String(start), '-i', join(uploadDir, asset.storageKey), '-t', String(end - start), '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='trunc(min(1280,iw)/2)*2':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', path], { timeout: 90000, maxBuffer: 1_000_000 });
    const data = await readFile(path);
    const info = await inspect(path);
    const segments = asset.segments.filter(s => s.start !== null && s.end !== null && s.start < end && s.end > start).map(s => ({ ...s, start: Math.max(0, s.start! - start), end: Math.min(end - start, s.end! - start), ...(s.words ? { words: s.words.filter(w => w.start < end && w.end > start).map(w => ({ ...w, start: Math.max(0, w.start - start), end: Math.min(end - start, w.end - start) })) } : {}) }));
    return { ...asset, id: assetId, name: `${asset.name.replace(/\.[^.]+$/, '')} · 粗剪 ${start}-${end}s.mp4`, size: data.length, storageKey, thumbnailKey: null, duration: info.duration, segments, note: `原素材 ${asset.id}；区间 ${start}–${end} 秒。单片段截取，待人工精剪。`, createdAt: now() };
  } catch { await unlink(path).catch(() => {}); throw new Error('粗剪失败，请确认 FFmpeg 可用并检查视频编码'); }
}
