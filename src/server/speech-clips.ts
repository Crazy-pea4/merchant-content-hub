import { createHash } from 'node:crypto';
import type { SpeechPart } from '../shared/dubbing-script';
import { downloadSpeech, synthesizeRemote, type TtsConfig } from './tts';
import { ApiError } from './errors';

const ttl = 10 * 60 * 1000, maxBytes = 32 * 1024 * 1024;
type Clip = { expiresAt: number; pending: boolean; bytes: number; promise: Promise<Buffer> };
const clips = new Map<string, Clip>();
export const speechClipKey = (config: TtsConfig, voiceId: string, part: SpeechPart) => createHash('sha256').update(JSON.stringify([config.account, config.model, voiceId, part.text, part.settings])).digest('hex');
function prune() {
  for (const [key, clip] of clips) if (!clip.pending && clip.expiresAt < Date.now()) clips.delete(key);
  let bytes = [...clips.values()].reduce((sum, clip) => sum + clip.bytes, 0);
  for (const [key, clip] of clips) {
    if (bytes <= maxBytes && clips.size < 32) break;
    if (!clip.pending) { clips.delete(key); bytes -= clip.bytes; }
  }
}
const cleanup = setInterval(prune, 60000); cleanup.unref();
export function speechClip(config: TtsConfig, voiceId: string, part: SpeechPart, options: { signal: AbortSignal; audioUrl?: string | null; beforeSubmit?: () => Promise<void>; submitted?: (url: string) => Promise<void> }) {
  prune();
  const key = speechClipKey(config, voiceId, part), cached = clips.get(key);
  if (cached) return cached.promise;
  if ([...clips.values()].filter(clip => clip.pending).length >= 4) throw new ApiError('当前试听任务较多，请稍后再试', 429);
  const clip: Clip = { expiresAt: Date.now() + ttl, pending: true, bytes: 0, promise: Promise.resolve(Buffer.alloc(0)) };
  clip.promise = (async () => {
    let url = options.audioUrl;
    if (!url) {
      await options.beforeSubmit?.();
      url = await synthesizeRemote(config, voiceId, part.text, part.settings, options.signal);
      await options.submitted?.(url);
    }
    return downloadSpeech(config, url, options.signal);
  })().then(audio => { clip.pending = false; clip.bytes = audio.length; clip.expiresAt = Date.now() + ttl; prune(); return audio; }, error => { clips.delete(key); throw error; });
  clips.set(key, clip); return clip.promise;
}
