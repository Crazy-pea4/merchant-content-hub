import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from './errors';

const exec = promisify(execFile);
// Decode before joining to remove MP3 encoder padding at each boundary. Keep natural speech pauses.
export async function assembleDubbingAudio(parts: { audio: Buffer; pauseAfterMs: number }[], signal: AbortSignal, seconds?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'dubbing-join-'));
  try {
    const buffers: Buffer[] = [];
    for (let index = 0; index < parts.length; index++) {
      signal.throwIfAborted();
      const input = join(directory, `${index}.mp3`), output = join(directory, `${index}.pcm`);
      await writeFile(input, parts[index].audio);
      await exec('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '24000', '-f', 's16le', output], { timeout: 30000, signal });
      const audio = await readFile(output); if (!audio.length || audio.length > 32 * 1024 * 1024) throw new Error('Invalid audio');
      buffers.push(audio);
      if (parts[index].pauseAfterMs) buffers.push(Buffer.alloc(Math.round(24000 * parts[index].pauseAfterMs / 1000) * 2));
    }
    const pcm = join(directory, 'combined.pcm'), mp3 = join(directory, 'combined.mp3');
    await writeFile(pcm, Buffer.concat(buffers));
    await exec('ffmpeg', ['-v', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm, ...(seconds ? ['-t', String(seconds)] : []), '-c:a', 'libmp3lame', '-b:a', '96k', mp3], { timeout: 60000, signal });
    return await readFile(mp3);
  } catch { signal.throwIfAborted(); throw new ApiError('分段音频处理失败，请稍后重试'); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
