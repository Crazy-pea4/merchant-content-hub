import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asrConfiguration, normalizeAliyunTranscript, submitAliyunAudio, waitForAliyunTranscript, type AsrConfig } from '../src/server/asr';

const config: AsrConfig = { provider: 'aliyun', key: 'test-key', model: 'qwen-audio-3.1-asr-flash-filetrans', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', timeoutMs: 10000 };
const transcript = { transcripts: [{ sentences: [{ begin_time: 35000, end_time: 41000, text: '老板介绍开店故事。', speaker_id: 0, words: [{ begin_time: 35000, end_time: 36000, text: '老板', punctuation: '' }, { begin_time: 36000, end_time: 38000, text: '介绍', punctuation: '' }, { begin_time: 38000, end_time: 41000, text: '开店故事', punctuation: '。' }] }] }] };
function backend({ failQuery = false, failedFile = false, statuses = ['SUCCEEDED'], onQuery = () => {} }: { failQuery?: boolean; failedFile?: boolean; statuses?: string[]; onQuery?: () => void } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let uploadedKey = '';
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    const headers = new Headers(init?.headers);
    if (url.includes('/uploads?')) {
      assert.equal(headers.get('authorization'), 'Bearer test-key');
      assert.equal(new URL(url).searchParams.get('model'), config.model);
      return Response.json({ data: { upload_host: 'https://upload.oss-cn-beijing.aliyuncs.com', upload_dir: 'test-only', oss_access_key_id: 'temporary-only', signature: 'signature', policy: 'policy', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true', max_file_size_mb: 128 } });
    }
    if (url.includes('upload.oss')) {
      assert.equal(headers.get('authorization'), null);
      assert.ok(init?.body instanceof FormData);
      uploadedKey = String(init.body.get('key'));
      assert.match(uploadedKey, /^test-only\/[\w-]+\.flac$/);
      assert.ok(init.body.get('file') instanceof File);
      return new Response(null, { status: 200 });
    }
    if (url.endsWith('/services/audio/asr/transcription')) {
      assert.equal(headers.get('authorization'), 'Bearer test-key');
      assert.equal(headers.get('x-dashscope-async'), 'enable');
      assert.equal(headers.get('x-dashscope-ossresourceresolve'), 'enable');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, config.model); assert.deepEqual(body.input.file_urls, ['oss://' + uploadedKey]);
      assert.equal(body.parameters.diarization_enabled, true);
      return Response.json({ output: { task_id: 'task-1', task_status: 'PENDING' } });
    }
    if (url.includes('/tasks/')) {
      assert.equal(headers.get('authorization'), 'Bearer test-key'); onQuery();
      if (failQuery) { failQuery = false; throw new Error('network-private-detail'); }
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
      return Response.json({ output: { task_status: status, results: [{ subtask_status: failedFile ? 'FAILED' : 'SUCCEEDED', transcription_url: 'https://result.oss-cn-beijing.aliyuncs.com/transcript.json' }] } });
    }
    if (url.includes('result.oss')) {
      assert.equal(headers.get('authorization'), null);
      assert.equal(init?.redirect, 'error');
      return Response.json(transcript);
    }
    throw new Error('Unexpected test URL');
  };
  return { fetcher, calls };
}
test('百炼结果：毫秒转秒，保留词级起止时间、标点与说话人，兼容缺词级数据', () => {
  const [segment] = normalizeAliyunTranscript(transcript);
  assert.equal(segment.start, 35); assert.equal(segment.end, 41); assert.equal(segment.speakerId, 0);
  assert.deepEqual(segment.words?.at(-1), { start: 38, end: 41, text: '开店故事', punctuation: '。' });
  assert.deepEqual(normalizeAliyunTranscript({ transcripts: [{ sentences: [{ begin_time: 0, end_time: 1000, text: '完整句子' }] }] }), [{ start: 0, end: 1, text: '完整句子' }]);
});
test('百炼结果：过滤非法时间，不将纯文字伪造成时间码', () => {
  for (const value of [null, {}, { transcripts: [] }, { transcripts: [{ sentences: [{ begin_time: -1, end_time: 1000, text: '错误' }, { begin_time: '0', end_time: 1000, text: '错误' }, { text: '无时间' }] }] }]) assert.throws(() => normalizeAliyunTranscript(value), /百炼/);
});
test('百炼协议：上传授权、本地文件上传和异步提交的模型一致，存储请求不携带 API Key', async () => {
  const mock = backend();
  assert.equal(await submitAliyunAudio(config, new Uint8Array([1, 2, 3]), 'test.flac', mock), 'task-1');
  assert.equal(mock.calls.length, 3);
});
test('百炼协议：轮询直到完成，下载并转换句词时间码', async () => {
  const mock = backend({ statuses: ['PENDING', 'RUNNING', 'SUCCEEDED'] });
  const segments = await waitForAliyunTranscript({ ...config, timeoutMs: 10000 }, 'task-1', { ...mock, sleep: async () => {} });
  assert.equal(segments[0].start, 35); assert.equal(mock.calls.filter(c => c.url.includes('/tasks/')).length, 3);
});
test('百炼协议：整体成功但文件失败时，拒绝覆盖现有文字', async () => {
  await assert.rejects(() => waitForAliyunTranscript(config, 'task-1', backend({ failedFile: true })), /文件转写失败/);
});
test('百炼协议：终态失败与等待超时均明确报错', async () => {
  await assert.rejects(() => waitForAliyunTranscript(config, 'task-1', backend({ statuses: ['FAILED'] })), /任务失败/);
  let time = 0; const mock = backend({ statuses: ['RUNNING'] });
  await assert.rejects(() => waitForAliyunTranscript(config, 'task-1', { ...mock, now: () => time, sleep: async ms => { time += ms; } }), /不会重复提交/);
});
test('百炼协议：不泄漏上游正文、签名或密钥；拒绝不可信结果地址', async () => {
  await assert.rejects(() => submitAliyunAudio(config, new Uint8Array(), 'test.flac', { fetcher: async () => Response.json({ code: 'InvalidApiKey', message: 'private key and signature' }, { status: 401 }) }), error => error instanceof Error && error.message.includes('401') && !error.message.includes('private'));
  const bad: typeof fetch = async () => Response.json({ output: { task_status: 'SUCCEEDED', results: [{ subtask_status: 'SUCCEEDED', transcription_url: 'http://127.0.0.1/private' }] } });
  await assert.rejects(() => waitForAliyunTranscript(config, 'task-1', { fetcher: bad }), /存储地址/);
});

const directory = mkdtempSync(join(tmpdir(), 'fieldwork-asr-'));
process.env.DB_DRIVER = 'sqlite';
process.env.DATA_DIR = join(directory, 'data'); process.env.SEED_DEMO = 'false';
process.env.ASR_PROVIDER = 'aliyun'; process.env.ASR_API_KEY = 'test-key'; process.env.ASR_MODEL = config.model; process.env.ASR_BASE_URL = config.baseUrl;
const store = await import('../src/server/db'); const svc = await import('../src/server/service');
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; (await store.db.close()); rmSync(directory, { recursive: true, force: true }); });
const merchant = (await svc.createMerchant({ name: '隔离测试', industry: '咖啡', city: '测试' }));
const project = (await svc.createProject({ merchantId: merchant.id, name: '测试', mode: 'shoot', dueDate: '', deliverables: 1 }));
const audio = join(directory, 'sample.wav'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', audio]);
async function asset() {
  const form = new FormData(); form.set('projectId', project.id); form.set('rights', 'authorized'); form.set('file', new File([readFileSync(audio)], 'test.wav'));
  return (await svc.upload(form));
}
function install(mock: ReturnType<typeof backend>) { globalThis.fetch = mock.fetcher; }
test('百炼配置：独立 Key、北京默认地址，拒绝把文本兼容接口当 ASR', () => {
  assert.equal(asrConfiguration()?.provider, 'aliyun');
  process.env.ASR_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  assert.throws(asrConfiguration, /compatible-mode/); process.env.ASR_BASE_URL = config.baseUrl;
});
test('服务：网络中断保留任务，重试仅查询；入库后索引编辑保留词级时间', async () => {
  const a = await asset(); const mock = backend({ failQuery: true }); install(mock);
  await assert.rejects(() => svc.runTranscription(a.id), /连接失败/);
  assert.equal((await store.get('asr_jobs', a.id))?.taskId, 'task-1'); assert.deepEqual((await store.get('assets', a.id))?.segments, []);
  const updated = await svc.runTranscription(a.id);
  assert.equal(mock.calls.filter(c => c.url.includes('/uploads?')).length, 1);
  assert.equal(mock.calls.filter(c => c.url.endsWith('/services/audio/asr/transcription')).length, 1);
  assert.equal(updated.transcriptSource, 'asr'); assert.equal(updated.segments[0].words?.length, 3);
  assert.deepEqual((await svc.updateAsset(a.id, { note: '只修改备注' })).segments, updated.segments);
  assert.equal((await store.get('asr_jobs', a.id)), undefined);
  assert.ok((await svc.search(project.id, '开店故事')).some(hit => hit.asset.id === a.id && hit.segment?.start === 35));
});
test('服务：并发点击共享同一任务，不重复提交收费请求', async () => {
  const a = await asset(); const mock = backend(); install(mock);
  const [one, two] = await Promise.all([svc.runTranscription(a.id), svc.runTranscription(a.id)]);
  assert.deepEqual(one, two); assert.equal(mock.calls.filter(c => c.url.endsWith('/services/audio/asr/transcription')).length, 1);
});
test('服务：转写期间人工修改后不覆盖，明确返回冲突', async () => {
  const a = await asset(); const mock = backend({ onQuery: async () => { (await svc.updateAsset(a.id, { transcript: '人工修改后的原稿' })); } }); install(mock);
  await assert.rejects(() => svc.runTranscription(a.id), /已被修改/);
  assert.equal((await store.get('assets', a.id))?.segments[0].text, '人工修改后的原稿');
});
test('服务：未授权不上传，终态失败清理任务并保留原稿', async () => {
  const a = await asset(); (await svc.updateAsset(a.id, { rights: 'pending' }));
  const mock = backend({ failedFile: true }); install(mock);
  await assert.rejects(() => svc.runTranscription(a.id), /确认素材授权/); assert.equal(mock.calls.length, 0);
  (await svc.updateAsset(a.id, { rights: 'authorized', transcript: '原稿不可丢失' }));
  await assert.rejects(() => svc.runTranscription(a.id), /文件转写失败/);
  assert.equal((await store.get('asr_jobs', a.id)), undefined); assert.equal((await store.get('assets', a.id))?.segments[0].text, '原稿不可丢失');
});

test('粗剪：词级时间随视频区间一起平移并裁去区间外词语', async () => {
  const path = join(directory, 'video.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=160x120:r=24:d=5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path]);
  const form = new FormData(); form.set('projectId', project.id); form.set('rights', 'authorized'); form.set('file', new File([readFileSync(path)], 'clip.mp4'));
  const a = await svc.upload(form);
  (await store.put('assets', { ...a, segments: [{ start: 0.5, end: 4.5, text: '区间测试', speakerId: 1, words: [{ start: 0.5, end: 1.5, text: '前' }, { start: 2, end: 3, text: '中' }, { start: 4, end: 4.5, text: '后' }] }] }));
  const cut = await svc.cutAsset(a.id, { start: 1, end: 4 });
  assert.equal(cut.segments[0].speakerId, 1);
  assert.deepEqual(cut.segments[0].words, [{ start: 0, end: 0.5, text: '前' }, { start: 1, end: 2, text: '中' }]);
});
