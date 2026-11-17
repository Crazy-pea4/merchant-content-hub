import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startHarness } from './harness.mjs';

const docker = Boolean(process.env.HUB_TEST_DOCKER_IMAGE);
const calls = [];
let failNext = false;
const provider = createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer studio-test') { res.writeHead(403).end(); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  calls.push(body);
  if (failNext) {
    failNext = false;
    res.writeHead(503).end();
    return;
  }
  const work = { title: '创作稿 ' + calls.length, body: '## 开场\n两个人在站台相遇。\n\n## 第二场\n列车进站。' };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(work) } }] }));
});
await new Promise(resolve => provider.listen(0, docker ? '0.0.0.0' : '127.0.0.1', resolve));
let harness, browser;
try {
  const address = 'http://' + (docker ? 'host.docker.internal' : '127.0.0.1') + ':' + provider.address().port;
  harness = await startHarness({ auth: true, asrEnvironment: {
    AI_BASE_URL: address, AI_API_KEY: 'studio-test', AI_MODEL: 'writing-test',
    VISION_BASE_URL: address, VISION_API_KEY: 'studio-test', VISION_MODEL: 'vision-test',
  } });
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = async () => (await page.request.get(harness.base + '/api/studio')).json();
  await page.goto(harness.base);
  await page.getByLabel('访问口令').fill(harness.token);
  await page.getByRole('button', { name: '进入创作室' }).click();
  await expect(page.getByRole('heading', { name: '今天，想创作什么？' })).toBeVisible();
  if (process.env.STUDIO_SCREENSHOTS) await page.screenshot({ path: join(process.env.STUDIO_SCREENSHOTS, '创作室-首页.png') });
  const input = page.getByRole('textbox', { name: '创作要求' });
  await input.fill('写一个发生在车站的剧本');
  await input.press('Enter');
  const docs = page.locator('.studio-document');
  await expect(docs).toHaveCount(1);
  await docs.first().getByRole('button', { name: '直接编辑' }).click();
  await page.getByLabel('作品正文').fill('## 开场\n雨伞遗落在站台长椅上。');
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(docs.first()).toContainText('雨伞遗落');
  const first = (await state()).sessions[0];
  const endpoint = harness.base + '/api/studio-sessions/' + first.id + '/turns';
  const stale = await page.request.patch(endpoint, { data: { id: first.turns[0].id, version: 1, title: '旧标题', body: '旧稿' } });
  assert.equal(stale.status(), 409);
  failNext = true;
  await input.fill('把这一场改成喜剧');
  await input.press('Enter');
  await page.getByRole('button', { name: '重新生成' }).click();
  await expect(docs).toHaveCount(2);
  assert.match(JSON.stringify(calls.at(-1).messages), /雨伞遗落/);
  await page.reload();
  await expect(docs).toHaveCount(2);
  await page.getByRole('button', { name: '我的资产', exact: true }).click();
  await expect(page.locator('.shelf-card')).toHaveCount(2);
  await page.getByRole('button', { name: '新创作' }).click();

  const videos = ['red', 'blue'].map(color => {
    const path = join(harness.directory, color + '.mp4');
    execFileSync('ffmpeg', ['-loglevel','error','-f','lavfi','-i','color=c='+color+':s=96x64:r=12:d=2','-pix_fmt','yuv420p',path]);
    return path;
  });
  await page.getByRole('button', { name: /把视频变成分镜/ }).click();
  await page.locator('input[type=file]').setInputFiles(videos);
  await page.getByRole('button', { name: '发送创作要求' }).click();
  await expect(docs).toHaveCount(1, { timeout: 30000 });
  assert.equal(calls.at(-1).model, 'vision-test');
  const images = calls.at(-1).messages.at(-1).content.filter(part => part.type === 'image_url');
  assert.equal(images.length, 6);
  assert.ok(images.every(part => part.image_url.url.startsWith('data:image/jpeg;base64,')));
  assert.notEqual(images[0].image_url.url, images[3].image_url.url);
  await page.getByRole('navigation').getByRole('button', { name: '素材画布' }).click();
  const nodes = page.locator('.board-node');
  await expect(nodes).toHaveCount(3);
  await expect(page.locator('.board-lines .automatic')).toHaveCount(2);
  const source = nodes.filter({ hasText: 'red.mp4' }), target = nodes.filter({ hasText: 'blue.mp4' });
  await source.locator('.board-port').click();
  await target.locator('.board-inlet').click();
  await expect(page.locator('.board-lines .manual')).toHaveCount(1);
  const box = await source.locator('.board-type').boundingBox();
  await page.mouse.move(box.x + 25, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + 45, box.y + 66, { steps: 6 });
  await page.mouse.up();
  const sessionId = new URL(page.url()).searchParams.get('s');
  await expect.poll(async () => Object.keys((await state()).sessions.find(s => s.id === sessionId).positions).length).toBe(1);
  await page.reload();
  await expect(page.locator('.board-lines .manual')).toHaveCount(1);
  if (process.env.STUDIO_SCREENSHOTS) await page.screenshot({ path: join(process.env.STUDIO_SCREENSHOTS, '创作室-画布.png') });
  await page.getByRole('button', { name: '我的资产', exact: true }).click();
  await expect(page.locator('.shelf-card')).toHaveCount(5);
  await page.getByRole('button', { name: '创作工具' }).click();
  await page.getByRole('button', { name: '声音克隆与配音' }).click();
  await expect(page.getByRole('heading', { name: '制作一段配音' })).toBeVisible();
  await page.getByRole('button', { name: '抖音文案提取' }).click();
  await expect(page.getByLabel('抖音分享链接或完整分享文字')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(harness.base);
  await expect(input).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.STUDIO_SCREENSHOTS) await page.screenshot({ path: join(process.env.STUDIO_SCREENSHOTS, '创作室-手机.png') });
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('button', { name: '我的资产', exact: true }).click();
  await expect(page.locator('.shelf-card')).toHaveCount(5);
  assert.deepEqual(errors, []);
  console.log('PASS 系统 Chrome：登录、直接创作、原地编辑、冲突保护、失败重试、带编辑上下文续写、双视频六帧分镜、自动归档、画布连线与位置持久化、集成工具、手机导航');
} finally {
  await browser?.close();
  await harness?.stop();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
}
