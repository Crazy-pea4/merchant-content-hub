import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'douyin-test-'));
process.env.DATA_DIR = root; process.env.DB_DRIVER = 'sqlite'; process.env.DATABASE_URL = ''; process.env.SEED_DEMO = 'false';
const work = await import('../src/server/douyin'), store = await import('../src/server/db'), http = await import('../src/server/http');
const { douyinSrt } = await import('../src/shared/douyin');
after(async () => { await store.db.close(); rmSync(root, { recursive: true, force: true }); });

test('分享口令、短链和移动端长链可解析，拒绝伪造域名、凭据、端口和本地地址', () => {
  assert.equal(work.douyinShareUrl('9.43 复制打开抖音 https://v.douyin.com/J4pYoVRn1iM/ O@x.SY'), 'https://v.douyin.com/J4pYoVRn1iM/');
  assert.equal(work.douyinShareUrl('https://m.douyin.com/share/video/7705748141055741210/'), 'https://m.douyin.com/share/video/7705748141055741210/');
  for (const url of ['https://v.douyin.com.evil.test/a', 'https://v.douyin.com@127.0.0.1/a', 'http://v.douyin.com/a', 'https://localhost/a', 'https://v.douyin.com:444/a', 'https://www.douyin.com/api/session']) assert.throws(() => work.douyinShareUrl(url));
});
test('同一行字幕按从左到右合并，短暂漏帧不重复输出，英文不混入', () => {
  const frames = [
    { t: 0, frameNumber: 1, results: [{ text: '不要只是渴望成功', x: .1, y: .5 }, { text: '要为之奋斗', x: .6, y: .51 }, { text: 'English audio', x: .1, y: .2 }] },
    { t: 1 / 3, frameNumber: 2, results: [] },
    { t: 2 / 3, frameNumber: 3, results: [{ text: '不要只是渴望成功', x: .1, y: .51 }, { text: '要为之奋斗', x: .6, y: .5 }] },
    { t: 1, frameNumber: 4, results: [{ text: '世界只奖励最优秀的人', x: .1, y: .5 }] },
  ];
  const code = 'import sys,json; sys.path.insert(0,"scripts/douyin-subtitles"); import extract; print(json.dumps(extract.merge_frames(json.loads(sys.argv[1]),3,1.2),ensure_ascii=False))';
  const cues = JSON.parse(execFileSync('python3', ['-c', code, JSON.stringify(frames)], { encoding: 'utf8' }));
  assert.equal(cues.length, 2); assert.equal(cues[0].text, '不要只是渴望成功要为之奋斗'); assert.equal(cues[1].end, 1.2);
});
test('请求编号幂等，队列限额与同编号不同来源/位置冲突', async t => {
  if (!await work.douyinAvailable()) { t.skip('OCR dependencies unavailable'); return; }
  const requestId = randomUUID(), payload = { requestId, shareText: 'https://v.douyin.com/J4pYoVRn1iM/' };
  const [first, duplicate] = await Promise.all([work.enqueueDouyin(payload), work.enqueueDouyin(payload)]);
  assert.equal(first.id, duplicate.id); assert.equal((await store.all('douyin_extractions')).length, 1);
  assert.ok(!('leaseToken' in first));
  await assert.rejects(() => work.enqueueDouyin({ ...payload, position: 'full' }), /编号/);
  for (let i = 0; i < 9; i++) await work.enqueueDouyin({ ...payload, requestId: randomUUID() });
  await assert.rejects(() => work.enqueueDouyin({ ...payload, requestId: randomUUID() }), /较多/);
});
test('校对保持时间轴，防止旧版本覆盖，TXT和SRT同步使用保存后的文字', async () => {
  const id = randomUUID(), cue = { id: 1, start: .4, end: 2.2, text: '原始措字' };
  await store.put('douyin_extractions', { id, sourceUrl: 'https://v.douyin.com/J4pYoVRn1iM/', position: 'bottom', status: 'completed', stage: 'completed', title: '示例', videoId: '7705748141055741210', duration: 38.4, cues: [cue], text: cue.text, reviewStatus: 'unreviewed', error: null, timings: {}, createdAt: store.now(), updatedAt: store.now(), revision: 1, leaseToken: null, leaseUntil: 0 });
  const saved = await work.saveDouyin(id, { revision: 1, texts: ['校对文字'] });
  assert.deepEqual(saved.cues, [{ ...cue, text: '校对文字' }]); assert.equal(saved.reviewStatus, 'reviewed'); assert.equal(saved.text, '校对文字');
  await assert.rejects(() => work.saveDouyin(id, { revision: 1, texts: ['覆盖'] }), /其他页面/);
  await assert.rejects(() => work.saveDouyin(id, { revision: 2, texts: ['一', '二'] }), /条数/);
  const download = await http.handleApi(new Request(`http://localhost/api/douyin-extractions/${id}/download?format=srt`), ['douyin-extractions', id, 'download']);
  assert.equal(download.status, 200); assert.match(await download.text(), /00:00:00,400 --> 00:00:02,200\n校对文字/);
  const text = await http.handleApi(new Request(`http://localhost/api/douyin-extractions/${id}/download?format=txt`), ['douyin-extractions', id, 'download']); assert.equal(await text.text(), '校对文字\n');
  assert.match(douyinSrt(saved.cues), /校对文字/);
  process.env.HUB_ACCESS_TOKEN = 'douyin-test-token';
  try {
    assert.equal((await http.handleApi(new Request(`http://localhost/api/douyin-extractions/${id}/download`), ['douyin-extractions', id, 'download'])).status, 401);
    assert.equal((await http.handleApi(new Request('http://localhost/api/douyin-extractions', { method: 'POST', headers: { Authorization: 'Bearer douyin-test-token', Origin: 'https://foreign.example' }, body: JSON.stringify({ requestId: randomUUID(), shareText: 'https://v.douyin.com/test/' }) }), ['douyin-extractions'])).status, 403);
  } finally { delete process.env.HUB_ACCESS_TOKEN; }
});

test('字幕可按版本保存到项目，旧记录可认领，重复点击复用同一份素材', async () => {
  const service = await import('../src/server/service');
  const { saveToolAsset } = await import('../src/server/tool-assets');
  const merchant = await service.createMerchant({ name: '字幕团队', city: '杭州', industry: '餐饮' });
  const projects = await Promise.all(['春季拍摄', '夏季拍摄'].map(name => service.createProject({ merchantId: merchant.id, name, mode: 'shoot', dueDate: '', deliverables: 1 })));
  const [first, second] = projects;
  const job = await store.put('douyin_extractions', {
    id: randomUUID(), sourceUrl: 'https://v.douyin.com/example/', position: 'bottom', status: 'completed', stage: 'completed',
    title: '采访字幕', videoId: null, duration: 3, text: '第一版', cues: [{ id: 1, start: 0.4, end: 2.2, text: '第一版' }],
    reviewStatus: 'unreviewed', error: null, timings: {}, createdAt: store.now(), updatedAt: store.now(), revision: 1, leaseToken: null, leaseUntil: 0,
  });
  const scoped = await store.put('douyin_extractions', { ...job, id: randomUUID(), projectId: first.id });
  const source = { type: 'douyin', id: scoped.id, revision: scoped.revision };
  const [asset, duplicate] = await Promise.all([saveToolAsset(first.id, source), saveToolAsset(first.id, source)]);
  assert.equal(asset.id, duplicate.id);
  assert.equal(asset.rights, 'pending');
  assert.equal(asset.note, scoped.sourceUrl);
  assert.equal(asset.segments[0].start, scoped.cues[0].start);
  await assert.rejects(() => saveToolAsset(second.id, source), /其他项目/);
  const history = await work.douyinSnapshot(second.id);
  assert.ok(history.jobs.some(item => item.id === job.id));
  assert.ok(!history.jobs.some(item => item.id === scoped.id));
  await assert.rejects(() => saveToolAsset(first.id, { ...source, revision: 100 }), /版本/);
  const revision = await work.saveDouyin(scoped.id, { revision: scoped.revision, texts: ['第二次校对'] });
  const updated = await saveToolAsset(first.id, { ...source, revision: revision.revision });
  assert.notEqual(asset.id, updated.id);
  assert.equal(updated.segments[0].text, '第二次校对');
  const response = await http.handleApi(new Request('http://localhost/api/files/' + updated.id), ['files', updated.id]);
  assert.equal(await response.text(), douyinSrt(revision.cues));
  assert.ok((await saveToolAsset(second.id, { type: 'douyin', id: job.id, revision: job.revision })).storageKey);
});
