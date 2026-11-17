import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DB_DRIVER = 'sqlite';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fieldwork-unit-'));
process.env.SEED_DEMO = 'false';
process.env.AI_BASE_URL = ''; process.env.AI_API_KEY = ''; process.env.AI_MODEL = '';
const store = await import('../src/server/db');
const svc = await import('../src/server/service');
const { parseTranscript, isUsable, searchAssets } = await import('../src/server/search');
after(async () => { (await store.db.close()); rmSync(process.env.DATA_DIR!, { recursive: true, force: true }); });
const merchant = (await svc.createMerchant({ name: '测试商家', industry: '咖啡', city: '杭州', positioning: '手冲咖啡', audience: '附近居民' }));
const project = (await svc.createProject({ merchantId: merchant.id, name: '交付项目', mode: 'shoot', dueDate: '', deliverables: 3 }));
const managed = (await svc.createProject({ merchantId: merchant.id, name: '运营项目', mode: 'managed', dueDate: '', deliverables: 12 }));
async function asset(projectId = project.id, fields = {}) {
  return (await store.put('assets', { id: store.id(), projectId, name: '老板访谈', kind: 'video', mime: 'video/mp4', size: 0, storageKey: '', thumbnailKey: null, duration: 10, tags: ['主理人', '品牌故事'], segments: [{ start: 0, end: 8, text: '开店是希望附近上班族有地方坐坐。' }], transcriptSource: 'manual', rights: 'authorized', expiresAt: '', note: '', error: null, createdAt: store.now(), ...fields }));
}
async function content(projectId = project.id, sourceAssetIds: string[] = []) {
  return (await store.put('contents', { id: store.id(), projectId, title: '测试草案', platform: '小红书', brief: '', script: '有据表达', caption: '门店日常', hashtags: [], sourceAssetIds, mediaAssetId: null, provider: 'demo', status: 'draft', version: 1, reviews: [], reviewToken: null, reviewExpiresAt: null, scheduledAt: null, createdAt: store.now() }));
}
test('业务建档：费用默认值与两种业务模式持久化', async () => {
  assert.equal((await store.get('projects', project.id))?.fee, 0);
  assert.equal((await store.get('projects', managed.id))?.mode, 'managed');
  (await assert.rejects(async () => (await svc.createProject({ merchantId: 'missing', name: '非法', mode: 'shoot', dueDate: '', deliverables: 1 })), /商家不存在/));
});
test('日期与数量校验拒绝不可能日期和负数交付', async () => {
  (await assert.rejects(async () => (await svc.createProject({ merchantId: merchant.id, name: 'bad', mode: 'shoot', dueDate: '2026-02-31', deliverables: 1 }))));
  (await assert.rejects(async () => (await svc.createProject({ merchantId: merchant.id, name: 'bad', mode: 'shoot', dueDate: '', deliverables: -1 }))));
});
test('SRT 导入保留真实时间码和多行文字', () => {
  const segments = parseTranscript('1\n00:00:01,250 --> 00:00:04,900\n第一行\n第二行\n\n2\n00:00:05,000 --> 00:00:08,000\n另一段');
  assert.equal(segments.length, 2); assert.equal(segments[0].start, 1.25); assert.equal(segments[0].end, 4.9); assert.equal(segments[0].text, '第一行 第二行');
});
test('普通逐字稿不伪造时间码，空文稿清空索引', async () => {
  assert.deepEqual(parseTranscript('第一句\n第二句').map(s => s.start), [null, null]);
  const a = (await asset()); (await svc.updateAsset(a.id, { transcript: '' })); assert.equal((await store.get('assets', a.id))?.segments.length, 0);
});
test('自然语言检索用同义词匹配并返回时间片段', async () => {
  const a = (await asset()); const hits = searchAssets([a], '店主讲创业的镜头');
  assert.equal(hits[0].asset.id, a.id); assert.equal(hits[0].segment?.start, 0); assert.ok(hits[0].score > 0);
});
test('检索仅限当前项目，排除未授权及过期素材', async () => {
  const a = (await asset()), other = (await asset(managed.id)), pending = (await asset(project.id, { rights: 'pending' })), expired = (await asset(project.id, { expiresAt: '2020-01-01' }));
  const hits = (await svc.search(project.id, '老板'));
  assert.ok(hits.some(h => h.asset.id === a.id)); assert.ok(hits.every(h => ![other.id, pending.id, expired.id].includes(h.asset.id))); assert.equal(isUsable(expired), false);
});
test('素材修改只接收允许字段，不能换项目或文件路径', async () => {
  const a = (await asset()); (await assert.rejects(async () => (await svc.updateAsset(a.id, { projectId: managed.id })))); (await assert.rejects(async () => (await svc.updateAsset(a.id, { storageKey: '../../secret' }))));
  (await svc.updateAsset(a.id, { tags: ['新标签'] })); assert.equal((await store.get('assets', a.id))?.transcriptSource, 'manual');
});
test('无密钥演示创作只引用本项目已授权素材', async () => {
  const c = await svc.generate({ referenceMode: 'auto', projectId: project.id, platform: '小红书', objective: '介绍老板故事' });
  assert.equal(c.provider, 'demo'); assert.equal(c.contents.length, 3);
  const sourceMap = new Map((await store.all('assets')).map(a => [a.id,a])); assert.ok(c.contents.every(c => c.sourceAssetIds.every(id => sourceMap.get(id)?.projectId === project.id && isUsable(sourceMap.get(id)!))));
});
test('没有可用素材时不能生成有来源的内容', async () => {
  const empty = (await svc.createProject({ merchantId: merchant.id, name: '空项目', mode: 'shoot', dueDate: '', deliverables: 1 }));
  await assert.rejects(async () => (await svc.generate({ referenceMode: 'auto', projectId: empty.id, platform: '抖音' })), /已授权素材/);
});
test('禁止跨项目引用：即使知道素材 ID 也不能提交审核', async () => {
  const other = (await asset(managed.id)), c = (await content(project.id, [other.id]));
  (await assert.rejects(async () => (await svc.transition(c.id, { action: 'submit', version: 1 })), /其他项目/));
  assert.equal((await store.get('contents', c.id))?.status, 'draft');
});
test('拍摄交付：提交、客户通过、交付，禁止跳过审核', async () => {
  const c = (await content(project.id, [(await asset()).id])); (await assert.rejects(async () => (await svc.transition(c.id, { action: 'deliver', version: 1 })), /状态/));
  const submitted = (await svc.transition(c.id, { action: 'submit', version: 1 }));
  assert.equal(submitted.reviewToken?.length, 48); assert.equal((await svc.publicReview(submitted.reviewToken!)).title, c.title);
  (await svc.transition(c.id, { action: 'approve', version: 1 }, '客户'));
  const done = (await svc.transition(c.id, { action: 'deliver', version: 1 })); assert.equal(done.status, 'delivered');
  assert.ok((await svc.delivery(project.id)).contents.some(item => item.id === c.id));
});
test('重复审核和旧版本操作返回冲突', async () => {
  const c = (await content()); (await svc.transition(c.id, { action: 'submit', version: 1 })); (await svc.transition(c.id, { action: 'approve', version: 1 }));
  (await assert.rejects(async () => (await svc.transition(c.id, { action: 'approve', version: 1 })), /状态/));
  (await assert.rejects(async () => (await svc.transition(c.id, { action: 'deliver', version: 0 })), /版本/));
});
test('修改必须有意见；修订保留演示来源并撤销旧审核链接', async () => {
  const c = (await content()), submitted = (await svc.transition(c.id, { action: 'submit', version: 1 }));
  (await assert.rejects(async () => (await svc.transition(c.id, { action: 'request_changes', version: 1, comment: '' })), /修改意见/));
  (await svc.transition(c.id, { action: 'request_changes', version: 1, comment: '补充地址' }));
  const next = (await svc.revise(c.id, { version: 1, title: c.title, platform: c.platform, brief: '', script: c.script, caption: '新版', hashtags: [], sourceAssetIds: [], mediaAssetId: null }));
  assert.equal(next.version, 2); assert.equal(next.status, 'draft'); assert.equal(next.provider, 'demo');
  (await assert.rejects(async () => (await svc.reviewContent(submitted.reviewToken!)), /失效/));
});
test('客户审核数据不返回素材库、其他商家或审核令牌', async () => {
  const submitted = (await svc.transition((await content()).id, { action: 'submit', version: 1 }));
  const view = (await svc.publicReview(submitted.reviewToken!));
  assert.equal('reviewToken' in view, false); assert.equal('sourceAssetIds' in view, false); assert.equal('assets' in view, false);
});
test('代运营：审核后未来排期，到时才可确认发布', async () => {
  const c = (await content(managed.id, [(await asset(managed.id)).id])); (await svc.transition(c.id, { action: 'submit', version: 1 })); (await svc.transition(c.id, { action: 'approve', version: 1 }));
  (await assert.rejects(async () => (await svc.transition(c.id, { action: 'deliver', version: 1 })), /代运营/));
  (await assert.rejects(async () => (await svc.transition(c.id, { action: 'schedule', version: 1, scheduledAt: '2020-01-01' })), /未来/));
  const next = (await svc.transition(c.id, { action: 'schedule', version: 1, scheduledAt: new Date(Date.now() + 60000).toISOString() })); assert.equal(next.status, 'scheduled');
  (await assert.rejects(async () => (await svc.transition(c.id, { action: 'publish', version: 1 })), /排期时间/));
  (await store.put('contents', { ...next, scheduledAt: new Date(Date.now() - 1000).toISOString() }));
  assert.equal((await svc.transition(c.id, { action: 'publish', version: 1 })).status, 'published');
});
test('审核后撤销素材授权会阻止交付', async () => {
  const a = (await asset()), c = (await content(project.id, [a.id])); (await svc.transition(c.id, { action: 'submit', version: 1 })); (await svc.transition(c.id, { action: 'approve', version: 1 }));
  (await svc.updateAsset(a.id, { rights: 'pending' })); (await assert.rejects(async () => (await svc.transition(c.id, { action: 'deliver', version: 1 })), /未授权/));
});
test('引用中的素材禁止删除；普通素材删除不影响其他记录', async () => {
  const a = (await asset()); (await content(project.id, [a.id])); (await assert.rejects(async () => (await svc.deleteAsset(a.id)), /引用/));
  const removable = (await asset()); (await svc.deleteAsset(removable.id)); assert.equal((await store.get('assets', removable.id)), undefined);
});
test('拍摄任务按项目归档，状态与操作日志持久化', async () => {
  const task = (await svc.createTask({ projectId: project.id, title: '采访老板', dueDate: '', description: '确认收声' }));
  (await svc.updateTask(task.id, { status: 'done' })); assert.equal((await store.get('tasks', task.id))?.status, 'done'); assert.ok((await store.all('activities')).some(a => a.text.includes('采访老板')));
});
test('事务异常时回滚，防止部分状态写入', async () => {
  const a = (await asset()); (await assert.rejects(async () => (await store.transaction(async () => { (await store.put('assets', { ...a, name: '不应保存' })); throw new Error('fail'); }))));
  assert.equal((await store.get('assets', a.id))?.name, a.name);
});
test('单条草稿删除保留来源素材、成片记录和操作日志', async () => {
  const a = (await asset()), media = (await asset()), c = (await content(project.id, [a.id]));
  (await store.put('contents', { ...c, mediaAssetId: media.id }));
  const result = (await svc.deleteDrafts({ projectId: project.id, items: [{ id: c.id, version: c.version }] }));
  assert.equal(result.count, 1); assert.deepEqual(result.deletedIds, [c.id]);
  assert.equal((await store.get('contents', c.id)), undefined); assert.ok((await store.get('assets', a.id))); assert.ok((await store.get('assets', media.id)));
  assert.ok((await store.all('activities')).some(event => event.projectId === project.id && event.text.includes('删除草稿')));
});
test('批量草稿删除只影响明确选择的记录', async () => {
  const first = (await content()), second = (await content()), untouched = (await content());
  const result = (await svc.deleteDrafts({ projectId: project.id, items: [first, second].map(c => ({ id: c.id, version: c.version })) }));
  assert.equal(result.count, 2); assert.equal((await store.get('contents', first.id)), undefined); assert.equal((await store.get('contents', second.id)), undefined); assert.ok((await store.get('contents', untouched.id)));
});
test('草稿删除拒绝跨项目，且批量中任一非法项均不部分删除', async () => {
  const own = (await content()), other = (await content(managed.id));
  (await assert.rejects(async () => (await svc.deleteDrafts({ projectId: project.id, items: [own, other].map(c => ({ id: c.id, version: c.version })) })), /当前项目/));
  assert.ok((await store.get('contents', own.id))); assert.ok((await store.get('contents', other.id)));
  (await assert.rejects(async () => (await svc.deleteDrafts({ projectId: project.id, items: [{ id: own.id, version: 1 }, { id: 'missing', version: 1 }] })), /不存在/));
  assert.ok((await store.get('contents', own.id)));
});
test('审核中、通过、交付、排期与发布内容均禁止直接删除', async () => {
  const own = (await content());
  for (const status of ['in_review', 'approved', 'delivered', 'scheduled', 'published'] as const) {
    const protectedContent = (await store.put('contents', { ...(await content()), status }));
    (await assert.rejects(async () => (await svc.deleteDrafts({ projectId: project.id, items: [own, protectedContent].map(c => ({ id: c.id, version: c.version })) })), /仅草稿/));
    assert.ok((await store.get('contents', own.id))); assert.ok((await store.get('contents', protectedContent.id)));
  }
});
test('草稿删除校验版本与重复、空列表，避免陈旧或不明确的删除', async () => {
  const c = (await content()), another = (await content()); (await store.put('contents', { ...another, version: 2 }));
  (await assert.rejects(async () => (await svc.deleteDrafts({ projectId: project.id, items: [{ id: c.id, version: 1 }, { id: another.id, version: 1 }] })), /版本/));
  assert.ok((await store.get('contents', c.id)));
  (await assert.rejects(async () => (await svc.deleteDrafts({ projectId: project.id, items: [{ id: c.id, version: 1 }, { id: c.id, version: 1 }] })), /重复/));
  (await assert.rejects(async () => (await svc.deleteDrafts({ projectId: project.id, items: [] }))));
});
test('待修改内容可删除，删除后原客户链接失效', async () => {
  const c = (await content()), submitted = (await svc.transition(c.id, { action: 'submit', version: 1 }));
  (await svc.transition(c.id, { action: 'request_changes', version: 1, comment: '需要补充镜头' }));
  (await svc.deleteDrafts({ projectId: project.id, items: [{ id: c.id, version: 1 }] }));
  (await assert.rejects(async () => (await svc.reviewContent(submitted.reviewToken!)), /失效/));
});
