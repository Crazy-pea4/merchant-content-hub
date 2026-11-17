import { createHash } from 'node:crypto';
import { dubbingInstruction, type DubbingSettings } from '../shared/dubbing-settings';
import { assertDubbingExpression, dubbingSettingsSchema } from './dubbing-settings';

export class TtsError extends Error { constructor(message: string, public expiredAudio = false) { super(message); } }
export function ttsConfiguration() {
  const key = process.env.TTS_API_KEY?.trim() || (process.env.ASR_PROVIDER === 'aliyun' ? process.env.ASR_API_KEY?.trim() : '');
  if (!key) return null;
  const baseUrl = (process.env.TTS_BASE_URL?.trim() || (process.env.ASR_PROVIDER === 'aliyun' ? process.env.ASR_BASE_URL?.trim() : '') || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/$/, '');
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new TtsError('TTS_BASE_URL 不是有效地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || baseUrl.includes('compatible-mode')) throw new TtsError('语音合成请配置百炼 /api/v1 地址');
  const model = process.env.TTS_MODEL?.trim() || 'cosyvoice-v3-flash';
  if (!/^cosyvoice-(?:v3\.5-(?:plus|flash)|v3-(?:plus|flash)|v2)$/.test(model)) throw new TtsError('个人配音请选择支持声音复刻的 CosyVoice 模型');
  return { key, baseUrl, model, account: createHash('sha256').update(baseUrl + '\n' + key).digest('hex') };
}
export function ttsReady() { try { return !!ttsConfiguration(); } catch { return false; } }
export type TtsConfig = NonNullable<ReturnType<typeof ttsConfiguration>>;

async function readLimited(response: Response, limit: number) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new TtsError('语音服务返回的文件超过大小限制'); }
  const reader = response.body?.getReader(); if (!reader) throw new TtsError('语音服务返回了空内容');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new TtsError('语音服务返回的文件超过大小限制'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
async function request(config: TtsConfig, path: string, payload: unknown, signal?: AbortSignal) {
  try {
    const response = await fetch(config.baseUrl + path, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.any([AbortSignal.timeout(180000), ...(signal ? [signal] : [])]) });
    if (!response.ok) { await response.body?.cancel(); throw new TtsError(`语音服务调用失败（HTTP ${response.status}），请检查服务权限、地域和额度`); }
    let data;
    try { data = JSON.parse((await readLimited(response, 1024 * 1024)).toString()); } catch (error) { if (error instanceof TtsError) throw error; throw new TtsError('语音服务返回格式无效'); }
    if (!data?.output || data.code) throw new TtsError('语音服务未返回有效结果，请检查模型与音色状态');
    return data.output;
  } catch (error) { if (error instanceof TtsError) throw error; throw new TtsError('语音服务连接中断或超时，请查看任务状态后重试'); }
}
export async function createRemoteVoice(config: TtsConfig, audio: Buffer, signal?: AbortSignal) {
  const result = await request(config, '/services/audio/tts/customization', { model: 'voice-enrollment', input: { action: 'create_voice', target_model: config.model, prefix: 'fieldwork', audio: 'data:audio/wav;base64,' + audio.toString('base64') } }, signal);
  if (typeof result.voice_id !== 'string' || !/^[\w.-]{1,256}$/.test(result.voice_id)) throw new TtsError('语音服务未返回有效音色编号');
  return result.voice_id as string;
}
export async function queryRemoteVoice(config: TtsConfig, voiceId: string, signal?: AbortSignal) {
  const output = await request(config, '/services/audio/tts/customization', { model: 'voice-enrollment', input: { action: 'query_voice', voice_id: voiceId } }, signal);
  if (output.target_model && output.target_model !== config.model) throw new TtsError('音色绑定的模型不一致，请重新创建音色');
  if (!['OK', 'DEPLOYING'].includes(output.status)) throw new TtsError('音色不可用，请检查录音质量后重试');
  return output.status as 'OK' | 'DEPLOYING';
}
export async function deleteRemoteVoice(config: TtsConfig, voiceId: string, signal?: AbortSignal) {
  await request(config, '/services/audio/tts/customization', { model: 'voice-enrollment', input: { action: 'delete_voice', voice_id: voiceId } }, signal);
}
export function resultAudioUrl(value: unknown, config: TtsConfig) {
  if (typeof value !== 'string' || value.length > 8192) throw new TtsError('语音服务未返回有效音频地址');
  let url: URL;
  try { url = new URL(value); } catch { throw new TtsError('语音服务返回的音频地址无效'); }
  const localTest = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.origin === new URL(config.baseUrl).origin;
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol) || (!localTest && (!url.hostname.endsWith('.aliyuncs.com') || url.port))) throw new TtsError('语音服务返回了不受信任的音频地址');
  if (!localTest) url.protocol = 'https:';
  return url.toString();
}
export async function synthesizeRemote(config: TtsConfig, voiceId: string, text: string, inputSettings: Partial<DubbingSettings>, signal?: AbortSignal) {
  const settings = dubbingSettingsSchema.parse(inputSettings);
  assertDubbingExpression(config.model, settings);
  const instruction = dubbingInstruction(settings);
  const output = await request(config, '/services/audio/tts/SpeechSynthesizer', { model: config.model, input: { text, voice: voiceId, format: 'mp3', sample_rate: 24000, rate: settings.rate, pitch: settings.pitch, ...(instruction ? { instruction } : {}) } }, signal);
  return resultAudioUrl(output.audio?.url, config);
}
export async function downloadSpeech(config: TtsConfig, url: string, signal?: AbortSignal) {
  try {
    const response = await fetch(resultAudioUrl(url, config), { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]) });
    if (!response.ok) { await response.body?.cancel(); const expired = [403, 404].includes(response.status); throw new TtsError(expired ? '配音文件地址已失效，点击重试会重新合成并产生合成费用' : `配音文件下载失败（HTTP ${response.status}），可重试下载`, expired); }
    const data = await readLimited(response, 64 * 1024 * 1024);
    if (!data.length) throw new TtsError('语音服务返回了空音频');
    return data;
  } catch (error) { if (error instanceof TtsError) throw error; throw new TtsError('配音文件下载中断，可重试下载'); }
}
