import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { startHarness } from './harness.mjs';

const output = resolve(process.env.SCREENSHOT_DIR || 'data/qa/design-review');
await mkdir(output, { recursive: true });
const harness = await startHarness({ seed: true, auth: true });
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  async function visit(path, target) {
    await page.goto(harness.base + path);
    await expect(page.locator(target).first()).toBeVisible();
  }
  async function theme(name) {
    if (await page.locator('html').getAttribute('data-theme') !== name) {
      await page.getByRole('button', { name: name === 'dark' ? '切换到暗色主题' : '切换到明亮主题' }).click();
    }
    await expect(page.locator('html')).toHaveAttribute('data-theme', name);
  }
  async function capture(name, mode) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, name + ' horizontal overflow');
    await page.screenshot({ path: join(output, name + '-' + mode + '.png'), animations: 'disabled' });
  }
  async function pair(name) {
    for (const mode of ['dark', 'light']) {
      await theme(mode);
      await capture(name, mode);
    }
  }
  await visit('/', '.studio-login input');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await pair('10-login');
  await page.reload();
  await expect(page.getByRole('button', { name: '切换到暗色主题' })).toBeVisible();
  await page.getByLabel('访问口令').fill(harness.token);
  await page.getByRole('button', { name: '进入创作室' }).click();
  await expect(page.locator('.welcome-hero')).toBeVisible();
  const request = context.request;
  const session = randomUUID(), turn = randomUUID();
  async function post(path, args) {
    const response = await request.post(harness.base + '/api/' + path, args);
    assert.ok(response.ok(), path + ' ' + response.status() + ' ' + (response.ok() ? '' : await response.text()));
    return response.json();
  }

  // Exercise the thumbnail and player using a real file in the isolated test store.
  await post('studio-sessions', { data: { id: session, title: '山间晨光 · 拍摄日记' } });
  const fixture = join(harness.directory, 'morning.mp4');
  execFileSync('ffmpeg', ['-v','error','-y','-loop','1','-i','public/studio/hero-dawn.webp','-vf','scale=720:-2','-t','2','-r','12','-c:v','libx264','-pix_fmt','yuv420p',fixture]);
  const clip = await post('assets', { multipart: { projectId: session, rights: 'authorized', file: { name: '山脊上的晨光.mp4', mimeType: 'video/mp4', buffer: await readFile(fixture) } } });
  await post('studio-sessions/' + session + '/turns', { data: { id: turn, prompt: '为这段晨光写一份短片拍摄脚本。', mode: 'script', assetIds: [clip.id] } });
  const submitted = await post('contents/c-demo/transition', { data: { action: 'submit', version: 1 } });

  await visit('/', '.recent-creation');
  await pair('01-home');
  await theme('dark');
  await expect(page.locator('.creator-shell')).toHaveCSS('background-color', 'rgb(20, 21, 29)');
  const heroBackground = () => page.locator('.welcome-hero').evaluate(el => getComputedStyle(el, '::before').backgroundImage);
  await expect.poll(heroBackground).toContain('hero-dusk.webp');
  await theme('light');
  await expect(page.locator('.creator-shell')).toHaveCSS('background-color', 'rgb(246, 245, 251)');
  await expect.poll(heroBackground).toContain('hero-dawn.webp');
  for (const art of ['dawn','dusk']) assert.ok((await request.get(harness.base + '/studio/hero-' + art + '.webp')).ok());
  await page.getByRole('button', { name: '搜索素材、作品或会话' }).click();
  await page.getByLabel('搜索关键词').fill('山间晨光');
  await page.getByRole('dialog').getByRole('button', { name: /山间晨光/ }).click();
  await expect(page.locator('.conversation-title')).toContainText('山间晨光');
  await pair('02-session');
  await visit('/?tab=assets', '.shelf-grid');
  await pair('03-library');
  await page.getByRole('button', { name: '素材', exact: true }).click();
  await page.getByLabel('搜索资产').fill('山脊上的晨光');
  await expect(page.locator('.shelf-card')).toHaveCount(1);
  await page.locator('.shelf-card').click();
  await expect.poll(() => page.locator('video').evaluate(el => el.readyState)).toBeGreaterThanOrEqual(2);
  await pair('05-media');
  await visit('/?tab=assets&item=w:' + turn, '.doc-actions');
  await page.getByRole('button', { name: '直接编辑' }).click();
  await expect(page.getByLabel('作品正文')).toBeEditable();
  await pair('04-editor');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(page.locator('.writing-sheet .studio-prose')).toBeVisible();
  await page.getByRole('button', { name: '返回编辑' }).click();
  await expect(page.getByLabel('作品正文')).toBeEditable();
  await visit('/?tab=board&s=' + session, '.board-node');
  await expect.poll(() => page.locator('.automatic .react-flow__edge-path').first().evaluate(path => path.getTotalLength())).toBeGreaterThan(0);
  await expect(page.locator('.board-thumb')).toBeVisible();
  await pair('06-board');
  await visit('/?tab=dubbing', '.dubbing-script-form');
  await pair('07-voice');
  await visit('/?tab=douyin', '.douyin-input');
  await pair('08-subtitles');
  await visit('/narration', '.narration-upload-card');
  await pair('09-narration');

  for (const [tab, name, target] of [
    ['overview', '11-overview', '.welcome-panel'], ['projects','12-projects','.business-bar'],
    ['assets','13-archive-assets','.search-panel'], ['create','14-archive-create','.creative-brief'],
    ['tasks','15-tasks','.task-row'], ['review','16-delivery','.review-grid'], ['calendar','17-calendar','.month-grid'],
  ]) {
    await visit('/archive?tab=' + tab, target);
    await pair(name);
  }
  const month = await page.locator('.month-surface h2').textContent();
  await page.getByRole('button', { name: '下个月' }).click();
  await expect(page.locator('.month-surface h2')).not.toHaveText(month);
  await page.getByRole('button', { name: '上个月' }).click();
  await expect(page.locator('.month-surface h2')).toHaveText(month);
  await page.getByRole('button', { name: '今天', exact: true }).click();
  await expect(page.locator('.month-grid button[aria-pressed=true]')).toHaveCount(1);
  // A modal traps focus. Switch appearance before opening each time.
  for (const mode of ['dark','light']) {
    await theme(mode);
    await page.getByRole('button', { name: '上传素材', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await capture('19-dialogs', mode);
    await page.keyboard.press('Escape');
  }
  await visit(submitted.reviewUrl, '.portal-content');
  await pair('18-client');
  await visit('/review/invalid-test-link', '.portal-loading h1');
  await pair('21-status');
  await visit('/missing-page-test', '.missing-page');
  await pair('21-not-found');
  await page.setViewportSize({ width: 390, height: 844 });
  await visit('/', '.welcome-hero');
  await pair('20-mobile-home');
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.locator('.creator-rail.open')).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: '我的资产' }).click();
  await pair('20-mobile-assets');
  await visit(submitted.reviewUrl, '.portal-content');
  await pair('20-mobile-review');

  assert.deepEqual(failures, []);
  console.log('PASS 系统 Chrome：两套主题、刷新保留、山景资源、会话与资产搜索、月历和手机导航。页面截图：' + output);
} finally {
  await browser?.close();
  await harness.stop();
}
