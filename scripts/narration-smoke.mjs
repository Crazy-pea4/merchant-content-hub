import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { startHarness } from './harness.mjs';

const output = resolve('data/qa/narration'); await mkdir(output, { recursive: true });
const wav = join(output, 'voice.wav'), mp3 = join(output, 'speech.mp3'), mergedSpeech = join(output, 'merged-speech.mp3'), video = join(output, 'source.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', wav]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-t', '3', mp3]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-stream_loop', '1', '-i', wav, '-t', '9', mergedSpeech]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x9aa789:s=640x360:r=12:d=6', '-f', 'lavfi', '-i', 'color=c=0x617b92:s=640x360:r=12:d=6', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
let base = '', harness, browser, voiceCreates = 0, visionCalls = 0, translationCalls = 0; const inputs = [], errors = [];
const provider = createServer(async (req, res) => {
  if (req.url === '/speech.mp3') { res.setHeader('Content-Type', 'audio/mpeg'); res.end(await readFile(mp3)); return; }
  if (req.url === '/merged-speech.mp3') { res.setHeader('Content-Type', 'audio/mpeg'); res.end(await readFile(mergedSpeech)); return; }
  assert.equal(req.headers.authorization, 'Bearer narration-smoke-only');
  const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks).toString()); res.setHeader('Content-Type', 'application/json');
  if (req.url === '/translation/v1/chat/completions') {
    translationCalls++; const context = JSON.parse(body.messages[1].content);
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({segments:context.segments.map(s=>({id:s.id,lines:s.lines.map(line=>({index:line.index,text:line.source.includes('开始')?'The story begins.':'Slow down and enjoy the view.'}))}))})}}]})); return;
  }
  if (req.url.endsWith('/chat/completions')) {
    visionCalls++; const context = JSON.parse(body.messages[1].content[0].text);
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '让画面慢慢讲述', summary: '两段色彩画面，留出从容的讲述空间。', shots: context.shots.map((s, i) => ({ id: s.id, description: i ? '蓝色的画面' : '绿色的画面' })), segments: context.shots.map((s, i) => ({ startShotId: s.id, endShotId: s.id, text: i ? '把脚步放慢。' : '故事开始了。', tone: 'storytelling', emotion: 'warm', rate: 1 })) }) } }] })); return;
  }
  if (body.input.action === 'create_voice') { voiceCreates++; res.end(JSON.stringify({ output: { voice_id: 'cosyvoice-v3-flash-narration-smoke' } })); return; }
  if (body.input.action === 'query_voice') { res.end(JSON.stringify({ output: { status: 'OK', target_model: 'cosyvoice-v3-flash' } })); return; }
  inputs.push(body.input); res.end(JSON.stringify({ output: { audio: { url: base + (body.input.text.includes('新的讲述。 把脚步放慢。') ? '/merged-speech.mp3' : '/speech.mp3') } } }));
});
try {
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${provider.address().port}`;
  harness = await startHarness({ seed: false, auth: true, asrEnvironment: { AI_API_KEY: 'narration-smoke-only', AI_BASE_URL: base + '/translation/v1', AI_MODEL: 'translation-smoke', TTS_API_KEY: 'narration-smoke-only', TTS_BASE_URL: base + '/api/v1', TTS_MODEL: 'cosyvoice-v3-flash', VISION_API_KEY: 'narration-smoke-only', VISION_BASE_URL: base + '/compatible-mode/v1', VISION_MODEL: 'vision-smoke' } });
  const headers = { Authorization: 'Bearer ' + harness.token }, snapshot = () => fetch(harness.base + '/api/narration-workspace', { headers }).then(r => r.json());
  const form = new FormData(); form.set('requestId', randomUUID()); form.set('name', '我的日常声音'); form.set('consent', 'true'); form.set('file', new File([await readFile(wav)], 'voice.wav'));
  assert.equal((await fetch(harness.base + '/api/voices', { method: 'POST', headers, body: form })).status, 202);
  await expect.poll(async () => (await snapshot()).voices[0]?.status).toBe('ready');
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' }); page.on('pageerror', e => errors.push(e.message));
  await page.goto(harness.base + '/narration'); await page.getByLabel('访问口令', { exact: true }).fill(harness.token); await page.getByRole('button', { name: '进入视频旁白', exact: true }).click();
  await page.getByLabel('选择视频', { exact: true }).setInputFiles(video); await expect(page.getByLabel('旁白音色', { exact: true })).toContainText('我的日常声音');
  await page.getByRole('button', { name: '自动制作视频旁白', exact: true }).click();
  await expect(page.getByRole('link', { name: '下载 MP4', exact: true })).toBeVisible({ timeout: 30000 });
  const first = await snapshot(); assert.equal(first.projects.length, 1); assert.equal(first.renders[0].status, 'completed'); assert.equal(visionCalls, 1); assert.equal(inputs.length, 2); assert.equal(voiceCreates, 1);
  const projectId = first.projects[0].id, firstRender = first.renders[0].id, firstBytes = Buffer.from(await fetch(harness.base + '/api/narration-files/' + firstRender, { headers }).then(r => r.arrayBuffer()));
  await expect(page.getByRole('button', { name: '选择旁白2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '选择旁白1', exact: true }).click(); await page.getByLabel('旁白文案', { exact: true }).fill('新的讲述。'); await page.getByLabel('第 1 句英文译文', { exact: true }).fill('A fresh beginning.');
  await page.getByLabel('原视频声音', { exact: true }).click(); await page.getByRole('option', { name: '保留 · 25%', exact: true }).click();
  await expect(page.getByText('修改已保存在本机，尚未应用到成片', { exact: false })).toBeVisible();
  await page.reload(); await expect(page.getByLabel('旁白文案', { exact: true })).toHaveValue('新的讲述。'); await expect(page.getByLabel('第 1 句英文译文', { exact: true })).toHaveValue('A fresh beginning.');
  await expect(page.getByLabel('原视频声音', { exact: true })).toContainText('25%');
  await page.getByRole('button', { name: '试听本段旁白', exact: true }).click(); await expect(page.getByLabel('旁白试听', { exact: true })).toBeVisible(); assert.equal(inputs.length, 3);
  await page.getByRole('button', { name: '保存旁白', exact: true }).click(); await expect.poll(async () => (await snapshot()).projects[0].revision).toBe(2); assert.equal((await snapshot()).renders.length, 1);
  assert.deepEqual(Buffer.from(await fetch(harness.base + '/api/narration-files/' + firstRender, { headers }).then(r => r.arrayBuffer())), firstBytes);
  await page.getByRole('button', { name: '保存修改并生成成片', exact: true }).click();
  await expect.poll(async () => (await snapshot()).renders.filter(r => r.status === 'completed').length, { timeout: 30000 }).toBe(2); assert.equal(inputs.length, 3); assert.equal(visionCalls, 1);
  await expect(page.getByText('成片使用已保存的第 2 版旁白。修改文案后需重新生成。', { exact: true })).toBeVisible();
  const player = page.getByLabel('视频旁白预览', { exact: true }); await expect.poll(() => player.evaluate(v => v.duration)).toBeGreaterThan(11.9);
  await player.evaluate(async v => { v.muted = true; await v.play(); }); await expect.poll(() => player.evaluate(v => v.currentTime)).toBeGreaterThan(.1); await player.evaluate(v => v.pause());
  const event = page.waitForEvent('download'); await page.getByRole('link', { name: '下载 MP4', exact: true }).click(); const download = await event; assert.match(download.suggestedFilename(), /\.mp4$/); assert.ok((await readFile(await download.path())).length > 1000);
  const latest = (await snapshot()).renders[0]; const captions = await fetch(harness.base + `/api/narration-files/${latest.id}?captions`, { headers }).then(r => r.text()); assert.match(captions, /新的讲述/);
  assert.equal((await fetch(harness.base + `/api/narration-files/${latest.id}`)).status, 401);
  assert.equal((await fetch(harness.base + `/api/narration-files/${projectId}?source`)).status, 401);
  await page.getByText('字幕与剪辑文件', { exact: true }).click();
  await expect(page.getByRole('link', { name: '下载无字幕成片', exact: true })).toBeVisible();
  const englishSrt = await fetch(harness.base + `/api/narration-files/${latest.id}?captions&format=srt&track=en`, { headers }).then(r => r.text()); assert.match(englishSrt, /A fresh beginning/);
  const cleanResponse = await fetch(harness.base + `/api/narration-files/${latest.id}?clean`, { headers: { ...headers, Range: 'bytes=0-31' } }); assert.equal(cleanResponse.status, 206);
  await page.getByLabel('第 1 句英文译文', { exact: true }).fill('My own pace.'); await page.reload();
  await expect(page.getByLabel('第 1 句英文译文', { exact: true })).toHaveValue('My own pace.');
  await page.getByRole('button', { name: '保存修改并生成成片', exact: true }).click();
  await expect.poll(async () => (await snapshot()).renders.filter(r => r.status === 'completed').length, { timeout: 30000 }).toBe(3); assert.equal(inputs.length, 3); assert.equal(translationCalls, 1);
  await page.getByRole('button', { name: '合并下一段', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择旁白2', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('旁白文案', { exact: true })).toHaveValue('新的讲述。 把脚步放慢。');
  await expect(page.getByText('覆盖 2 个镜头', { exact: true }).first()).toBeVisible();
  await page.reload(); await expect(page.getByLabel('旁白文案', { exact: true })).toHaveValue('新的讲述。 把脚步放慢。');
  await expect(page.getByRole('button', { name: '选择旁白2', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '试听本段旁白', exact: true }).click(); await expect(page.getByLabel('旁白试听', { exact: true })).toBeVisible(); assert.equal(inputs.length, 4);
  await page.getByRole('button', { name: '保存修改并生成成片', exact: true }).click();
  await expect.poll(async () => (await snapshot()).renders.filter(r => r.status === 'completed').length, { timeout: 30000 }).toBe(4);
  const merged = await snapshot(); assert.equal(merged.projects[0].shots.length, 2); assert.equal(merged.projects[0].segments.length, 1); assert.equal(merged.renders[0].alignedSegments.length, 1); assert.equal(inputs.length, 4); assert.equal(visionCalls, 1);
  assert.equal(translationCalls, 1); assert.ok(merged.renders[0].burnedCaptions); assert.ok(merged.renders[0].hasCleanVideo);
  await writeFile(join(output, 'bilingual-smoke.mp4'), Buffer.from(await fetch(harness.base + '/api/narration-files/' + merged.renders[0].id, { headers }).then(r => r.arrayBuffer())));
  await page.screenshot({ path: join(output, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await expect(page.locator('.narration-header')).toHaveCount(1);
  await page.getByLabel('旁白文案', { exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'mobile-editor.png') });
  await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: join(output, 'mobile-upload.png') });
  const business = await fetch(harness.base + '/api/snapshot', { headers }).then(r => r.json()); assert.equal(business.merchants.length, 0); assert.equal(business.projects.length, 0); assert.equal(business.assets.length, 0);
  await page.getByRole('button', { name: '拆为两段', exact: true }).click(); await page.reload();
  await expect(page.getByRole('button', { name: '选择旁白2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '选择旁白2', exact: true }).click(); await page.getByLabel('旁白文案', { exact: true }).fill(''); await expect(page.getByRole('button', { name: '选择旁白2', exact: true })).toContainText('留白');
  assert.deepEqual(errors, []);
  const report = { autoNarrationWithoutOriginalAudio: true, frameBasedVision: true, independentNarrationSegments: true, mergeAcrossShots: true, splitAndDraftRestore: true, localDraftRestored: true, previewReuse: true, unchangedClipReuse: true, versionedExports: true, bilingualCaptions: true, editableTranslation: true, cleanVideoAndSrt: true, captions: true, translationCalls, rangeAndProtectedFiles: true, mobileFits: true, independentOfBusinessData: true, visionCalls, syntheses: inputs.length, pageErrors: errors, realModelCalls: false, browser: 'system Google Chrome' };
  await writeFile(join(output, 'check.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { if (browser) await browser.close(); if (harness) await harness.stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
