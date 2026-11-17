import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { Segment, WordTiming } from '../shared/types';

export interface AsrJob {
  id: string; projectId: string; taskId: string; baseUrl: string; model: string;
  createdAt: string; fingerprint: string;
}
export class AsrError extends Error {
  constructor(message: string, public terminal = false, public pending = false) { super(message); }
}
export function asrConfiguration() {
  const key = process.env.ASR_API_KEY?.trim();
  if (!key) return null;
  const provider = process.env.ASR_PROVIDER?.trim() || 'openai';
  if (provider !== 'aliyun' && provider !== 'openai') throw new AsrError('ASR_PROVIDER 仅支持 aliyun 或 openai');
  const model = process.env.ASR_MODEL?.trim() || (provider === 'aliyun' ? 'qwen-audio-3.1-asr-flash-filetrans' : 'whisper-1');
  let baseUrl = process.env.ASR_BASE_URL?.trim().replace(/\/$/, '') || (provider === 'aliyun' ? 'https://dashscope.aliyuncs.com/api/v1' : '');
  if (!baseUrl) return null;
  if (provider === 'aliyun') {
    if (baseUrl.includes('compatible-mode')) throw new AsrError('百炼文件转写请使用 /api/v1 地址，不是 compatible-mode 地址');
    if (!baseUrl.endsWith('/api/v1')) baseUrl += '/api/v1';
    if (!/^(qwen-audio-[\w.-]+-asr-flash-filetrans|fun-asr(?:-[\w.-]+)?|paraformer-v2)$/.test(model)) throw new AsrError('请选择百炼文件转写模型，例如 qwen-audio-3.1-asr-flash-filetrans 或 fun-asr');
  }
  const timeoutMs = Math.min(600, Math.max(15, Number(process.env.ASR_TIMEOUT_SECONDS) || 180)) * 1000;
  return { provider, key, model, baseUrl, timeoutMs };
}
export function asrReady() { try { return !!asrConfiguration(); } catch { return false; } }
export type AsrConfig = NonNullable<ReturnType<typeof asrConfiguration>>;
type Transport = { fetcher?: typeof fetch; sleep?: (ms: number) => Promise<unknown>; now?: () => number; pollMs?: number; signal?: AbortSignal; beforeSubmit?: () => void | Promise<void> };

// These URLs come from the authenticated provider, never from a browser request.
// Keep credentials on the API host, and never forward them to upload/result URLs.
function storageUrl(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new AsrError('百炼返回的存储地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.endsWith('.aliyuncs.com')) throw new AsrError('百炼返回了不受支持的存储地址');
  return url.toString();
}
async function jsonRequest(fetcher: typeof fetch, url: string, init: RequestInit, stage: string) {
  let response: Response;
  try { response = await fetcher(url, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }); }
  catch { throw new AsrError(`${stage}连接失败，请稍后重试；已提交的任务会继续查询`); }
  let body;
  try { body = await response.json(); } catch { throw new AsrError(`${stage}未返回有效 JSON（HTTP ${response.status}）`); }
  if (!response.ok) {
    const code = typeof body?.code === 'string' && /^[\w.-]{1,80}$/.test(body.code) ? ` / ${body.code}` : '';
    throw new AsrError(`${stage}失败（HTTP ${response.status}${code}），请检查对应地域的 Key、模型权限与额度`, stage === '百炼任务查询' && response.status === 404);
  }
  return body;
}
const policySchema = z.object({ data: z.object({ upload_host: z.string(), upload_dir: z.string().min(1), oss_access_key_id: z.string(), signature: z.string(), policy: z.string(), x_oss_object_acl: z.string(), x_oss_forbid_overwrite: z.string(), max_file_size_mb: z.number().optional() }) });
export async function submitAliyunAudio(config: AsrConfig, data: Uint8Array, filename: string, transport: Transport = {}) {
  const fetcher = transport.fetcher || fetch;
  const authorization = { Authorization: `Bearer ${config.key}` };
  const url = new URL(config.baseUrl + '/uploads'); url.searchParams.set('action', 'getPolicy'); url.searchParams.set('model', config.model);
  const policy = policySchema.safeParse(await jsonRequest(fetcher, url.toString(), { headers: authorization, signal: transport.signal }, '百炼上传授权'));
  if (!policy.success) throw new AsrError('百炼上传凭证格式不符合预期');
  const p = policy.data.data;
  if (data.byteLength > (p.max_file_size_mb || 128) * 1024 * 1024) throw new AsrError('音轨超过百炼临时上传大小限制，请拆分素材');
  const key = p.upload_dir.replace(/\/$/, '') + '/' + filename;
  const form = new FormData();
  for (const [name, value] of Object.entries({ OSSAccessKeyId: p.oss_access_key_id, Signature: p.signature, policy: p.policy, 'x-oss-object-acl': p.x_oss_object_acl, 'x-oss-forbid-overwrite': p.x_oss_forbid_overwrite, key, success_action_status: '200' })) form.set(name, value);
  form.set('file', new Blob([new Uint8Array(data)], { type: 'audio/flac' }), filename);
  let uploaded: Response;
  try { uploaded = await fetcher(storageUrl(p.upload_host), { method: 'POST', body: form, redirect: 'error', signal: transport.signal ? AbortSignal.any([transport.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) }); }
  catch (error) { if (error instanceof AsrError) throw error; throw new AsrError('百炼音轨上传连接失败，请重试'); }
  if (!uploaded.ok) throw new AsrError(`百炼音轨上传失败（HTTP ${uploaded.status}）`);
  transport.signal?.throwIfAborted(); await transport.beforeSubmit?.();
  const result = await jsonRequest(fetcher, config.baseUrl + '/services/audio/asr/transcription', {
    method: 'POST', signal: transport.signal, headers: { ...authorization, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable', 'X-DashScope-OssResourceResolve': 'enable' },
    body: JSON.stringify({ model: config.model, input: { file_urls: ['oss://' + key] }, parameters: { channel_id: [0], diarization_enabled: true } })
  }, '百炼转写提交');
  const taskId = result?.output?.task_id;
  if (typeof taskId !== 'string' || !/^[\w-]{1,150}$/.test(taskId)) throw new AsrError('百炼未返回有效任务编号');
  return taskId;
}

const ms = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function normalizeAliyunTranscript(input: unknown): Segment[] {
  if (!input || typeof input !== 'object') throw new AsrError('百炼转写结果格式无效', true);
  const transcripts = (input as { transcripts?: unknown }).transcripts;
  if (!Array.isArray(transcripts)) throw new AsrError('百炼没有返回可用逐字稿', true);
  const segments: Segment[] = [];
  for (const transcript of transcripts) {
    if (!Array.isArray(transcript?.sentences)) continue;
    for (const sentence of transcript.sentences) {
      if (!sentence || typeof sentence.text !== 'string' || !sentence.text.trim() || !ms(sentence.begin_time) || !ms(sentence.end_time) || sentence.end_time <= sentence.begin_time) continue;
      const words: WordTiming[] = [];
      for (const word of Array.isArray(sentence.words) ? sentence.words : []) {
        if (word && typeof word.text === 'string' && word.text.trim() && ms(word.begin_time) && ms(word.end_time) && word.end_time > word.begin_time) {
          words.push({ start: word.begin_time / 1000, end: word.end_time / 1000, text: word.text.trim(), ...(typeof word.punctuation === 'string' ? { punctuation: word.punctuation } : {}) });
        }
      }
      segments.push({ start: sentence.begin_time / 1000, end: sentence.end_time / 1000, text: sentence.text.trim(), ...(words.length ? { words } : {}), ...(Number.isInteger(sentence.speaker_id) && sentence.speaker_id >= 0 ? { speakerId: sentence.speaker_id } : {}) });
    }
  }
  if (!segments.length) throw new AsrError('百炼未返回带有效时间码的语音；请检查音轨是否有人声', true);
  return segments.sort((a, b) => a.start! - b.start!);
}
export async function waitForAliyunTranscript(config: AsrConfig, taskId: string, transport: Transport = {}): Promise<Segment[]> {
  const fetcher = transport.fetcher || fetch, sleep = transport.sleep || delay, clock = transport.now || Date.now;
  const deadline = clock() + config.timeoutMs;
  while (clock() < deadline) {
    transport.signal?.throwIfAborted();
    const result = await jsonRequest(fetcher, config.baseUrl + '/tasks/' + encodeURIComponent(taskId), { headers: { Authorization: `Bearer ${config.key}` }, signal: transport.signal }, '百炼任务查询');
    const output = result?.output;
    if (output?.task_status === 'SUCCEEDED') {
      const item = output.results?.[0];
      if (item?.subtask_status !== 'SUCCEEDED' || typeof item?.transcription_url !== 'string') throw new AsrError('百炼文件转写失败，请检查文件格式与模型支持范围', true);
      const transcript = await jsonRequest(fetcher, storageUrl(item.transcription_url), { signal: transport.signal }, '百炼转写结果下载');
      return normalizeAliyunTranscript(transcript);
    }
    if (['FAILED', 'CANCELED', 'CANCELLED', 'UNKNOWN'].includes(output?.task_status)) throw new AsrError('百炼转写任务失败或已过期，请重试', true);
    if (!['PENDING', 'RUNNING', 'SCHEDULED'].includes(output?.task_status)) throw new AsrError('百炼返回未知任务状态，请稍后继续查询');
    await sleep(Math.min(transport.pollMs ?? 2000, Math.max(0, deadline - clock())));
    transport.signal?.throwIfAborted();
  }
  throw new AsrError('百炼任务仍在处理中，后台将继续查询，已提交的任务不会重复提交', false, true);
}
