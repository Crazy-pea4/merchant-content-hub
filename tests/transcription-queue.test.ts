import { after, afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = mkdtempSync(join(tmpdir(), 'fieldwork-auto-asr-'));
process.env.DB_DRIVER = 'sqlite';
process.env.DATA_DIR = join(directory, 'data'); process.env.SEED_DEMO = 'false';
process.env.ASR_PROVIDER = 'openai'; process.env.ASR_API_KEY = 'queue-test-only'; process.env.ASR_MODEL = 'mock-asr'; process.env.ASR_BASE_URL = 'https://asr.example.invalid/v1';
const store = await import('../src/server/db'); const svc = await import('../src/server/service');
const queue = await import('../src/server/transcription-queue'); const worker = await import('../src/server/transcription-worker');
const originalFetch = globalThis.fetch;
beforeEach(async () => { for (const job of (await store.all('transcription_jobs'))) (await store.remove('transcription_jobs', job.id)); for (const job of (await store.all('asr_jobs'))) (await store.remove('asr_jobs', job.id)); });
afterEach(() => { globalThis.fetch = originalFetch; process.env.ASR_API_KEY = 'queue-test-only'; });
after(async () => { (await store.db.close()); rmSync(directory, { recursive: true, force: true }); });
const merchant = (await svc.createMerchant({ name: '自动转写验收', industry: '咖啡', city: '测试' }));
const project = (await svc.createProject({ merchantId: merchant.id, name: '隔离项目', mode: 'shoot', dueDate: '', deliverables: 1 }));
const audio = join(directory, 'voice.wav'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', audio]);
async function upload(rights = 'authorized') {
  const form = new FormData(); form.set('projectId', project.id); form.set('rights', rights); form.set('file', new File([readFileSync(audio)], 'audio.wav'));
  return (await svc.upload(form));
}
function response() { return Response.json({ segments: [{ start: 0, end: 1.8, text: '老板介绍开店故事。' }] }); }
function gate() {
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; }); let count = 0;
  const fetcher: typeof fetch = async () => { count++; started(); await waiting; return response(); };
  return { fetcher, release, entered, count: () => count };
}
test('并发续租不能覆盖已持久化的提交标记，避免进程恢复后重复提交 ASR', async () => {
  const asset = await upload();
  const claim = await queue.claimTranscription(30000);
  assert.equal(claim?.id, asset.id);
  await Promise.all([
    queue.updateClaim(claim!, { submissionStarted: true }),
    queue.updateClaim(claim!, { leaseUntil: Date.now() + 60000 }),
  ]);
  const saved = await store.get('transcription_jobs', asset.id);
  assert.equal(saved?.submissionStarted, true);
  assert.ok(saved!.leaseUntil > claim!.leaseUntil);
});
test('上传只入库并排队，不在上传请求里调用 ASR；图片与文稿不排队', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; return response(); };
  const asset = await upload(); assert.equal(calls, 0); assert.equal(asset.transcription?.status, 'queued');
  assert.equal((await store.get('transcription_jobs', asset.id))?.status, 'queued');
  const form = new FormData(); form.set('projectId', project.id); form.set('file', new File(['人工文稿'], 'notes.txt'));
  const document = await svc.upload(form); assert.equal((await store.get('transcription_jobs', document.id)), undefined);
});
test('待确认授权保持等待；确认后自动排队；未配置时不调用服务', async () => {
  const asset = await upload('pending'); assert.equal(asset.transcription?.status, 'waiting_authorization');
  (await svc.updateAsset(asset.id, { rights: 'authorized' })); assert.equal((await store.get('transcription_jobs', asset.id))?.status, 'queued');
  process.env.ASR_API_KEY = ''; await worker.processNextTranscription(); assert.equal((await store.get('transcription_jobs', asset.id))?.status, 'waiting_configuration');
  process.env.ASR_API_KEY = 'queue-test-only'; (await queue.wakeTranscriptionJobs()); assert.equal((await store.get('transcription_jobs', asset.id))?.status, 'queued');
});
test('无音轨视频会跳过，已有未处理历史素材不会被批量自动转写', async () => {
  const asset = await upload(); (await store.remove('transcription_jobs', asset.id));
  (await queue.enqueueTranscription({ ...(await store.get('assets', asset.id))!, hasAudio: false, kind: 'video' }));
  assert.equal((await store.get('transcription_jobs', asset.id))?.status, 'skipped');
  const historical = await upload(); (await store.remove('transcription_jobs', historical.id)); (await queue.wakeTranscriptionJobs());
  assert.equal((await store.get('transcription_jobs', historical.id)), undefined);
});
test('后台识别未完成时其他任务可写入，重复请求不会重复提交，完成后自动索引', async () => {
  const asset = await upload(), blocked = gate(); globalThis.fetch = blocked.fetcher;
  const processing = worker.processNextTranscription(); await blocked.entered;
  try {
    assert.equal((await svc.requestTranscription(asset.id)).transcription?.status, 'processing');
    assert.equal((await svc.requestTranscription(asset.id)).transcription?.status, 'processing');
    const task = (await svc.createTask({ projectId: project.id, title: '识别期间新增任务', owner: '测试', dueDate: '', description: '', priority: 'normal' })); assert.ok(task.id);
    assert.equal((await svc.snapshot()).assets.find(a => a.id === asset.id)?.transcription?.status, 'processing');
  } finally { blocked.release(); }
  await processing; assert.equal(blocked.count(), 1);
  assert.equal((await queue.withTranscription((await store.get('assets', asset.id))!)).transcription?.status, 'completed');
  assert.equal((await store.get('assets', asset.id))?.transcriptSource, 'asr');
  assert.ok((await svc.search(project.id, '开店故事')).some(hit => hit.asset.id === asset.id && hit.segment?.start === 0));
});
test('过期租约可接管；旧租约不能续约或覆盖新任务', async () => {
  const asset = await upload(), first = (await queue.claimTranscription(30000))!;
  (await store.put('transcription_jobs', { ...first, leaseUntil: Date.now() - 1 }));
  const second = (await queue.claimTranscription(30000))!; assert.notEqual(second.leaseToken, first.leaseToken);
  assert.equal((await queue.updateClaim(first, { status: 'failed' })), undefined);
  assert.equal((await store.get('transcription_jobs', asset.id))?.leaseToken, second.leaseToken);
});
test('人工改稿和撤回授权使旧任务失效，后台结果不会覆盖', async () => {
  const asset = await upload(), blocked = gate(); globalThis.fetch = blocked.fetcher;
  const processing = worker.processNextTranscription(); await blocked.entered;
  (await svc.updateAsset(asset.id, { transcript: '人工逐字稿必须保留' })); blocked.release(); await processing;
  assert.equal((await store.get('assets', asset.id))?.segments[0].text, '人工逐字稿必须保留');
  assert.equal((await store.get('transcription_jobs', asset.id))?.status, 'cancelled');
  const next = await upload(), nextGate = gate(); globalThis.fetch = nextGate.fetcher;
  const nextProcessing = worker.processNextTranscription(); await nextGate.entered;
  (await svc.updateAsset(next.id, { rights: 'pending' })); nextGate.release(); await nextProcessing;
  assert.equal((await store.get('transcription_jobs', next.id))?.status, 'waiting_authorization');
  assert.deepEqual((await store.get('assets', next.id))?.segments, []);
});
test('失败保留旧稿，重试接口仅重新排队；提交状态不明时不会自动再次收费', async () => {
  const asset = await upload(); globalThis.fetch = async () => Response.json({ error: 'private provider body' }, { status: 503 });
  await worker.processNextTranscription(); assert.equal((await store.get('transcription_jobs', asset.id))?.status, 'failed'); assert.deepEqual((await store.get('assets', asset.id))?.segments, []);
  assert.equal((await svc.requestTranscription(asset.id)).transcription?.status, 'queued');
  globalThis.fetch = async () => response(); await worker.processNextTranscription(); assert.equal((await store.get('transcription_jobs', asset.id))?.status, 'completed');
  const uncertain = await upload(), job = (await store.get('transcription_jobs', uncertain.id))!;
  (await store.put('transcription_jobs', { ...job, submissionStarted: true })); let calls = 0; globalThis.fetch = async () => { calls++; return response(); };
  await worker.processNextTranscription(); assert.equal(calls, 0); assert.equal((await store.get('transcription_jobs', uncertain.id))?.status, 'failed');
});
test('过期或切换服务的已知任务不会自动重新提交收费请求', async () => {
  const asset = await upload(), job = (await store.get('transcription_jobs', asset.id))!;
  (await store.put('asr_jobs', { id: asset.id, projectId: project.id, taskId: 'expired-task', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'fun-asr', createdAt: new Date(Date.now() - 24 * 3600000).toISOString(), fingerprint: job.fingerprint }));
  (await store.put('transcription_jobs', { ...job, submissionStarted: true }));
  let calls = 0; globalThis.fetch = async () => { calls++; return response(); };
  await worker.processNextTranscription(); assert.equal(calls, 0); assert.equal((await store.get('transcription_jobs', asset.id))?.status, 'failed');
  assert.match((await store.get('transcription_jobs', asset.id))?.error || '', /已过期|已变更/);
});
test('删除排队素材会级联移除任务，完成状态与逐字稿原子落库', async () => {
  const asset = await upload(); (await svc.deleteAsset(asset.id)); assert.equal((await store.get('transcription_jobs', asset.id)), undefined);
  const next = await upload(); globalThis.fetch = async () => response(); await worker.processNextTranscription();
  assert.equal((await store.get('transcription_jobs', next.id))?.status, 'completed'); assert.ok((await store.get('assets', next.id))?.segments.length);
});
test('进程被强制结束后，新进程恢复已提交的百炼任务，不重新上传或提交', { timeout: 20000 }, async () => {
  const asset = await upload(), events = join(directory, 'provider-events.jsonl'), script = join(directory, 'restart-worker.mjs');
  const workerUrl = pathToFileURL(resolve('src/server/transcription-worker.ts')).href;
  writeFileSync(script, `import {appendFileSync} from 'node:fs';
    let announced=false;
    globalThis.fetch=async (input,init)=>{
      const url=String(input);const record=kind=>appendFileSync(process.env.PROVIDER_EVENTS,JSON.stringify({kind})+'\\n');
      if(url.includes('/uploads?')){record('policy');return Response.json({data:{upload_host:'https://upload.oss-cn-beijing.aliyuncs.com',upload_dir:'test',oss_access_key_id:'test',signature:'test',policy:'test',x_oss_object_acl:'private',x_oss_forbid_overwrite:'true'}});}
      if(url.includes('upload.oss')){record('upload');return new Response(null,{status:200});}
      if(url.endsWith('/services/audio/asr/transcription')){record('submit');return Response.json({output:{task_id:'recovered-task',task_status:'PENDING'}});}
      if(url.includes('/tasks/')){record('query');if(process.env.WORKER_STAGE==='first'){if(!announced){console.log('REMOTE_TASK_SAVED');announced=true;}return Response.json({output:{task_status:'RUNNING'}});}return Response.json({output:{task_status:'SUCCEEDED',results:[{subtask_status:'SUCCEEDED',transcription_url:'https://result.oss-cn-beijing.aliyuncs.com/result.json'}]}});}
      if(url.includes('result.oss')){record('result');return Response.json({transcripts:[{sentences:[{begin_time:0,end_time:1800,text:'开店故事自动恢复',words:[{begin_time:0,end_time:800,text:'开店故事'}]}]}]});}
      throw new Error('Unexpected request');
    };
    const {startTranscriptionWorker}=await import(${JSON.stringify(workerUrl)});startTranscriptionWorker({leaseMs:600,heartbeatMs:100,pollMs:50});setInterval(()=>{},1000);
  `);
  const env = { ...process.env, ASR_PROVIDER: 'aliyun', ASR_MODEL: 'qwen-audio-3.1-asr-flash-filetrans', ASR_BASE_URL: 'https://dashscope.aliyuncs.com/api/v1', PROVIDER_EVENTS: events };
  const launch = (stage: string) => spawn(process.execPath, ['--import', 'tsx', script], { cwd: process.cwd(), env: { ...env, WORKER_STAGE: stage }, stdio: ['ignore', 'pipe', 'pipe'] });
  const first = launch('first'); let second: ReturnType<typeof launch> | undefined;
  try {
    await new Promise<void>((resolveReady, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('First worker did not submit')), 10000);
      first.stdout.on('data', chunk => { output += chunk; if (output.includes('REMOTE_TASK_SAVED')) { clearTimeout(timer); resolveReady(); } });
      first.once('exit', () => { clearTimeout(timer); reject(new Error('First worker exited early')); });
    });
    assert.equal((await store.get('asr_jobs', asset.id))?.taskId, 'recovered-task'); const exited = once(first, 'exit'); first.kill('SIGKILL'); await exited;
    second = launch('second');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && (await store.get('transcription_jobs', asset.id))?.status !== 'completed') await new Promise(resolveWait => setTimeout(resolveWait, 50));
    assert.equal((await store.get('transcription_jobs', asset.id))?.status, 'completed'); assert.equal((await store.get('assets', asset.id))?.segments[0].text, '开店故事自动恢复');
    const counts = readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line).kind);
    assert.equal(counts.filter(kind => kind === 'upload').length, 1); assert.equal(counts.filter(kind => kind === 'submit').length, 1);
  } finally {
    if (first.exitCode === null && !first.killed) first.kill('SIGKILL');
    if (second && second.exitCode === null) { const exited = once(second, 'exit'); second.kill('SIGKILL'); await exited; }
  }
});
