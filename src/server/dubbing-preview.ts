import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { MAX_DUBBING_TEXT } from '../shared/types';
import { DUBBING_PREVIEW_SECONDS, dubbingPreviewText } from '../shared/dubbing-preview';
import { readyDubbingVoice } from './dubbing';
import { ApiError } from './errors';
import { hasCommand } from './media';
import { downloadSpeech, synthesizeRemote } from './tts';
import { resolveDubbingSettings } from '../shared/dubbing-settings';
import { assertDubbingExpression, dubbingSettingsShape } from './dubbing-settings';
import { dubbingPartsSchema, validateDubbingScript } from './dubbing-script';
import { previewSpeechPlan } from '../shared/dubbing-script';
import { speechClip } from './speech-clips';
import { assembleDubbingAudio } from './dubbing-audio';

const exec = promisify(execFile), ttl = 10 * 60 * 1000;
type Preview = { expiresAt: number; pending: boolean; bytes: number; promise: Promise<Buffer> };
const cache = new Map<string, Preview>();
const requests = new Map<string, Preview & { signature: string }>();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function prune() {
  for (const entries of [cache, requests]) {
    let bytes = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [key, entry] of entries) if (!entry.pending && (entry.expiresAt < Date.now() || bytes > 32 * 1024 * 1024)) { entries.delete(key); bytes -= entry.bytes; }
  }
}
const cleanup = setInterval(prune, 60000); cleanup.unref();
function makeRoom<T extends Preview>(entries: Map<string, T>, max: number) {
  for (const [key, entry] of entries) { if (entries.size < max) return; if (!entry.pending) entries.delete(key); }
}
export async function previewDubbing(input: unknown, signal?: AbortSignal) {
  const data = z.object({ requestId: z.string().uuid(), voiceId: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(MAX_DUBBING_TEXT), parts: dubbingPartsSchema, scope: z.enum(['opening', 'sentence', 'context']).default('opening'), partId: z.string().uuid().optional(), ...dubbingSettingsShape }).strict().parse(input);
  validateDubbingScript(data.text, data.parts);
  signal?.throwIfAborted();
  const { voice, config } = await readyDubbingVoice(data.voiceId);
  const settings = resolveDubbingSettings(data);
  const plan = data.parts ? previewSpeechPlan(data.parts, settings, data.scope, data.partId) : null;
  if (data.scope !== 'opening' && !plan?.length) throw new ApiError('请选择要试听的句子');
  if (plan) {
    if (!plan.length) throw new ApiError('请先输入朗读文案');
    if (data.scope !== 'opening' && plan.reduce((sum, part) => sum + part.text.length, 0) > 600) throw new ApiError('本次试听文案较长，请拆分句子后再试听');
    plan.forEach(part => assertDubbingExpression(config.model, part.settings));
  } else assertDubbingExpression(config.model, settings);
  const signature = hash([data.voiceId, plan || [data.text, settings], data.scope, config.account, config.model]);
  prune();
  const previous = requests.get(data.requestId);
  if (previous) { if (previous.signature !== signature) throw new ApiError('试听请求编号已被使用，请重新试听', 409); return previous.promise; }
  makeRoom(requests, 128);
  if (requests.size >= 128) throw new ApiError('当前试听任务较多，请稍后再试', 429);
  const text = dubbingPreviewText(data.text), key = hash([config.account, config.model, voice.providerVoiceId, plan || [text, settings], data.scope]);
  let entry = cache.get(key);
  if (!entry) {
    if (!await hasCommand('ffmpeg')) throw new ApiError('音频处理服务暂不可用');
    const concurrent = requests.get(data.requestId);
    if (concurrent) { if (concurrent.signature !== signature) throw new ApiError('试听请求编号已被使用，请重新试听', 409); return concurrent.promise; }
    makeRoom(requests, 128);
    if (requests.size >= 128) throw new ApiError('当前试听任务较多，请稍后再试', 429);
    // Another request may have filled this cache while command detection was awaiting.
    entry = cache.get(key);
    if (!entry) {
      signal?.throwIfAborted();
      if ([...cache.values()].filter(value => value.pending).length >= 2) throw new ApiError('当前试听任务较多，请稍后再试', 429);
      makeRoom(cache, 32);
      const current: Preview = { expiresAt: Date.now() + ttl, pending: true, bytes: 0, promise: Promise.resolve(Buffer.alloc(0)) };
      // Finish an accepted short synthesis even if its tab closes, so a retry can reuse it.
      current.promise = createPreview().then(audio => { current.pending = false; current.bytes = audio.length; current.expiresAt = Date.now() + ttl; prune(); return audio; }, error => { current.pending = false; if (cache.get(key) === current) cache.delete(key); throw error; });
      cache.set(key, current); entry = current;
    }
  }
  makeRoom(requests, 128);
  const request = { ...entry, signature };
  request.promise = entry.promise.then(audio => { request.bytes = audio.length; return audio; }).finally(() => { request.pending = false; request.expiresAt = Date.now() + ttl; prune(); });
  requests.set(data.requestId, request);
  return request.promise;

  async function createPreview() {
    const timeout = AbortSignal.timeout(150000);
    if (plan) {
      const audio = [];
      for (const part of plan) audio.push({ audio: await speechClip(config, voice.providerVoiceId!, part, { signal: timeout }), pauseAfterMs: part.pauseAfterMs });
      return assembleDubbingAudio(audio, timeout, data.scope === 'opening' ? DUBBING_PREVIEW_SECONDS : undefined);
    }
    const url = await synthesizeRemote(config, voice.providerVoiceId!, text, settings, timeout);
    const audio = await downloadSpeech(config, url, timeout);
    const directory = await mkdtemp(join(tmpdir(), 'dubbing-preview-'));
    try {
      const original = join(directory, 'input.mp3'), clipped = join(directory, 'preview.mp3');
      await writeFile(original, audio);
      try { await exec('ffmpeg', ['-v', 'error', '-y', '-i', original, '-t', String(DUBBING_PREVIEW_SECONDS), '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '96k', clipped], { timeout: 15000, signal: timeout }); }
      catch { throw new ApiError('试听音频处理失败，请稍后重新试听'); }
      return await readFile(clipped);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
