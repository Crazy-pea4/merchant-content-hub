import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = mkdtempSync(join(tmpdir(), 'fieldwork-dubbing-'));
process.env.DB_DRIVER = 'sqlite'; process.env.DATA_DIR = join(directory, 'data'); process.env.SEED_DEMO = 'false';
process.env.TTS_API_KEY = 'test-only'; process.env.TTS_MODEL = 'cosyvoice-v3-flash';
const sample = join(directory, 'sample.wav'), mp3 = join(directory, 'result.mp3');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', sample]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', sample, mp3]);
let creates = 0, syntheses = 0, downloads = 0, errorStatus = 0, failDownload = false;
let voiceDeletes = 0;
let synthesisAttempts = 0, lastSynthesisText = '', lastSynthesisRate = 0;
let failSynthesisText = '';
const synthesisInputs: Record<string, unknown>[] = [];
let beforeSynthesis: (() => Promise<void>) | undefined;
let base = '';
const server = createServer(async (req, res) => {
  if (req.url === '/result.mp3') { downloads++; assert.equal(req.headers.authorization, undefined); if (failDownload) { res.writeHead(503); res.end(); } else { res.setHeader('Content-Type', 'audio/mpeg'); res.end(readFileSync(mp3)); } return; }
  assert.equal(req.headers.authorization, 'Bearer test-only');
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  if (req.url === '/audio/transcriptions') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ segments: [{ start: 0, end: 5.8, text: '视频原文。Hello from video.' }] })); return; }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (typeof body.input.text === 'string') { synthesisAttempts++; lastSynthesisText = body.input.text; lastSynthesisRate = body.input.rate; synthesisInputs.push(body.input); }
  if (failSynthesisText && body.input.text === failSynthesisText) { res.writeHead(503); res.end(); return; }
  if (errorStatus) { res.writeHead(errorStatus); res.end('private-provider-body-and-secret'); return; }
  res.setHeader('Content-Type', 'application/json');
  if (body.input.action === 'create_voice') {
    creates++; assert.equal(body.model, 'voice-enrollment'); assert.equal(body.input.target_model, 'cosyvoice-v3-flash'); assert.match(body.input.audio, /^data:audio\/wav;base64,UklGR/);
    res.end(JSON.stringify({ output: { voice_id: 'cosyvoice-v3-flash-fieldwork-' + creates } }));
  } else if (body.input.action === 'query_voice') res.end(JSON.stringify({ output: { status: 'OK', target_model: 'cosyvoice-v3-flash' } }));
  else if (body.input.action === 'delete_voice') { voiceDeletes++; assert.equal(body.model, 'voice-enrollment'); res.end(JSON.stringify({ output: {} })); }
  else {
    syntheses++; assert.equal(body.input.format, 'mp3'); assert.equal(body.input.sample_rate, 24000); assert.match(body.input.voice, /^cosyvoice/);
    const effect = beforeSynthesis; beforeSynthesis = undefined; await effect?.();
    res.end(JSON.stringify({ output: { audio: { url: base + '/result.mp3' } } }));
  }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
base = `http://127.0.0.1:${address.port}`; process.env.TTS_BASE_URL = base + '/api/v1'; process.env.ASR_PROVIDER = 'openai'; process.env.ASR_BASE_URL = base; process.env.ASR_API_KEY = 'test-only'; process.env.ASR_MODEL = 'mock-asr';
const store = await import('../src/server/db');
const service = await import('../src/server/service');
const dubbing = await import('../src/server/dubbing');
const { handleApi } = await import('../src/server/http');
const { resultAudioUrl, ttsConfiguration } = await import('../src/server/tts');
const { previewDubbing } = await import('../src/server/dubbing-preview');
const { dubbingTones, dubbingEmotions, dubbingInstruction, resolveDubbingSettings } = await import('../src/shared/dubbing-settings');
afterEach(() => { process.env.TTS_API_KEY = 'test-only'; process.env.ASR_API_KEY = 'test-only'; errorStatus = 0; failDownload = false; failSynthesisText = ''; beforeSynthesis = undefined; });
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await store.db.close(); rmSync(directory, { recursive: true, force: true }); });
function voiceForm(requestId = randomUUID()) {
  const form = new FormData(); form.set('requestId', requestId); form.set('name', '我的日常声音'); form.set('consent', 'true'); form.set('file', new File([readFileSync(sample)], 'voice.wav')); return form;
}
async function readyVoice() { const voice = await dubbing.createVoice(voiceForm()); await dubbing.processNextDubbing(); assert.equal((await store.get('voices', voice.id))?.status, 'ready'); return voice; }
function script(voiceId: string, extra = {}) { return { requestId: randomUUID(), voiceId, title: '中英文朗读', text: '你好，欢迎光临。Hello, welcome to our cafe.', rate: 1.25, ...extra }; }

test('保存音色：确认授权、真实媒体验证、请求去重；上传不直接调用复刻', async () => {
  const form = voiceForm(); form.set('consent', 'false'); await assert.rejects(() => dubbing.createVoice(form));
  const invalid = voiceForm(); invalid.set('file', new File(['bad'], 'voice.wav')); await assert.rejects(() => dubbing.createVoice(invalid), /无法解析/);
  const before = creates, requestId = randomUUID();
  const [a, b] = await Promise.all([dubbing.createVoice(voiceForm(requestId)), dubbing.createVoice(voiceForm(requestId))]);
  assert.equal(a.id, b.id); assert.equal(creates, before); assert.equal((await store.all('voices')).length, 1);
  assert.equal((await store.all('assets')).length, 0); assert.equal((await store.all('merchants')).length, 0); assert.equal((await store.all('projects')).length, 0);
  assert.equal((await store.all('transcription_jobs')).length, 0);
  await dubbing.processNextDubbing(); assert.equal(creates, before + 1);
  assert.equal((await store.get('voices', a.id))?.status, 'ready');
});
test('没有语音凭据时保留样本，配置后继续创建；公开快照不包含服务标识和租约', async () => {
  process.env.TTS_API_KEY = ''; process.env.ASR_API_KEY = '';
  const voice = await dubbing.createVoice(voiceForm()); assert.equal(voice.status, 'waiting_configuration');
  assert.equal(await dubbing.processNextDubbing(), false);
  process.env.TTS_API_KEY = 'test-only'; await dubbing.processNextDubbing();
  const snapshot = await dubbing.dubbingSnapshot(); const saved = snapshot.voices.find(v => v.id === voice.id)!;
  assert.equal(saved.status, 'ready'); assert.ok(!('account' in saved)); assert.ok(!('providerVoiceId' in saved)); assert.ok(!('leaseToken' in saved));
  assert.equal(snapshot.capabilities.tts, true);
});
test('手动文案：同请求并发只生成一次，MP3 入库，试听范围请求和下载有效', async () => {
  const voice = await readyVoice(), payload = script(voice.id), before = syntheses;
  const [one, two] = await Promise.all([dubbing.enqueueDubbing(payload), dubbing.enqueueDubbing(payload)]); assert.equal(one.id, two.id);
  assert.equal(syntheses, before); await Promise.all([dubbing.processNextDubbing(), dubbing.processNextDubbing()]); assert.equal(syntheses, before + 1);
  const saved = (await store.get('dubbings', one.id))!; assert.equal(saved.status, 'completed'); assert.ok(saved.hasAudio); assert.equal(saved.audioUrl, null);
  const audio = saved.output!; assert.ok(audio.duration! > 5); assert.equal(saved.text, payload.text);
  const streamed = await handleApi(new Request('http://localhost/api/dubbing-files/' + saved.id, { headers: { Range: 'bytes=0-15' } }), ['dubbing-files', saved.id]); assert.equal(streamed.status, 206); assert.equal((await streamed.arrayBuffer()).byteLength, 16);
  const download = await handleApi(new Request('http://localhost/api/dubbing-files/' + saved.id + '?download'), ['dubbing-files', saved.id]); assert.match(download.headers.get('Content-Disposition')!, /^attachment/); assert.equal(download.headers.get('Content-Type'), 'audio/mpeg');
  const foreign = { ...payload, text: '同一个编号不能换内容' }; await assert.rejects(() => dubbing.enqueueDubbing(foreign), /请求编号/);
  assert.equal((await store.all('assets')).length, 0);
});
test('独立视频提取：不需要商家和项目，文案提取后可校对生成', async () => {
  const voice = await readyVoice();
  const form = new FormData(); form.set('requestId', randomUUID()); form.set('consent', 'true'); form.set('file', new File([readFileSync(sample)], 'source.wav'));
  const source = await dubbing.uploadDubbingSource(form);
  await assert.rejects(() => dubbing.enqueueDubbing(script(voice.id, { sourceId: source.id })), /转写文案/);
  await dubbing.processNextDubbing(); assert.equal((await store.get('dubbing_sources', source.id))?.status, 'completed');
  const job = await dubbing.enqueueDubbing(script(voice.id, { sourceId: source.id, text: '校对后的文案。Hello.' }));
  await dubbing.processNextDubbing(); const saved = (await store.get('dubbings', job.id))!;
  assert.equal(saved.status, 'completed'); assert.equal(saved.text, '校对后的文案。Hello.');
  for (const table of ['merchants', 'projects', 'assets', 'contents'] as const) assert.equal((await store.all(table)).length, 0);
  assert.ok(!('projectId' in saved));
});
test('下载失败可重试已保存的结果地址，不重复调用付费合成', async () => {
  const voice = await readyVoice(), job = await dubbing.enqueueDubbing(script(voice.id)); failDownload = true;
  const before = syntheses; await dubbing.processNextDubbing(); assert.equal((await store.get('dubbings', job.id))?.status, 'failed');
  assert.ok((await store.get('dubbings', job.id))?.audioUrl); assert.equal(syntheses, before + 1);
  failDownload = false; await dubbing.retryDubbing(job.id); await dubbing.processNextDubbing(); assert.equal((await store.get('dubbings', job.id))?.status, 'completed'); assert.equal(syntheses, before + 1);
});
test('进程中断：未知付费结果不自动重提，已知音色编号可恢复查询', async () => {
  const voice = await readyVoice(), job = await dubbing.enqueueDubbing(script(voice.id));
  const stored = (await store.get('dubbings', job.id))!;
  await store.put('dubbings', { ...stored, status: 'processing', submissionStarted: true, leaseToken: 'dead-process', leaseUntil: Date.now() - 1 });
  const before = syntheses; await dubbing.processNextDubbing(); assert.equal(syntheses, before); assert.match((await store.get('dubbings', job.id))?.error || '', /未确认/);
  const savedVoice = (await store.get('voices', voice.id))!;
  await store.put('voices', { ...savedVoice, status: 'processing', leaseToken: 'dead-process', leaseUntil: 0, runAt: 0 });
  const voicesBefore = creates; await dubbing.processNextDubbing(); assert.equal(creates, voicesBefore); assert.equal((await store.get('voices', voice.id))?.status, 'ready');
});
test('服务错误脱敏，不静默返回假音频；账户变更与不可信下载地址被拒绝', async () => {
  const voice = await readyVoice(); process.env.TTS_API_KEY = 'other-account';
  await assert.rejects(() => dubbing.enqueueDubbing(script(voice.id)), /配置已变化/); process.env.TTS_API_KEY = 'test-only';
  for (const url of ['http://127.0.0.1:9999/secret', 'file:///etc/passwd', 'https://example.com/fake.mp3', 'https://a.aliyuncs.com:1234/a']) assert.throws(() => resultAudioUrl(url, ttsConfiguration()!), /地址/);
  const job = await dubbing.enqueueDubbing(script(voice.id)); errorStatus = 503; await dubbing.processNextDubbing();
  const failed = (await store.get('dubbings', job.id))!; assert.equal(failed.status, 'failed'); assert.match(failed.error!, /503/); assert.ok(!failed.error?.includes('secret')); assert.equal(failed.output, null);
});
test('个人音色与配音接口继承团队登录和写请求来源校验', async () => {
  process.env.HUB_ACCESS_TOKEN = 'private-test-token';
  try {
    const res = await handleApi(new Request('http://localhost/api/voices', { method: 'POST', body: voiceForm() }), ['voices']); assert.equal(res.status, 401);
    const foreign = await handleApi(new Request('http://localhost/api/dubbings', { method: 'POST', headers: { authorization: 'Bearer private-test-token', origin: 'https://foreign.example' }, body: '{}' }), ['dubbings']); assert.equal(foreign.status, 403);
  } finally { delete process.env.HUB_ACCESS_TOKEN; }
});

test('生成前试听：只发送开头、裁剪约5秒，不保存正式记录或媒体，重复试听复用结果', async () => {
  const voice = await readyVoice();
  const payload = { requestId: randomUUID(), voiceId: voice.id, text: '你好，这是试听文案。Hello, this is the opening passage. '.repeat(15) + '尾部不应该发送', rate: 1.25 };
  const historyCount = (await store.all('dubbings')).length, files = readdirSync(join(directory, 'data', 'uploads')).sort();
  const temporary = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('dubbing-preview-')));
  const before = synthesisAttempts;
  const [one, two] = await Promise.all([previewDubbing(payload), previewDubbing(payload)]);
  assert.deepEqual(one, two); assert.equal(synthesisAttempts, before + 1);
  assert.ok(payload.text.startsWith(lastSynthesisText)); assert.ok(lastSynthesisText.length < payload.text.length); assert.ok(!lastSynthesisText.includes('尾部不应该发送'));
  assert.equal(lastSynthesisRate, 1.25);
  const path = join(directory, 'preview.mp3'); writeFileSync(path, one);
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path], { encoding: 'utf8' }));
  assert.ok(duration > 4.8 && duration < 5.2);
  assert.equal((await store.all('dubbings')).length, historyCount); assert.deepEqual(readdirSync(join(directory, 'data', 'uploads')).sort(), files);
  assert.equal(readdirSync(tmpdir()).filter(name => name.startsWith('dubbing-preview-') && !temporary.has(name)).length, 0);
  await previewDubbing({ ...payload, requestId: randomUUID() }); assert.equal(synthesisAttempts, before + 1);
  await previewDubbing({ ...payload, requestId: randomUUID(), rate: 0.75 }); assert.equal(synthesisAttempts, before + 2); assert.equal(lastSynthesisRate, 0.75);
  const response = await handleApi(new Request('http://localhost/api/dubbings/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }), ['dubbings', 'preview']);
  assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'audio/mpeg'); assert.match(response.headers.get('Cache-Control')!, /no-store/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), one); assert.equal(synthesisAttempts, before + 2);
});
test('试听参数与收费保护：冲突请求、失败重放、未就绪音色与缺少配置均不会意外重提', async () => {
  const voice = await readyVoice(), requestId = randomUUID(), before = synthesisAttempts;
  const payload = { requestId, voiceId: voice.id, text: '并发试听参数甲。', rate: 1 };
  const results = await Promise.allSettled([previewDubbing(payload), previewDubbing({ ...payload, text: '并发试听参数乙。' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(synthesisAttempts, before + 1);
  const conflict = results.find(r => r.status === 'rejected'); assert.ok(conflict && conflict.status === 'rejected' && conflict.reason.status === 409);
  const failed = { ...payload, requestId: randomUUID(), text: '试听服务错误的文案。' }; errorStatus = 503;
  await assert.rejects(() => previewDubbing(failed), /503/); const attempts = synthesisAttempts; errorStatus = 0;
  await assert.rejects(() => previewDubbing(failed), /503/); assert.equal(synthesisAttempts, attempts);
  await previewDubbing({ ...failed, requestId: randomUUID() }); assert.equal(synthesisAttempts, attempts + 1);
  const queuedVoice = await dubbing.createVoice(voiceForm());
  await assert.rejects(() => previewDubbing({ ...payload, voiceId: queuedVoice.id, requestId: randomUUID() }), /已创建完成/);
  await dubbing.processNextDubbing();
  process.env.TTS_API_KEY = ''; process.env.ASR_API_KEY = '';
  await assert.rejects(() => previewDubbing({ ...payload, requestId: randomUUID() }), /尚未配置/);
});

test('表达设置：试听与完整生成的供应商参数相同，记录保存语调、情感及音高', async () => {
  const voice = await readyVoice();
  const settings = { rate: 0.75, pitch: 1.1, tone: 'storytelling' as const, emotion: 'warm' as const };
  const text = '这是需要保留个人音色的测试文案。Hello, this is an expressive reading. '.repeat(6);
  await previewDubbing({ requestId: randomUUID(), voiceId: voice.id, text, ...settings });
  const previewInput = synthesisInputs.at(-1)!;
  assert.equal(previewInput.instruction, '用讲故事的语调，句间停顿自然。语气温暖亲切。');
  assert.equal(previewInput.pitch, 1.1); assert.equal(previewInput.rate, 0.75);
  const job = await dubbing.enqueueDubbing(script(voice.id, { text, ...settings })); await dubbing.processNextDubbing();
  const fullInput = synthesisInputs.at(-1)!;
  const { text: previewText, ...previewParameters } = previewInput, { text: fullText, ...fullParameters } = fullInput;
  assert.notEqual(previewText, fullText); assert.deepEqual(previewParameters, fullParameters);
  const saved = (await store.get('dubbings', job.id))!;
  assert.equal(saved.status, 'completed'); for (const [key, value] of Object.entries(settings)) assert.equal(saved[key as keyof typeof saved], value);
  const snapshot = await dubbing.dubbingSnapshot(); const published = snapshot.dubbings.find(d => d.id === job.id)!;
  assert.equal(published.tone, 'storytelling'); assert.equal(published.emotion, 'warm'); assert.equal(published.pitch, 1.1);
  const before = synthesisAttempts;
  await previewDubbing({ requestId: randomUUID(), voiceId: voice.id, text, ...settings }); assert.equal(synthesisAttempts, before);
  for (const change of [{ pitch: 0.9 }, { tone: 'broadcast' as const }, { emotion: 'excited' as const }]) await previewDubbing({ requestId: randomUUID(), voiceId: voice.id, text, ...settings, ...change });
  assert.equal(synthesisAttempts, before + 3);
});
test('表达设置：非法值和不支持指令的音色在付费请求前拒绝，预设不超过供应商限制', async () => {
  const voice = await readyVoice(), before = synthesisAttempts;
  for (const change of [{ tone: 'unknown' }, { emotion: 'unknown' }, { pitch: 0.4 }, { pitch: 2.1 }, { pitch: Number.NaN }, { instruction: '不允许直接注入任意指令' }]) {
    await assert.rejects(() => previewDubbing({ requestId: randomUUID(), voiceId: voice.id, text: '参数校验。', rate: 1, ...change }));
    await assert.rejects(() => dubbing.enqueueDubbing(script(voice.id, change)));
  }
  const unsupported = { ...(await store.get('voices', voice.id))!, id: randomUUID(), model: 'cosyvoice-v3-plus' }; await store.put('voices', unsupported);
  await assert.rejects(() => previewDubbing({ requestId: randomUUID(), voiceId: unsupported.id, text: '模型能力校验。', tone: 'conversational' }), /不支持语调和情感/);
  await assert.rejects(() => dubbing.enqueueDubbing(script(unsupported.id, { emotion: 'happy' })), /不支持语调和情感/);
  assert.equal(synthesisAttempts, before);
  for (const tone of dubbingTones) for (const emotion of dubbingEmotions) {
    const instruction = dubbingInstruction(resolveDubbingSettings({ tone, emotion }));
    const weighted = Array.from(instruction).reduce((sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 2 : 1), 0); assert.ok(weighted <= 100);
  }
});
test('表达设置：重试保留原设置，历史记录缺少新字段时按默认值兼容且可重放请求', async () => {
  const voice = await readyVoice(), payload = script(voice.id, { rate: 1.25, pitch: 0.9, tone: 'broadcast', emotion: 'serious' });
  const job = await dubbing.enqueueDubbing(payload); errorStatus = 503; await dubbing.processNextDubbing();
  assert.equal((await store.get('dubbings', job.id))?.status, 'failed');
  const failedInput = synthesisInputs.at(-1); errorStatus = 0; await dubbing.retryDubbing(job.id); await dubbing.processNextDubbing();
  assert.deepEqual(synthesisInputs.at(-1), failedInput); assert.equal((await store.get('dubbings', job.id))?.emotion, 'serious');
  const historicalPayload = script(voice.id); const historical = await dubbing.enqueueDubbing(historicalPayload); await dubbing.processNextDubbing();
  const record = (await store.get('dubbings', historical.id))!; delete record.tone; delete record.emotion; delete record.pitch; await store.put('dubbings', record);
  const before = synthesisAttempts, replayed = await dubbing.enqueueDubbing(historicalPayload);
  assert.equal(replayed.tone, 'natural'); assert.equal(replayed.emotion, 'neutral'); assert.equal(replayed.pitch, 1); assert.equal(synthesisAttempts, before);
  const publicRecord = (await dubbing.dubbingSnapshot()).dubbings.find(d => d.id === record.id)!; assert.equal(publicRecord.pitch, 1);
});

test('逐句试听与完整配音共用有效设置及片段缓存，单句修改只重合成该句，停顿实际入音频', async () => {
  const voice = await readyVoice(), before = synthesisAttempts;
  const parts = [
    { id: randomUUID(), text: '你好，先自然地说一句。', pauseAfterMs: 200 },
    { id: randomUUID(), text: '这一句需要重点强调。', settings: { tone: 'emphasis' as const, emotion: 'serious' as const } },
    { id: randomUUID(), text: '别着急，我们轻松慢慢说。', settings: { tone: 'conversational' as const, emotion: 'relaxed' as const, rate: 0.85 }, pauseAfterMs: 500 }
  ];
  const payload = { voiceId: voice.id, text: parts.map(p => p.text).join('\n'), parts, rate: 1.25, pitch: 1.1, tone: 'natural', emotion: 'neutral' };
  const count = (await store.all('dubbings')).length, files = readdirSync(join(directory, 'data', 'uploads')).sort();
  await previewDubbing({ ...payload, requestId: randomUUID(), scope: 'sentence', partId: parts[1].id });
  assert.equal(synthesisAttempts, before + 1); assert.equal(lastSynthesisText, parts[1].text); assert.equal(synthesisInputs.at(-1)?.pitch, 1.1); assert.match(String(synthesisInputs.at(-1)?.instruction), /重点突出/);
  const preview = await previewDubbing({ ...payload, requestId: randomUUID(), scope: 'context', partId: parts[1].id });
  assert.equal(synthesisAttempts, before + 3); assert.equal(lastSynthesisRate, 0.85); assert.match(String(synthesisInputs.at(-1)?.instruction), /轻松自然/);
  assert.equal((await store.all('dubbings')).length, count); assert.deepEqual(readdirSync(join(directory, 'data', 'uploads')).sort(), files);
  const modified = { ...payload, parts: parts.map((p, i) => i === 2 ? { ...p, settings: { ...p.settings, rate: 0.75 } } : p) };
  await previewDubbing({ ...modified, requestId: randomUUID(), scope: 'sentence', partId: parts[1].id }); assert.equal(synthesisAttempts, before + 3);
  await previewDubbing({ ...modified, requestId: randomUUID(), scope: 'context', partId: parts[1].id }); assert.equal(synthesisAttempts, before + 4); assert.equal(lastSynthesisRate, 0.75);
  const job = await dubbing.enqueueDubbing({ ...modified, title: '逐句合成', requestId: randomUUID() });
  assert.equal((await dubbing.enqueueDubbing({ ...modified, title: '逐句合成', requestId: job.id })).id, job.id);
  await dubbing.processNextDubbing(); assert.equal(synthesisAttempts, before + 4);
  const saved = (await store.get('dubbings', job.id))!; assert.equal(saved.status, 'completed'); assert.deepEqual(saved.parts, modified.parts);
  assert.ok(saved.output!.duration! > 18.6 && saved.output!.duration! < 19);
  const previewPath = join(directory, 'context.mp3'); writeFileSync(previewPath, preview);
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', previewPath], { encoding: 'utf8' })); assert.ok(duration > 18.6 && duration < 19);
  const published = (await dubbing.dubbingSnapshot()).dubbings.find(d => d.id === job.id)!;
  assert.equal(published.completedParts, 3); assert.ok(!('clipResults' in published)); assert.ok(!('audioUrl' in published));
  const pauseOnly = { ...modified, parts: modified.parts.map((p, i) => i === 0 ? { ...p, pauseAfterMs: 1000 } : p) };
  await previewDubbing({ ...pauseOnly, requestId: randomUUID(), scope: 'context', partId: parts[1].id }); assert.equal(synthesisAttempts, before + 4);
});
test('逐句收费保护：失败后保留已完成片段，未知提交不自动重提，手动重试只处理未完成句子', async () => {
  const voice = await readyVoice();
  const parts = [{ id: randomUUID(), text: '这句已完成，无需重复收费。' }, { id: randomUUID(), text: '这句模拟合成失败。', settings: { emotion: 'relaxed' as const, rate: 0.85 } }];
  const job = await dubbing.enqueueDubbing(script(voice.id, { text: parts.map(p => p.text).join('\n'), parts }));
  const before = synthesisAttempts; failSynthesisText = parts[1].text; await dubbing.processNextDubbing();
  let saved = (await store.get('dubbings', job.id))!; assert.equal(saved.status, 'failed'); assert.ok(saved.clipResults?.[0].output); assert.equal(synthesisAttempts, before + 2);
  assert.equal((await dubbing.dubbingSnapshot()).dubbings.find(d => d.id === job.id)?.completedParts, 1);
  await store.put('dubbings', { ...saved, status: 'processing', leaseToken: 'dead-process', leaseUntil: 0, runAt: 0 });
  failSynthesisText = ''; await dubbing.processNextDubbing(); assert.equal(synthesisAttempts, before + 2);
  saved = (await store.get('dubbings', job.id))!; assert.match(saved.error!, /第 2 句.*未确认/);
  await dubbing.retryDubbing(job.id); await dubbing.processNextDubbing(); saved = (await store.get('dubbings', job.id))!;
  assert.equal(saved.status, 'completed'); assert.equal(synthesisAttempts, before + 3); assert.equal(synthesisInputs.at(-1)?.rate, 0.85);
  assert.deepEqual(saved.parts, parts);
});
test('逐句下载失败可恢复已知结果地址；非法局部参数和不支持的模型在合成前拒绝', async () => {
  const voice = await readyVoice(), parts = [{ id: randomUUID(), text: '这一句验证下载恢复。', settings: { emotion: 'warm' as const } }];
  const payload = script(voice.id, { text: parts[0].text, parts });
  const before = synthesisAttempts; failDownload = true;
  const job = await dubbing.enqueueDubbing(payload); await dubbing.processNextDubbing();
  assert.ok((await store.get('dubbings', job.id))?.clipResults?.[0].audioUrl); assert.equal(synthesisAttempts, before + 1);
  failDownload = false; await dubbing.retryDubbing(job.id); await dubbing.processNextDubbing(); assert.equal((await store.get('dubbings', job.id))?.status, 'completed'); assert.equal(synthesisAttempts, before + 1);
  const unsupported = { ...(await store.get('voices', voice.id))!, id: randomUUID(), model: 'cosyvoice-v3-plus' }; await store.put('voices', unsupported);
  await assert.rejects(() => dubbing.enqueueDubbing({ ...payload, voiceId: unsupported.id, requestId: randomUUID() }), /不支持语调和情感/);
  await assert.rejects(() => previewDubbing({ requestId: randomUUID(), voiceId: unsupported.id, text: parts[0].text, parts, scope: 'sentence', partId: parts[0].id }), /不支持语调和情感/);
  await assert.rejects(() => dubbing.enqueueDubbing({ ...payload, requestId: randomUUID(), parts: [{ ...parts[0], settings: { rate: 9 } }] }));
  await assert.rejects(() => previewDubbing({ requestId: randomUUID(), voiceId: voice.id, text: parts[0].text, parts, scope: 'sentence', partId: randomUUID() }), /请选择/);
  assert.equal(synthesisAttempts, before + 1);
});

test('删除音色同步清理云端和录音，重复删除幂等，已完成配音继续播放下载', async () => {
  const voice = await readyVoice(), sampleKey = (await store.get('voices', voice.id))!.sample.storageKey;
  const job = await dubbing.enqueueDubbing(script(voice.id)); await dubbing.processNextDubbing();
  const before = voiceDeletes;
  const response = await handleApi(new Request('http://localhost/api/voices/' + voice.id, { method: 'DELETE' }), ['voices', voice.id]); assert.equal(response.status, 202);
  assert.equal((await dubbing.dubbingSnapshot()).voices.find(v => v.id === voice.id)?.status, 'deleting');
  await assert.rejects(() => dubbing.readyDubbingVoice(voice.id), /请选择/);
  await assert.rejects(() => dubbing.enqueueDubbing(script(voice.id)), /请选择/);
  await dubbing.deleteVoice(voice.id); await dubbing.processNextDubbing(); assert.equal(voiceDeletes, before + 1);
  assert.equal(await store.get('voices', voice.id), undefined); assert.throws(() => readFileSync(join(directory, 'data', 'uploads', sampleKey)));
  assert.deepEqual(await dubbing.deleteVoice(voice.id), { deleted: true }); assert.equal(voiceDeletes, before + 1);
  const audio = await handleApi(new Request('http://localhost/api/dubbing-files/' + job.id + '?download'), ['dubbing-files', job.id]); assert.equal(audio.status, 200); assert.ok((await audio.arrayBuffer()).byteLength > 100);
});
test('创建中或有活动配音的音色不能删除；未创建的本地样本不需要语音凭据即可删除', async () => {
  const voice = await readyVoice(), original = (await store.get('voices', voice.id))!;
  await store.put('voices', { ...original, status: 'processing' }); await assert.rejects(() => dubbing.deleteVoice(voice.id), /正在处理/);
  await store.put('voices', original); const job = await dubbing.enqueueDubbing(script(voice.id)); await assert.rejects(() => dubbing.deleteVoice(voice.id), /正在生成配音/);
  await dubbing.processNextDubbing(); assert.equal((await store.get('dubbings', job.id))?.status, 'completed');
  process.env.TTS_API_KEY = ''; process.env.ASR_API_KEY = '';
  const local = await dubbing.createVoice(voiceForm()); const before = voiceDeletes;
  assert.deepEqual(await dubbing.deleteVoice(local.id), { deleted: true }); assert.equal(await store.get('voices', local.id), undefined); assert.equal(voiceDeletes, before);
});
test('云端删除失败保留音色及录音可重试，恢复已确认云删除任务不会再次创建或删除云音色', async () => {
  const voice = await readyVoice(), createCount = creates;
  await dubbing.deleteVoice(voice.id); errorStatus = 503; await dubbing.processNextDubbing();
  let saved = (await store.get('voices', voice.id))!; assert.equal(dubbing.publicVoice(saved).status, 'delete_failed'); assert.ok(readFileSync(join(directory, 'data', 'uploads', saved.sample.storageKey)).length);
  await assert.rejects(() => dubbing.retryVoice(voice.id), /重试删除/);
  errorStatus = 0; await dubbing.deleteVoice(voice.id); await dubbing.processNextDubbing(); assert.equal(await store.get('voices', voice.id), undefined); assert.equal(creates, createCount);
  const resumed = await readyVoice(); saved = (await store.get('voices', resumed.id))!;
  await store.put('voices', { ...saved, status: 'processing', deleteRequestedAt: new Date().toISOString(), remoteDeletedAt: new Date().toISOString(), leaseToken: 'old-process', leaseUntil: 0, runAt: 0 });
  const before = voiceDeletes; await dubbing.processNextDubbing(); assert.equal(await store.get('voices', resumed.id), undefined); assert.equal(voiceDeletes, before);
});
test('音色删除接口继承访问口令和来源校验', async () => {
  const voice = await readyVoice(); process.env.HUB_ACCESS_TOKEN = 'private-test-token';
  try {
    const unauthenticated = await handleApi(new Request('http://localhost/api/voices/' + voice.id, { method: 'DELETE' }), ['voices', voice.id]); assert.equal(unauthenticated.status, 401);
    const crossOrigin = await handleApi(new Request('http://localhost/api/voices/' + voice.id, { method: 'DELETE', headers: { Authorization: 'Bearer private-test-token', Origin: 'https://foreign.example' } }), ['voices', voice.id]); assert.equal(crossOrigin.status, 403);
    assert.ok(await store.get('voices', voice.id));
  } finally { delete process.env.HUB_ACCESS_TOKEN; }
});

test('工作台按项目生成配音与转写，音色可复用，入库后可下载并保留逐字稿', async () => {
  const { saveToolAsset } = await import('../src/server/tool-assets');
  const merchant = await service.createMerchant({ name: '录音团队', industry: '餐饮', city: '杭州' });
  const [first, second] = await Promise.all(['春', '夏'].map(name => service.createProject({ merchantId: merchant.id, name, mode: 'shoot', dueDate: '', deliverables: 1 })));
  const voice = await readyVoice();
  const form = voiceForm();
  form.set('projectId', first.id);
  const source = await dubbing.uploadDubbingSource(form);
  await dubbing.processNextDubbing();
  assert.equal((await store.get('dubbing_sources', source.id))?.status, 'completed');
  const payload = { ...script(voice.id), projectId: first.id, sourceId: source.id };
  await assert.rejects(() => dubbing.enqueueDubbing({ ...payload, projectId: second.id }), /其他项目/);
  const job = await dubbing.enqueueDubbing(payload);
  await assert.rejects(() => dubbing.enqueueDubbing({ ...payload, projectId: undefined }), /编号/);
  await dubbing.processNextDubbing();
  const other = await dubbing.dubbingSnapshot(second.id);
  assert.ok(other.voices.some(v => v.id === voice.id));
  assert.ok(!other.sources.some(s => s.id === source.id) && !other.dubbings.some(d => d.id === job.id));
  const asset = await saveToolAsset(first.id, { type: 'dubbing', id: job.id });
  const textAsset = await saveToolAsset(first.id, { type: 'dubbing-source', id: source.id });
  assert.equal(asset.projectId, first.id);
  assert.equal(asset.segments[0].text, payload.text);
  assert.equal(textAsset.segments[0].text, '视频原文。Hello from video.');
  assert.equal(textAsset.transcriptSource, 'asr');
  const response = await handleApi(new Request('http://localhost/api/files/' + asset.id), ['files', asset.id]);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(mp3));
  await assert.rejects(() => saveToolAsset(second.id, { type: 'dubbing', id: job.id }), /其他项目/);
});
