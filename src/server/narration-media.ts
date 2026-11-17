import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { inspect, uploadDir } from './media';
import { ApiError } from './errors';
import { defaultDubbingSettings } from '../shared/dubbing-settings';
import { MAX_NARRATION_SHOTS, narrationVtt, type NarrationShot, type NarrationSegment } from '../shared/narration';
import type { DubbingMedia } from '../shared/types';
import type { NarrationFrame } from './narration-vision';
import { narrationAss, narrationCaptions, narrationCaptionFile } from '../shared/narration-captions';

const exec = promisify(execFile);
export function narrationWindows(duration: number, cuts: number[]) {
  const boundaries = [0];
  for (const at of [...cuts].sort((a, b) => a - b)) if (Number.isFinite(at) && at - boundaries.at(-1)! >= 1.5 && duration - at >= 1.5) boundaries.push(at);
  boundaries.push(duration);
  const split = [0];
  for (let i = 1; i < boundaries.length; i++) {
    const start = boundaries[i - 1], end = boundaries[i], count = Math.ceil((end - start) / 12);
    for (let j = 1; j <= count; j++) split.push(Number((start + (end - start) * j / count).toFixed(3)));
  }
  const bounded = split.length - 1 <= MAX_NARRATION_SHOTS ? split : Array.from({ length: MAX_NARRATION_SHOTS + 1 }, (_, i) => split[Math.round(i * (split.length - 1) / MAX_NARRATION_SHOTS)]);
  return bounded.slice(0, -1).map((start, i): NarrationShot => ({ id: randomUUID(), start, end: bounded[i + 1], description: '', text: '', settings: { ...defaultDubbingSettings } }));
}
export async function extractNarrationFrames(media: DubbingMedia, signal: AbortSignal) {
  if (!media.duration) throw new ApiError('视频时长无效');
  const source = join(uploadDir, media.storageKey), created: string[] = [];
  try {
    const { stderr } = await exec('ffmpeg', ['-hide_banner', '-i', source, '-an', '-vf', 'scale=320:320:force_original_aspect_ratio=decrease,select=gt(scene\\,0.32),showinfo', '-vsync', 'vfr', '-f', 'null', '-'], { timeout: 180000, maxBuffer: 4 * 1024 * 1024, signal });
    const cuts = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map(match => Number(match[1]));
    const shots = narrationWindows(media.duration, cuts), frames: NarrationFrame[] = [];
    await mkdir(uploadDir, { recursive: true });
    for (const shot of shots) for (const fraction of [0.25, 0.75]) {
      signal.throwIfAborted();
      const at = Number((shot.start + (shot.end - shot.start) * fraction).toFixed(3)), storageKey = randomUUID() + '.jpg';
      created.push(storageKey);
      await exec('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', source, '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', '-q:v', '4', join(uploadDir, storageKey)], { timeout: 30000, signal, maxBuffer: 100000 });
      const buffer = await readFile(join(uploadDir, storageKey));
      if (!buffer.length || buffer.length > 512000) throw new ApiError('视频画面提取失败，请使用较小的视频');
      frames.push({ shotId: shot.id, at, storageKey });
    }
    return { shots, frames };
  } catch (error) {
    await Promise.all(created.map(key => unlink(join(uploadDir, key)).catch(() => {})));
    signal.throwIfAborted();
    if (error instanceof ApiError) throw error;
    throw new ApiError('视频分镜与画面提取失败，请检查视频或缩短时长');
  }
}
export async function saveNarrationMedia(data: Buffer, name: string, kind: 'audio' | 'video'): Promise<DubbingMedia> {
  const id = randomUUID(), ext = kind === 'video' ? '.mp4' : '.mp3', storageKey = id + ext;
  await mkdir(uploadDir, { recursive: true });
  try {
    await writeFile(join(uploadDir, storageKey), data);
    const info = await inspect(join(uploadDir, storageKey));
    if (!info.duration || !info.audio || kind === 'video' && !info.video) throw new ApiError('生成的媒体无效');
    return { id, storageKey, kind, name: name.replace(/\.[^.]+$/, '') + ext, mime: kind === 'video' ? 'video/mp4' : 'audio/mpeg', size: data.length, duration: info.duration, hasAudio: true };
  } catch (error) { await unlink(join(uploadDir, storageKey)).catch(() => {}); throw error; }
}
export function trimNarrationPcm(pcm: Buffer) {
  const samples = Math.floor(pcm.length / 2), window = 240, windows = Math.ceil(samples / window);
  function audible(index: number) {
    const start = index * window, end = Math.min(samples, start + window); let power = 0;
    for (let i = start; i < end; i++) { const value = pcm.readInt16LE(i * 2); power += value * value; }
    return power / (end - start) >= 185 * 185; // 10 ms RMS at approximately -45 dB.
  }
  let firstWindow = 0, lastWindow = windows - 1;
  while (firstWindow <= lastWindow && !audible(firstWindow)) firstWindow++;
  while (lastWindow >= firstWindow && !audible(lastWindow)) lastWindow--;
  if (firstWindow > lastWindow) throw new ApiError('旁白音频没有有效声音，请重新试听确认');
  const first = firstWindow * window, last = Math.min(samples, (lastWindow + 1) * window) - 1;
  const pad = 960; // 40 ms of quiet on each edge preserves soft consonants and word endings.
  return pcm.subarray(Math.max(0, first - pad) * 2, Math.min(pcm.length / 2, last + 1 + pad) * 2);
}
export async function prepareNarrationAudio(audio: Buffer, signal: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), 'narration-voice-'));
  try {
    const input = join(directory, 'voice.mp3'), output = join(directory, 'voice.pcm');
    await writeFile(input, audio);
    await exec('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '24000', '-f', 's16le', output], { timeout: 30000, signal, maxBuffer: 100000 });
    const pcm = trimNarrationPcm(await readFile(output));
    return { pcm, duration: pcm.length / 2 / 24000 };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function composeNarrationVideo(media: DubbingMedia, segments: NarrationSegment[], clipsPcm: Buffer[], speed: number, originalVolume: number, language: 'zh' | 'en', signal: AbortSignal, subtitleMode: 'original' | 'bilingual' = 'original') {
  const directory = await mkdtemp(join(tmpdir(), 'video-narration-'));
  try {
    const timeline = Buffer.alloc(Math.ceil(media.duration! * 24000) * 2);
    for (let i = 0; i < segments.length; i++) {
      const audio = clipsPcm[i];
      signal.throwIfAborted();
      const input = join(directory, `${i}-input.pcm`), output = join(directory, `${i}.pcm`);
      let pcm = audio;
      if (Math.abs(speed - 1) > 0.000001) {
        await writeFile(input, audio);
        await exec('ffmpeg', ['-v', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', input, '-af', `atempo=${speed.toFixed(9)}`, '-f', 's16le', output], { timeout: 30000, signal, maxBuffer: 100000 });
        pcm = await readFile(output);
      }
      const offset = Math.round(segments[i].start * 24000) * 2, available = Math.round(segments[i].end * 24000) * 2 - offset;
      if (pcm.length > available + 2400) throw new ApiError('旁白解码时长与安排时间不一致，请重试生成');
      pcm.copy(timeline, offset, 0, Math.min(pcm.length, available));
    }
    await writeFile(join(directory, 'timeline.pcm'), timeline);
    const captions = narrationCaptions(segments, language);
    await writeFile(join(directory, 'captions.vtt'), subtitleMode === 'bilingual' ? narrationCaptionFile(captions, 'vtt', 'bilingual') : narrationVtt(segments));
    const mixed = originalVolume > 0 && media.hasAudio;
    const output = join(directory, 'narration.mp4');
    if (subtitleMode === 'bilingual') {
      const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation', '-of', 'json', join(uploadDir, media.storageKey)], { signal, timeout: 15000, maxBuffer: 100000 });
      const stream = JSON.parse(stdout).streams?.[0];
      if (!stream?.width || !stream.height) throw new ApiError('无法读取视频画幅');
      const rotated = stream.side_data_list?.some((data: { rotation?: number }) => Math.abs(data.rotation ?? 0) % 180 === 90);
      const sourceWidth = rotated ? stream.height : stream.width, sourceHeight = rotated ? stream.width : stream.height;
      const scale = Math.min(1, 1280 / sourceWidth, 1280 / sourceHeight), width = Math.max(2, Math.floor(sourceWidth * scale / 2) * 2), height = Math.max(2, Math.floor(sourceHeight * scale / 2) * 2);
      const assPath = join(directory, 'captions.ass'); await writeFile(assPath, narrationAss(captions, width, height, true, language));
      const escapeFilter = (path: string) => path.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "'\\''");
      const clean = join(directory, 'clean.mp4'), encode = ['-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-t', String(media.duration), '-movflags', '+faststart'];
      const filters = `[0:v:0]scale=${width}:${height},split=2[cleanv][basev];[basev]ass=filename='${escapeFilter(assPath)}'[burnv];` + (mixed ? `[0:a:0]volume=${originalVolume}[original];[1:a:0][original]amix=inputs=2:duration=first:normalize=0` : '[1:a:0]anull') + '[sound];[sound]asplit=2[maina][cleana]';
      await exec('ffmpeg', ['-v', 'error', '-y', '-i', join(uploadDir, media.storageKey), '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', join(directory, 'timeline.pcm'), '-i', join(directory, 'captions.vtt'), '-filter_complex', filters,
        '-map', '[burnv]', '-map', '[maina]', '-map', '2:s:0', '-c:s', 'mov_text', '-disposition:s:0', '0', ...encode, output,
        '-map', '[cleanv]', '-map', '[cleana]', ...encode, clean], { timeout: 600000, maxBuffer: 500000, signal });
      return { video: await readFile(output), cleanVideo: await readFile(clean) };
    }
    await exec('ffmpeg', ['-v', 'error', '-y', '-i', join(uploadDir, media.storageKey), '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', join(directory, 'timeline.pcm'), '-i', join(directory, 'captions.vtt'),
      ...(mixed ? ['-filter_complex', `[0:a:0]volume=${originalVolume}[original];[1:a:0][original]amix=inputs=2:duration=first:normalize=0[audio]`] : []),
      '-map', '0:v:0', '-map', mixed ? '[audio]' : '1:a:0', '-map', '2:s:0', '-c:s', 'mov_text', '-metadata:s:s:0', `language=${language === 'zh' ? 'zho' : 'eng'}`,
      '-vf', 'scale=w=min(1280\\,iw):h=min(1280\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-t', String(media.duration), '-movflags', '+faststart', output], { timeout: 600000, maxBuffer: 500000, signal });
    return { video: await readFile(output), cleanVideo: null };
  } catch (error) { signal.throwIfAborted(); if (error instanceof ApiError) throw error; throw new ApiError('视频成片合成失败，请检查视频编码后重试'); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
