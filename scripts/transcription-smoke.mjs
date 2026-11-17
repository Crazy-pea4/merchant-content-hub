import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startHarness } from './harness.mjs';

let held = true, fail = false, calls = 0; const releases = new Set();
const release = () => { held = false; for (const done of releases) done(); releases.clear(); };
const provider = createServer(async (request, response) => {
  for await (const _chunk of request) { /* Consume the actual extracted audio upload. */ }
  assert.equal(request.url, '/audio/transcriptions'); assert.equal(request.headers.authorization, 'Bearer background-mock-only');
  calls++;
  if (held) await new Promise(done => releases.add(done));
  response.writeHead(fail ? 503 : 200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(fail ? { error: 'deliberate isolated failure' } : { segments: [{ start: 0.1, end: 4.8, text: '老板讲述开店故事，演示手冲咖啡。' }] }));
});
await new Promise(done => provider.listen(0, '0.0.0.0', done));
const address = provider.address();
const host = process.env.HUB_TEST_DOCKER_IMAGE ? 'host.docker.internal' : '127.0.0.1';
let harness;
try { harness = await startHarness({ seed: true, auth: false, asrEnvironment: { ASR_PROVIDER: 'openai', ASR_API_KEY: 'background-mock-only', ASR_BASE_URL: `http://${host}:${address.port}`, ASR_MODEL: 'mock-asr', ASR_WORKER_ENABLED: 'true' } }); } catch (error) { provider.closeAllConnections(); await new Promise(done => provider.close(done)); throw error; }
const output = resolve(process.env.SCREENSHOT_DIR || 'data/qa'); await mkdir(output, { recursive: true });
let browser; const checks = [];
try {
  const video = join(harness.directory, 'background-asr.mp4');
  if (!harness.generateVideoFixture) throw new Error('Run this check with HUB_TEST_DOCKER_IMAGE=merchant-content-hub:local');
  await harness.generateVideoFixture(video);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  const errors = []; let manualRequests = 0; page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/transcribe')) manualRequests++; });
  const snapshot = async () => (await page.request.get(harness.base + '/api/snapshot')).json();
  const assetState = async id => (await snapshot()).assets.find(asset => asset.id === id);
  await page.goto(harness.base + '/archive'); await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const nav = name => page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
  async function upload() {
    await nav('素材资产库'); await page.getByRole('button', { name: '上传素材', exact: true }).first().click();
    const dialog = page.getByRole('dialog'); await dialog.locator('input[name=file]').setInputFiles(video);
    await dialog.getByLabel('使用授权').click(); await page.getByRole('option', { name: '已确认授权', exact: true }).click();
    const response = page.waitForResponse(result => result.request().method() === 'POST' && new URL(result.url()).pathname === '/api/assets');
    await dialog.getByRole('button', { name: '上传并入库', exact: true }).click(); const result = await response;
    assert.equal(result.status(), 201); const asset = await result.json(); assert.equal(asset.transcription.status, 'queued');
    await expect(dialog).toBeHidden(); return asset;
  }
  const first = await upload(); await expect.poll(() => calls).toBe(1);
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await nav('拍摄任务'); await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByRole('dialog').getByLabel('任务名称').fill('后台识别期间仍可创建任务');
  await page.getByRole('dialog').getByRole('button', { name: '保存任务', exact: true }).click(); await expect(page.getByRole('dialog')).toBeHidden();
  assert.ok((await snapshot()).tasks.some(task => task.title === '后台识别期间仍可创建任务'));
  assert.equal((await assetState(first.id)).transcription.status, 'processing');
  checks.push('上传自动排队并立即返回；识别期间可导航和创建拍摄任务，无全局阻塞');
  await nav('AI 创作台');
  const sourcePreview = page.getByRole('region', { name: '本次创作参考素材', exact: true });
  await expect(sourcePreview).toContainText('background-asr.mp4'); await expect(sourcePreview).toContainText('转写中 · 暂仅参考名称与标签');
  await nav('素材资产库'); await page.locator('.asset-card').filter({ hasText: 'background-asr.mp4' }).first().click();
  let dialog = page.getByRole('dialog'); await expect(dialog.locator('.transcription-notice')).toContainText('后台转写中'); await expect(dialog.locator('.detail-meta')).not.toContainText('待录入逐字稿');
  const draft = '尚未保存的人工输入不能被刷新覆盖'; await dialog.getByRole('textbox', { name: '逐字稿或SRT字幕' }).fill(draft);
  await page.screenshot({ path: join(output, 'background-asr-processing.png'), animations: 'disabled' });
  release(); await expect(dialog.locator('.transcription-notice')).toContainText('语音转写完成', { timeout: 12000 });
  await expect(dialog.getByRole('textbox', { name: '逐字稿或SRT字幕' })).toHaveValue(draft);
  await page.keyboard.press('Escape'); await page.locator('.asset-card').filter({ hasText: 'background-asr.mp4' }).first().click();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: '逐字稿或SRT字幕' })).toHaveValue(/老板讲述开店故事/);
  await page.keyboard.press('Escape'); assert.equal(manualRequests, 0);
  checks.push('无需手动请求，完成后状态 / 时间码自动更新；未保存人工输入得到保留');
  fail = true; const second = await upload(); await expect.poll(async () => (await assetState(second.id)).transcription.status, { timeout: 10000 }).toBe('failed');
  await page.locator('.asset-card').filter({ hasText: 'background-asr.mp4' }).first().click(); dialog = page.getByRole('dialog');
  await expect(dialog.locator('.transcription-notice')).toContainText('语音转写失败', { timeout: 10000 });
  fail = false; held = true;
  const retryResponse = page.waitForResponse(result => result.url().includes('/transcribe') && result.request().method() === 'POST');
  await dialog.getByRole('button', { name: '重试转写', exact: true }).click(); assert.equal((await retryResponse).status(), 202);
  await expect(dialog.getByRole('button', { name: '后台转写中', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await nav('内容日历'); await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await expect.poll(() => calls).toBe(3); release(); await expect.poll(async () => (await assetState(second.id)).transcription.status, { timeout: 10000 }).toBe('completed');
  checks.push('失败有状态与重试入口；重试返回 202，处理中仍可使用其他页面');
  held = true; const third = await upload(); await expect.poll(() => calls).toBe(4); await page.close(); release();
  await expect.poll(async () => { const result = await fetch(harness.base + '/api/snapshot'); return (await result.json()).assets.find(asset => asset.id === third.id).transcription.status; }, { timeout: 10000 }).toBe('completed');
  checks.push('页面全部关闭后，后台仍完成转写并入库');
  const restoredPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await restoredPage.goto(harness.base + '/archive'); await expect(restoredPage.getByRole('heading', { level: 1 })).toBeVisible();
  await restoredPage.getByRole('button', { name: '打开导航', exact: true }).click(); await restoredPage.getByRole('navigation').getByRole('button', { name: '素材资产库', exact: true }).click();
  await expect(restoredPage.locator('.asset-card').filter({ hasText: 'background-asr.mp4' }).first()).toContainText('语音转写完成');
  await restoredPage.locator('.asset-card').filter({ hasText: 'background-asr.mp4' }).first().click(); await expect(restoredPage.getByRole('dialog').locator('.segment-list')).toContainText('00:00 – 00:04');
  assert.ok(await restoredPage.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await restoredPage.screenshot({ path: join(output, 'background-asr-mobile-complete.png') });
  checks.push('重新打开与手机视口可查看完成状态、逐字稿和时间定位');
  assert.deepEqual(errors, []); assert.equal(calls, 4);
  console.log(JSON.stringify({ checks, provider: 'local HTTP mock; no billable calls', providerCalls: calls, pageErrors: errors.length }));
} finally {
  release(); if (browser) await browser.close(); await harness.stop();
  provider.closeAllConnections(); await new Promise(done => provider.close(done));
}
