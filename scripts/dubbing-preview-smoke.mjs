import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { startHarness } from './harness.mjs';

const output = resolve(process.env.SCREENSHOT_DIR || 'data/qa'); await mkdir(output, { recursive: true });
const wav = join(output, 'preview-fixture.wav'), mp3 = join(output, 'preview-fixture.mp3');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', wav]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, mp3]);
let base = '', creates = 0, failNext = false, nextGate = null;
const syntheses = [], checks = [], errors = [], previewRequests = [];
const server = createServer(async (req, res) => {
  if (req.url === '/result.mp3') { res.setHeader('Content-Type', 'audio/mpeg'); res.end(await readFile(mp3)); return; }
  assert.equal(req.headers.authorization, 'Bearer preview-test-only');
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); res.setHeader('Content-Type', 'application/json');
  if (body.input.action === 'create_voice') { creates++; res.end(JSON.stringify({ output: { voice_id: 'cosyvoice-v3-flash-preview-' + creates } })); }
  else if (body.input.action === 'query_voice') res.end(JSON.stringify({ output: { status: 'OK', target_model: 'cosyvoice-v3-flash' } }));
  else {
    syntheses.push(body.input);
    if (failNext) { failNext = false; res.writeHead(503); res.end(JSON.stringify({ error: 'private-provider-error' })); return; }
    const gate = nextGate; nextGate = null; if (gate) await gate;
    res.end(JSON.stringify({ output: { audio: { url: base + '/result.mp3' } } }));
  }
});
let browser, harness, release;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  assert.ok(!process.env.HUB_TEST_DOCKER_IMAGE, 'This browser test uses a local loopback provider');
  harness = await startHarness({ seed: false, auth: false, asrEnvironment: { TTS_API_KEY: 'preview-test-only', TTS_BASE_URL: base + '/api/v1', TTS_MODEL: 'cosyvoice-v3-flash' } });
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (new URL(req.url()).pathname === '/api/dubbings/preview') previewRequests.push(req.postDataJSON()); });
  const snapshot = () => page.request.get(harness.base + '/api/dubbing-workspace').then(r => r.json());
  for (const name of ['试听测试音色', '另一个测试音色']) {
    const response = await page.request.post(harness.base + '/api/voices', { multipart: { requestId: randomUUID(), name, consent: 'true', file: { name: 'voice.wav', mimeType: 'audio/wav', buffer: await readFile(wav) } } }); assert.equal(response.status(), 202);
  }
  await expect.poll(async () => (await snapshot()).voices.filter(v => v.status === 'ready').length).toBe(2);
  await page.goto(harness.base + '/dubbing');
  const listen = () => page.getByRole('button', { name: '试听前5秒', exact: true });
  const player = page.getByLabel('当前文案前5秒试听', { exact: true });
  const full = page.getByRole('button', { name: '生成完整配音', exact: true });
  const copy = page.getByLabel('朗读文案', { exact: true });
  await expect(listen()).toBeDisabled();
  await page.locator('.dubbing-voice').filter({ hasText: '试听测试音色' }).getByRole('button', { name: '使用这个音色' }).click();
  const original = '你好，这是生成前的试听文案。Hello, this is a short preview. '.repeat(15) + '末尾不应合成';
  await copy.fill(original); await listen().click(); await expect(player).toBeVisible();
  await expect.poll(() => player.evaluate(audio => audio.duration)).toBeGreaterThan(4.8);
  assert.ok(await player.evaluate(audio => audio.duration < 5.2)); assert.equal(syntheses.length, 1);
  assert.ok(original.startsWith(syntheses[0].text)); assert.ok(syntheses[0].text.length < original.length); assert.ok(!syntheses[0].text.includes('末尾不应合成'));
  assert.equal((await snapshot()).dubbings.length, 0);
  await page.getByRole('button', { name: '再听一次', exact: true }).click(); assert.equal(syntheses.length, 1); assert.equal(previewRequests.length, 1);
  const oldPlayer = await player.elementHandle();
  await page.getByLabel('朗读语速', { exact: true }).click(); await page.getByRole('option', { name: '舒缓 · 0.75 倍', exact: true }).click();
  await expect(player).toHaveCount(0); assert.equal(await oldPlayer.evaluate(audio => audio.paused), true); await oldPlayer.dispose();
  await listen().click(); await expect(player).toBeVisible(); assert.equal(syntheses.length, 2); assert.equal(syntheses.at(-1).rate, 0.75);
  await copy.fill('临时改动的文案。'); await expect(player).toHaveCount(0); await copy.fill(original); await expect(player).toHaveCount(0);
  await listen().click(); await expect(player).toBeVisible(); assert.equal(syntheses.length, 2);
  checks.push('只合成开头并裁剪约5秒，试听不产生正式记录；本地重播与相同参数的再次试听不重复合成');
  await page.locator('.dubbing-voice').filter({ hasText: '另一个测试音色' }).getByRole('button', { name: '使用这个音色' }).click();
  await expect(player).toHaveCount(0); await listen().click(); await expect(player).toBeVisible(); assert.equal(syntheses.length, 3);
  checks.push('修改文案、音色、语速立即移除旧试听并停止播放；改回原文可重新使用缓存音频');
  nextGate = new Promise(resolve => { release = resolve; });
  await copy.fill('这条延迟返回的试听需要被丢弃。'); await listen().click();
  await expect.poll(() => syntheses.length).toBe(4); await expect(full).toBeDisabled();
  const oldRequest = previewRequests.at(-1);
  await page.getByLabel('朗读情感', { exact: true }).click(); await page.getByRole('option', { name: '温暖亲切', exact: true }).click();
  await copy.fill('这是修改后需要试听的新文案。'); await expect(listen()).toBeEnabled(); await listen().click(); await expect(player).toBeVisible();
  const newUrl = await player.getAttribute('src'); release();
  const recovered = await page.request.post(harness.base + '/api/dubbings/preview', { data: oldRequest }); assert.equal(recovered.status(), 200);
  assert.equal(await player.getAttribute('src'), newUrl); assert.equal(syntheses.length, 5); assert.equal((await snapshot()).dubbings.length, 0);
  checks.push('输入变化时中止等待，延迟旧结果不会恢复；已接受的同请求可复用结果，不自动重提');
  const expressionBefore = syntheses.length;
  await page.getByLabel('朗读语调', { exact: true }).click(); await page.getByRole('option', { name: '讲述故事', exact: true }).click();
  await page.getByLabel('声音音高', { exact: true }).click(); await page.getByRole('option', { name: '稍高 · 1.1 倍', exact: true }).click();
  await expect(player).toHaveCount(0); await listen().click(); await expect(player).toBeVisible();
  assert.equal(syntheses.length, expressionBefore + 1); assert.equal(syntheses.at(-1).pitch, 1.1); assert.equal(syntheses.at(-1).instruction, '用讲故事的语调，句间停顿自然。语气温暖亲切。');
  await page.getByLabel('朗读情感', { exact: true }).click(); await page.getByRole('option', { name: '兴奋有活力', exact: true }).click();
  await expect(player).toHaveCount(0); await listen().click(); await expect(player).toBeVisible(); assert.equal(syntheses.length, expressionBefore + 2); assert.match(syntheses.at(-1).instruction, /兴奋/);
  await page.getByLabel('朗读语调', { exact: true }).click(); await page.getByRole('option', { name: '清晰播报', exact: true }).click();
  await expect(player).toHaveCount(0); await listen().click(); await expect(player).toBeVisible(); assert.equal(syntheses.length, expressionBefore + 3); assert.match(syntheses.at(-1).instruction, /清晰播报/);
  await page.getByLabel('声音音高', { exact: true }).click(); await page.getByRole('option', { name: '稍低 · 0.9 倍', exact: true }).click();
  await expect(player).toHaveCount(0); await listen().click(); await expect(player).toBeVisible(); assert.equal(syntheses.length, expressionBefore + 4); assert.equal(syntheses.at(-1).pitch, 0.9);
  checks.push('语调、情感和音高改变会清除旧试听且不复用错误参数缓存，选择会实际传至语音模型');
  failNext = true; await copy.fill('这条文案用于验证试听失败的提示。'); await listen().click();
  await expect(page.locator('.dubbing-audition').getByRole('alert')).toContainText('503');
  await expect(copy).toHaveValue('这条文案用于验证试听失败的提示。'); assert.equal((await snapshot()).dubbings.length, 0);
  await listen().click(); await expect(player).toBeVisible();
  await page.screenshot({ path: join(output, 'dubbing-preview-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  assert.ok(await player.evaluate(audio => audio.getBoundingClientRect().height >= 35));
  await page.screenshot({ path: join(output, 'dubbing-preview-mobile.png'), fullPage: true });
  const { text: previewText, ...confirmedParameters } = syntheses.at(-1);
  const confirmedRequest = previewRequests.at(-1);
  await page.getByLabel('配音名称', { exact: true }).fill('试听确认后的完整配音'); await full.click();
  await expect(page.getByRole('link', { name: '下载 MP3' })).toHaveCount(1, { timeout: 15000 });
  const saved = await snapshot(); assert.equal(saved.dubbings.length, 1); assert.equal(saved.dubbings[0].title, '试听确认后的完整配音');
  assert.ok(syntheses.at(-1).text === saved.dubbings[0].text);
  const { text: fullText, ...fullParameters } = syntheses.at(-1); assert.deepEqual(fullParameters, confirmedParameters);
  for (const key of ['tone', 'emotion', 'pitch', 'rate']) assert.equal(saved.dubbings[0][key], confirmedRequest[key]);
  await page.reload(); await expect(page.locator('.dubbing-result-meta')).toContainText('清晰播报'); await expect(page.locator('.dubbing-result-meta')).toContainText('兴奋有活力'); await expect(page.locator('.dubbing-result-meta')).toContainText('0.90');
  assert.deepEqual(errors, []); checks.push('试听与完整生成的供应商参数相同，刷新后记录保留语调、情感、音高和语速');
  checks.push('失败保留输入且不入历史；确认后完整生成才保存记录，手机播放器正常');
  const report = { checks, pageErrors: errors, synthesisAttempts: syntheses.length, fullRecordCount: saved.dubbings.length, realModelCalls: false, isolated: true, browser: 'system Google Chrome' };
  await writeFile(join(output, 'dubbing-preview-check.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { release?.(); if (browser) await browser.close(); if (harness) await harness.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
