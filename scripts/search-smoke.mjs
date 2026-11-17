import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startHarness } from './harness.mjs';

process.env.HUB_TEST_DOCKER_IMAGE ||= 'merchant-content-hub:local';
const harness = await startHarness({ seed: true, auth: false });
const output = resolve(process.env.SCREENSHOT_DIR || 'data/qa'); await mkdir(output, { recursive: true });
let browser; const checks = [], errors = [];
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  const post = async (path, data) => { const response = await page.request.post(harness.base + '/api/' + path, { data }); assert.equal(response.status(), 201); return response.json(); };
  const project = await post('projects', { merchantId: 'm-demo-coffee', name: '分组搜索验收', mode: 'shoot', dueDate: '', deliverables: 3 });
  const fixture = join(harness.directory, 'search-fixture.mp4'); await harness.generateVideoFixture(fixture); const buffer = await readFile(fixture);
  const upload = async (name, bytes, mimeType) => { const response = await page.request.post(harness.base + '/api/assets', { multipart: { projectId: project.id, rights: 'authorized', file: { name, mimeType, buffer: bytes } } }); assert.equal(response.status(), 201); return response.json(); };
  const one = await upload('门店采访甲.mp4', buffer, 'video/mp4');
  const two = await upload('较长文件名的门店采访乙'.repeat(6) + '.mp4', buffer, 'video/mp4');
  await upload('维护文稿.txt', Buffer.from('电池使用说明：保持干燥，按要求检查接头。'), 'text/plain');
  for (const [asset, transcript] of [
    [one, '1\n00:00:00,500 --> 00:00:01,800\n挑选电池前先确认每天的行驶距离。\n\n2\n00:00:02,000 --> 00:00:03,700\n电池容量需要结合实际载重。\n\n3\n00:00:04,000 --> 00:00:04,800\n保护好接头。'],
    [two, '1\n00:00:01,000 --> 00:00:02,000\n电池使用后先检查接头是否牢固。\n\n2\n00:00:03,000 --> 00:00:04,000\n电池需要放在干燥的位置。']
  ]) { const response = await page.request.patch(harness.base + '/api/assets/' + asset.id, { data: { transcript } }); assert.equal(response.status(), 200); }
  await page.goto(harness.base + '/archive'); await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: '切换项目', exact: true }).click(); await page.getByRole('option', { name: /分组搜索验收/ }).click();
  const nav = async name => { if (await page.getByRole('button', { name: '打开导航', exact: true }).isVisible()) await page.getByRole('button', { name: '打开导航', exact: true }).click(); await page.getByRole('navigation').getByRole('button', { name, exact: true }).click(); };
  await nav('素材资产库'); await expect(page.locator('.asset-card')).toHaveCount(3);
  const query = page.getByRole('textbox', { name: '自然语言搜索素材' });
  const reset = page.getByRole('button', { name: '返回素材列表', exact: true });
  const search = async (term = '电池') => { await query.fill(term); const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/search'); await page.getByRole('button', { name: '查找素材', exact: true }).click(); assert.equal((await response).status(), 200); await expect(page.locator('.search-loading')).toHaveCount(0); };
  const restored = async () => { await expect(page.locator('.asset-card')).toHaveCount(3); await expect(page.locator('.search-results')).toHaveCount(0); await expect(query).toHaveValue(''); await expect(page.getByRole('tab', { name: /全部素材/ })).toHaveAttribute('aria-selected', 'true'); };
  await search(); await expect(page.locator('.search-asset-group')).toHaveCount(3); await expect(page.locator('.search-segment')).toHaveCount(5);
  await expect(page.locator('.asset-search-status')).toContainText('找到 3 份素材 · 5 个匹配项');
  const first = page.locator(`[data-asset-id="${one.id}"]`), second = page.locator(`[data-asset-id="${two.id}"]`);
  await expect(first.locator('.search-segment')).toHaveCount(2); await expect(second.locator('.search-segment')).toHaveCount(2);
  await expect(first).toContainText('每天的行驶距离'); await expect(first).not.toContainText('干燥的位置'); await expect(second).toContainText('干燥的位置');
  assert.deepEqual(await first.locator('.search-segment-time').allTextContents(), ['00:00 – 00:01', '00:02 – 00:03']);
  await page.screenshot({ path: join(output, 'asset-search-grouped-desktop.png'), fullPage: true });
  checks.push('两个真实视频和一份文稿按素材分组；标题、匹配数与片段归属清楚，片段按时间排列');
  await first.locator('.search-segment').nth(1).click(); const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(one.name); await expect.poll(() => dialog.locator('video').evaluate(media => media.currentTime)).toBeCloseTo(2, 1); assert.equal(await dialog.locator('video').evaluate(media => media.paused), true);
  await page.keyboard.press('Escape'); await expect(page.locator('.search-asset-group')).toHaveCount(3);
  checks.push('点击第二个命中片段打开正确视频并定位 2 秒，关闭详情仍保留搜索结果');
  await reset.click(); await restored(); await search(); await query.fill(''); await restored();
  await search(); await page.getByRole('tab', { name: /全部素材/ }).click(); await restored();
  await search(); await page.getByRole('button', { name: '清空搜索并返回素材列表', exact: true }).click(); await restored();
  checks.push('返回素材列表、删空搜索词、点击已选中的全部素材、搜索框清空按钮均恢复原列表');
  await search(); await page.getByRole('tab', { name: '视频', exact: true }).click(); await expect(page.locator('.search-asset-group')).toHaveCount(2); await expect(page.locator('.asset-search-status')).toContainText('找到 2 份素材 · 4 个匹配项');
  await page.getByRole('tab', { name: '音频', exact: true }).click(); await expect(page.getByText('当前素材类型没有匹配项，可以切换其他类型，或点击“返回素材列表”。', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /全部素材/ }).click(); await restored();
  await search('ZXQ987654'); await expect(page.locator('.search-asset-group')).toHaveCount(0); await expect(reset).toBeVisible(); await reset.click(); await restored();
  await search(); await nav('拍摄任务'); await nav('素材资产库'); await restored();
  checks.push('类型筛选显示正确的分组与计数；无结果和重新进入素材库时也可返回原列表');
  for (const action of ['return', 'project']) {
    let release, arrived, done; const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { arrived = resolve; }), finished = new Promise(resolve => { done = resolve; });
    const handler = async route => { const response = await route.fetch(); arrived(); await held; try { await route.fulfill({ response }); } catch { /* A cancelled request may already be closed. */ } finally { done(); } };
    await page.route('**/api/search?**', handler); await query.fill('电池'); await page.getByRole('button', { name: '查找素材', exact: true }).click(); await entered;
    await expect(page.locator('.search-loading')).toBeVisible(); await expect(page.locator('.busy-indicator')).toHaveCount(0);
    if (action === 'return') { await reset.click(); await restored(); }
    else { await page.getByRole('combobox', { name: '切换项目', exact: true }).click(); await page.getByRole('option', { name: /本色理发室/ }).click(); await expect(query).toHaveValue(''); }
    release(); await finished; await page.unroute('**/api/search?**', handler); await expect(page.locator('.search-results')).toHaveCount(0);
    if (action === 'return') await restored();
    else { await page.getByRole('combobox', { name: '切换项目', exact: true }).click(); await page.getByRole('option', { name: /分组搜索验收/ }).click(); await restored(); }
  }
  checks.push('搜索等待时可立即返回或切项目；迟到的旧结果不会恢复搜索状态或混入其他项目');
  await page.setViewportSize({ width: 390, height: 844 }); await search();
  await expect(page.locator('.search-asset-group')).toHaveCount(3); await expect(page.locator('.search-segment-time').first()).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(output, 'asset-search-grouped-mobile.png'), fullPage: true });
  await reset.click(); await restored();
  checks.push('390px 手机布局中长文件名、时间码与返回按钮可用，无横向溢出');
  assert.deepEqual(errors, []); const report = { checks, pageErrors: errors.length, isolated: true, realModelCalls: false };
  await writeFile(join(output, 'asset-search-check.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await browser?.close(); await harness.stop(); }
