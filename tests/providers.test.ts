import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'fieldwork-provider-'));
process.env.DB_DRIVER = 'sqlite';
process.env.DATA_DIR = join(dir, 'db'); process.env.SEED_DEMO = 'false';
const { db, put, id } = await import('../src/server/db');
const svc = await import('../src/server/service');
let status = 200, reply: unknown = {}, lastRequest = '', requestCount = 0;
let beforeReply: (() => Promise<void>) | undefined;
const server = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer test-only'); requestCount++;
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
  lastRequest = Buffer.concat(chunks).toString(); const action = beforeReply; beforeReply = undefined; await action?.(); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
process.env.AI_BASE_URL = process.env.ASR_BASE_URL = `http://127.0.0.1:${address.port}`;
process.env.ASR_PROVIDER = 'openai';
process.env.AI_API_KEY = process.env.ASR_API_KEY = 'test-only'; process.env.AI_MODEL = 'mock-chat'; process.env.ASR_MODEL = 'mock-asr';
const merchant = (await svc.createMerchant({ name: '接口验收门店', industry: '咖啡', city: '杭州' }));
const project = (await svc.createProject({ merchantId: merchant.id, name: '接口验收', mode: 'shoot', dueDate: '', deliverables: 1 }));
const form = new FormData(); form.set('projectId', project.id); form.set('rights', 'authorized'); form.set('file', new File(['真实资料：门店制作手冲咖啡。'], '资料.txt'));
const source = await svc.upload(form);
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); (await db.close()); rmSync(dir, { recursive: true, force: true }); });
test('AI 适配器：验证结构、可用来源与服务端凭据传递（本地桩）', async () => {
  reply = { choices: [{ message: { content: JSON.stringify({ ideas: [{ title: '手冲日常', brief: '来自已授权文稿', script: '记录过程', caption: '真实表达', hashtags: ['咖啡'], sourceAssetIds: [source.id, 'invented-id'] }] }) } }] };
  const result = await svc.generate({ referenceMode: 'auto', projectId: project.id, platform: '小红书' });
  assert.equal(result.provider, 'api'); assert.deepEqual(result.contents[0].sourceAssetIds, [source.id]);
  assert.equal(JSON.parse(lastRequest).model, 'mock-chat');
});
test('AI 适配器：上游错误不伪装成演示成功，不暴露上游正文', async () => {
  status = 503; reply = { error: 'provider-private-details' };
  await assert.rejects(async () => (await svc.generate({ referenceMode: 'auto', projectId: project.id, platform: '抖音' })), error => error instanceof Error && /503/.test(error.message) && !error.message.includes('private'));
  status = 200;
});
test('AI 适配器：拒绝没有真实来源的生成结果', async () => {
  reply = { choices: [{ message: { content: JSON.stringify({ ideas: [{ title: '无来源', brief: '', script: '', caption: '', hashtags: [], sourceAssetIds: ['invented-id'] }] }) } }] };
  await assert.rejects(async () => (await svc.generate({ referenceMode: 'auto', projectId: project.id, platform: '抖音' })), /缺少有效素材来源/);
});
test('ASR 适配器：真实音轨提取、multipart 和分段时间码入库（本地桩）', async () => {
  const path = join(dir, 'sample.wav'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', path]);
  const f = new FormData(); f.set('projectId', project.id); f.set('rights', 'authorized'); f.set('file', new File([readFileSync(path)], 'sample.wav'));
  const a = await svc.upload(f);
  reply = { segments: [{ start: 0, end: 1.8, text: '这是接口格式测试。' }] };
  const transcribed = await svc.runTranscription(a.id);
  assert.equal(transcribed.transcriptSource, 'asr'); assert.equal(transcribed.segments[0].end, 1.8);
  assert.ok(lastRequest.includes('name="response_format"')); assert.ok(lastRequest.includes('verbose_json')); assert.ok(lastRequest.includes('name="file"'));
  reply = { segments: [{ start: -1, end: 0, text: '无效' }] };
  await assert.rejects(() => svc.runTranscription(a.id), /没有返回可用文字/);
});

test('AI 素材范围：最多 30 份，不能引用同项目中未提供给模型的素材', async () => {
  const limited = (await svc.createProject({ merchantId: merchant.id, name: '素材范围验收', mode: 'shoot', dueDate: '', deliverables: 1 }));
  for (let i = 0; i < 31; i++) (await put('assets', { ...source, id: `range-${i}`, projectId: limited.id, name: `文稿 ${i}` }));
  reply = { choices: [{ message: { content: JSON.stringify({ ideas: [{ title: '未提供来源', brief: '', script: '', caption: '', hashtags: [], sourceAssetIds: ['range-0'] }] }) } }] };
  await assert.rejects(async () => (await svc.generate({ referenceMode: 'auto', projectId: limited.id, platform: '小红书' })), /缺少有效素材来源/);
  const submitted = JSON.parse(lastRequest).messages[1].content;
  const context = JSON.parse(submitted).assets;
  assert.equal(context.length, 30); assert.ok(context.every((asset: { id: string }) => asset.id !== 'range-0'));
});

function modelIdeas(sourceAssetIds: string[]) {
  return { choices: [{ message: { content: JSON.stringify({ ideas: [{ title: '选择范围验收', brief: '', script: '仅根据所选资料', caption: '真实表达', hashtags: [], sourceAssetIds }] }) } }] };
}
async function selectionProject() { return (await svc.createProject({ merchantId: merchant.id, name: '手动选材验收', mode: 'shoot', dueDate: '', deliverables: 1 })); }
async function selectionAsset(projectId: string, name: string, fields = {}) { return (await put('assets', { ...source, id: id(), projectId, name, ...fields })); }
test('手动选材：模型只收到勾选的文件，不读取未选素材的名称和文字', async () => {
  const p = (await selectionProject()); const selected = (await selectionAsset(p.id, '已选产品介绍.txt'));
  const excluded = (await selectionAsset(p.id, '未选的独有文件.txt', { segments: [{ start: null, end: null, text: '未选素材的独有内容不得发送给模型' }] }));
  reply = modelIdeas([selected.id]);
  const result = await svc.generate({ projectId: p.id, platform: '小红书', referenceMode: 'manual', referenceAssetIds: [selected.id] });
  const context = JSON.parse(JSON.parse(lastRequest).messages[1].content).assets;
  assert.deepEqual(context.map((a: { id: string }) => a.id), [selected.id]);
  assert.ok(!lastRequest.includes(excluded.name)); assert.ok(!lastRequest.includes('未选素材的独有内容'));
  assert.deepEqual(result.contents[0].sourceAssetIds, [selected.id]);
  reply = modelIdeas([excluded.id]);
  await assert.rejects(async () => (await svc.generate({ projectId: p.id, platform: '小红书', referenceMode: 'manual', referenceAssetIds: [selected.id] })), /缺少有效素材来源/);
});
test('手动选材：空选、重复、跨项目、失效或超量均在调用模型前拒绝，不回退为自动', async () => {
  const p = (await selectionProject()), other = (await selectionProject());
  const usable = (await selectionAsset(p.id, '可用.txt')); const foreign = (await selectionAsset(other.id, '其他项目.txt'));
  const pending = (await selectionAsset(p.id, '待授权.txt', { rights: 'pending' }));
  const expired = (await selectionAsset(p.id, '过期.txt', { expiresAt: '2000-01-01' }));
  const cases = [undefined, [], [usable.id, usable.id], [foreign.id], [pending.id], [expired.id], ['deleted-reference'], Array.from({ length: 31 }, (_, i) => 'too-many-' + i)];
  const count = requestCount;
  await assert.rejects(async () => (await svc.generate({ projectId: p.id, platform: '小红书' })), /至少选择/);
  for (const selected of cases) await assert.rejects(async () => (await svc.generate({ projectId: p.id, platform: '小红书', referenceMode: 'manual', referenceAssetIds: selected })));
  await assert.rejects(async () => (await svc.generate({ projectId: p.id, platform: '小红书', referenceMode: 'auto', referenceAssetIds: [usable.id] })), /切换为手动选择/);
  assert.equal(requestCount, count);
});
test('手动选材：可以指定自动前 30 份之外的旧素材', async () => {
  const p = (await selectionProject()); const oldest = (await selectionAsset(p.id, '较早入库的指定采访.txt'));
  for (let i = 0; i < 31; i++) (await selectionAsset(p.id, `较新的素材${i}.txt`));
  reply = modelIdeas([oldest.id]);
  const result = await svc.generate({ projectId: p.id, platform: '小红书', referenceMode: 'manual', referenceAssetIds: [oldest.id] });
  const context = JSON.parse(JSON.parse(lastRequest).messages[1].content).assets;
  assert.equal(context.length, 1); assert.equal(context[0].id, oldest.id); assert.deepEqual(result.contents[0].sourceAssetIds, [oldest.id]);
});
test('手动选材：模型等待期间任意已发送素材被撤权，不保存受影响的生成结果', async () => {
  const p = (await selectionProject()), one = (await selectionAsset(p.id, '实际引用.txt')), two = (await selectionAsset(p.id, '发送但未引用.txt'));
  reply = modelIdeas([one.id]); beforeReply = async () => { (await svc.updateAsset(two.id, { rights: 'pending' })); };
  await assert.rejects(async () => (await svc.generate({ projectId: p.id, platform: '小红书', referenceMode: 'manual', referenceAssetIds: [one.id, two.id] })), /参考素材授权或归属发生变化/);
  assert.equal((await svc.snapshot()).contents.filter(c => c.projectId === p.id).length, 0);
});
