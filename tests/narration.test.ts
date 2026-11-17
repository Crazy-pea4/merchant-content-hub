import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { narrationVtt, narrationTextBudget, mergeNarrationSegments, splitNarrationSegment, narrationSegments } from '../src/shared/narration';
import { readNarrationDraft } from '../src/shared/narration-draft';

const directory = mkdtempSync(join(tmpdir(), 'narration-test-'));
process.env.DATA_DIR = join(directory, 'data'); process.env.DB_DRIVER = 'sqlite'; process.env.DATABASE_URL = ''; process.env.SEED_DEMO = 'false';
process.env.TTS_API_KEY = process.env.VISION_API_KEY = 'narration-test-only'; process.env.TTS_MODEL = 'cosyvoice-v3-flash'; process.env.ASR_PROVIDER = 'openai';
const sample = join(directory, 'voice.wav'), speech = join(directory, 'speech.mp3'), video = join(directory, 'video.mp4'), longSpeech = join(directory, 'long.mp3'), crossSpeech = join(directory, 'cross.mp3'), audible = join(directory, 'audible.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', sample]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', sample, '-t', '3', speech]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-stream_loop', '2', '-i', sample, '-t', '18', longSpeech]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-stream_loop', '1', '-i', sample, '-t', '8', crossSpeech]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=12:d=6', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=12:d=6', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', audible]);
let base = '', creates = 0, visionCalls = 0, syntheses = 0, failText = '', failVision = false, useLongSpeech = false, groupedVision = false, translationCalls = 0, failTranslation = false;
const server = createServer(async (req, res) => {
  if (req.url === '/speech.mp3') { res.setHeader('Content-Type', 'audio/mpeg'); res.end(readFileSync(useLongSpeech ? longSpeech : groupedVision ? crossSpeech : speech)); return; }
  assert.equal(req.headers.authorization, 'Bearer narration-test-only');
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); res.setHeader('Content-Type', 'application/json');
  if (req.url === '/translation/v1/chat/completions') {
    translationCalls++; if (failTranslation) { res.writeHead(503); res.end('secret-translation-body'); return; }
    const context = JSON.parse(body.messages[1].content);
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ segments: context.segments.map((s: { id: string; lines: { index: number; source: string }[] }) => ({ id: s.id, lines: s.lines.map(line => ({ index: line.index, text: context.targetLanguage === 'en' ? 'A quiet moment.' : '宁静的一刻。' })) })) }) } }] })); return;
  }
  if (req.url?.endsWith('/chat/completions')) {
    visionCalls++;
    if (failVision) { res.writeHead(503); res.end('secret-provider-body'); return; }
    const content = body.messages[1].content, context = JSON.parse(content[0].text);
    assert.ok(content.some((v: { type: string }) => v.type === 'image_url'));
    assert.ok(content.filter((v: { type: string }) => v.type === 'image_url').every((v: { image_url: { url: string } }) => v.image_url.url.startsWith('data:image/jpeg;base64,')));
    assert.ok(!('merchant' in context)); assert.ok(!('project' in context));
    assert.ok(context.shots.every((s: object) => !('maxCharacters' in s)));
    const segments = groupedVision ? [{ startShotId: context.shots[0].id, endShotId: context.shots.at(-1).id, text: '穿过这一片颜色，我们慢慢感受画面里的变化与宁静。', tone: 'storytelling', emotion: 'warm', rate: 1 }] : context.shots.map((s: { id: string }, i: number) => ({ startShotId: s.id, endShotId: s.id, text: i ? '慢一点。' : '开始了。', tone: 'storytelling', emotion: 'warm', rate: 1 }));
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '画面里的故事', summary: '红色画面转为蓝色画面。', shots: context.shots.map((s: { id: string }, i: number) => ({ id: s.id, description: i ? '蓝色画面' : '红色画面' })), segments }) } }] })); return;
  }
  if (body.input.action === 'create_voice') { creates++; res.end(JSON.stringify({ output: { voice_id: 'cosyvoice-v3-flash-narration-' + creates } })); return; }
  if (body.input.action === 'query_voice') { res.end(JSON.stringify({ output: { status: 'OK', target_model: 'cosyvoice-v3-flash' } })); return; }
  if (body.input.action === 'delete_voice') { res.end(JSON.stringify({ output: {} })); return; }
  syntheses++; if (body.input.text === failText) { res.writeHead(503); res.end('secret-provider-body'); return; }
  res.end(JSON.stringify({ output: { audio: { url: base + '/speech.mp3' } } }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`;
process.env.AI_API_KEY = 'narration-test-only'; process.env.AI_BASE_URL = base + '/translation/v1'; process.env.AI_MODEL = 'translation-test';
process.env.TTS_BASE_URL = base + '/api/v1'; process.env.VISION_BASE_URL = base + '/compatible-mode/v1'; process.env.VISION_MODEL = 'test-vision';
const store = await import('../src/server/db'), work = await import('../src/server/narration'), dubbing = await import('../src/server/dubbing'), http = await import('../src/server/http');
const { narrationWindows, trimNarrationPcm } = await import('../src/server/narration-media');
const { planNarration, MAX_NARRATION_GAP, MIN_NARRATION_SPEED } = await import('../src/server/narration-timing');
const canBurnCaptions = execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).includes('Render ASS subtitles onto input video');
afterEach(async () => { failText = ''; failVision = false; useLongSpeech = false; groupedVision = false; failTranslation = false; for (const p of await store.all('narrations')) await store.remove('narrations', p.id); for (const r of await store.all('narration_renders')) await store.remove('narration_renders', r.id); });
after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await store.db.close(); rmSync(directory, { recursive: true, force: true }); });
async function readyVoice() {
  const form = new FormData(); form.set('requestId', randomUUID()); form.set('name', '我的旁白音色'); form.set('consent', 'true'); form.set('file', new File([readFileSync(sample)], 'voice.wav'));
  const voice = await dubbing.createVoice(form); await dubbing.processNextDubbing(); return voice;
}
async function upload(voiceId: string, requestId: string = randomUUID(), source = video) {
  const form = new FormData(); form.set('requestId', requestId); form.set('voiceId', voiceId); form.set('file', new File([readFileSync(source)], '原片.mp4')); return work.uploadNarration(form);
}
test('分镜窗口覆盖全片、保留转场并限制数量，字幕与本机草稿有界解析', () => {
  const windows = narrationWindows(35, [10, 20]); assert.equal(windows[0].start, 0); assert.equal(windows.at(-1)?.end, 35); assert.ok(windows.some(s => s.end === 10));
  assert.ok(windows.every((s, i) => s.end > s.start && (!i || s.start === windows[i - 1].end)));
  const many = narrationWindows(600, Array.from({ length: 299 }, (_, i) => (i + 1) * 2)); assert.equal(many.length, 60); assert.equal(many.at(-1)?.end, 600);
  const shots = windows.map(s => ({ ...s, text: '<字幕> --> 示例' })); const vtt = narrationVtt(shots); assert.ok(vtt.startsWith('WEBVTT')); assert.ok(!vtt.includes('<字幕>')); assert.match(vtt, /00:00:00.000 -->/);
  assert.equal(narrationTextBudget(6, 'zh'), 18); assert.ok(readNarrationDraft(JSON.stringify({ revision: 1, title: '草稿', shots })));
  const remembered = readNarrationDraft(JSON.stringify({ revision: 1, title: '草稿', shots, voiceId: randomUUID(), originalVolume: .25, selectedShotId: shots[1].id })); assert.equal(remembered?.originalVolume, .25); assert.equal(remembered?.selectedShotId, shots[1].id);
  assert.equal(readNarrationDraft('{broken'), null); assert.equal(readNarrationDraft(JSON.stringify({ revision: 1, title: '草稿', shots: [{ ...shots[0], settings: {} }] })), null);
});
test('旁白独立于镜头：可合并拆分、跨镜头自然朗读，并借用整片空余时间', () => {
  const shots = narrationWindows(12, [6]), segments = narrationSegments({ shots }).map((s, i) => ({ ...s, text: i ? '放慢脚步，看看远处。' : '这是一个完整的故事。' }));
  const merged = mergeNarrationSegments(segments, 0)!; assert.equal(merged.length, 1); assert.equal(merged[0].end, 12);
  const plan = planNarration(merged, [8], 12); assert.ok(plan.speed >= MIN_NARRATION_SPEED && plan.speed <= 1); assert.ok(plan.alignedSegments[0].end > 10);
  const spill = planNarration(segments, [8, 2], 12); assert.equal(spill.speed, 1); assert.ok(spill.alignedSegments[0].end > 8); assert.ok(spill.alignedSegments[1].start >= spill.alignedSegments[0].end);
  const late = planNarration([{ ...segments[0], start: 10, end: 12 }], [8], 12); assert.ok(late.alignedSegments[0].start <= 2); assert.ok(12 - late.alignedSegments[0].end <= 2);
  const compressed = planNarration(segments, [8, 5], 12); assert.ok(compressed.speed > 1 && compressed.speed < 1.1); assert.equal(compressed.alignedSegments.at(-1)?.end, 12);
  assert.throws(() => planNarration(segments, [12, 8], 12), /整段旁白/);
  assert.throws(() => planNarration([{ ...segments[0], text: '' }, segments[1]], [null, 2], 12), /旁白内容偏短/);
  const split = splitNarrationSegment(merged, 0, randomUUID())!; assert.equal(split.length, 2); assert.equal(split[0].end, split[1].start); assert.equal(split[1].end, 12); assert.equal(mergeNarrationSegments(split, 0)![0].text, merged[0].text);
  const draft = readNarrationDraft(JSON.stringify({ revision: 1, title: '跨镜头草稿', shots, segments: merged, selectedSegmentId: merged[0].id })); assert.equal(draft?.segments.length, 1); assert.equal(draft?.segments[0].end, 12);
});
test('18.6秒原始案例：不把5.7秒片尾静音搬到中间，每处留白都不超过2秒', () => {
  const shots = narrationWindows(18.6, [4.2, 9.067]), segments = narrationSegments({ shots }).map(s => ({ ...s, text: '真实旁白。' }));
  const plan = planNarration(segments, [3.336, 3.984, 3.816], 18.6);
  const gaps = plan.alignedSegments.map((s, i) => s.start - (plan.alignedSegments[i - 1]?.end ?? 0)); gaps.push(18.6 - plan.alignedSegments.at(-1)!.end);
  assert.ok(gaps.every(gap => gap >= 0 && gap <= MAX_NARRATION_GAP + 0.00001)); assert.ok(plan.speed >= MIN_NARRATION_SPEED && plan.speed <= 1);
  const natural = planNarration(segments.slice(0, 2).map((s, i) => ({ ...s, start: i * 6, end: (i + 1) * 6 })), [5, 5], 12); assert.equal(natural.speed, 1); assert.equal(natural.alignedSegments[0].start, 0);
  const shorter = planNarration(segments.slice(0, 2), [3, 3], 12); assert.ok(shorter.speed >= MIN_NARRATION_SPEED && shorter.speed < 1); assert.ok(12 - shorter.alignedSegments.at(-1)!.end < 2);
  assert.throws(() => planNarration(segments.slice(0, 1), [1], 18.6), /补充旁白/);
});
test('时间预算使用去除首尾静音后的真实声音，保留句中停顿和原始音频', () => {
  const samples = 24000, pcm = Buffer.alloc(samples * 6);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(i % 2 ? 80 : -80, i * 2);
  for (let i = samples; i < samples * 2; i++) pcm.writeInt16LE(i < samples * 1.4 || i >= samples * 1.6 ? 1000 : 0, i * 2);
  const original = Buffer.from(pcm), trimmed = trimNarrationPcm(pcm);
  assert.ok(Math.abs(trimmed.length / 2 / samples - 1.08) < 0.001); assert.equal(trimmed.readInt16LE(Math.floor(trimmed.length / 4) * 2), 0); assert.deepEqual(pcm, original);
  assert.throws(() => trimNarrationPcm(Buffer.alloc(48000)), /没有有效声音/);
});
test('无原声视频：云端画面分析后自动排队成片，编辑分镜仅重合成变化部分，旧成片与字幕保留', async () => {
  const voice = await readyVoice(), beforeVision = visionCalls, beforeSpeech = syntheses;
  const project = await upload(voice.id); assert.equal(project.hasOriginalAudio, false); assert.equal((await upload(voice.id, project.id)).id, project.id);
  await assert.rejects(() => dubbing.deleteVoice(voice.id), /视频旁白/);
  await work.processNextNarration(); let p = (await work.narrationSnapshot()).projects[0]; assert.equal(p.status, 'ready'); assert.equal(p.shots.length, 2); assert.equal(p.shots[0].start, 0); assert.equal(p.shots[1].start, 6); assert.equal(visionCalls, beforeVision + 1);
  await work.processNextNarration(); await work.processNextNarration();
  let snapshot = await work.narrationSnapshot(), render = snapshot.renders[0]; assert.equal(render.status, 'completed'); assert.equal(syntheses, beforeSpeech + 2); assert.equal(render.id, project.id);
  const file = await work.narrationFile(render.id, false); const original = readFileSync(join(directory, 'data/uploads', file.storageKey)); const probe = join(directory, 'result.mp4'); writeFileSync(probe, original);
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', probe], { encoding: 'utf8' }));
  assert.ok(Math.abs(Number(info.format.duration) - 12) < .2); assert.ok(info.streams.some((s: { codec_name: string }) => s.codec_name === 'mov_text'));
  const segments = p.segments.map((s, i) => i ? { ...s, text: '换一句。' } : s); p = await work.saveNarration(p.id, { revision: p.revision, title: p.title, segments });
  assert.equal(p.revision, 2); assert.deepEqual(readFileSync(join(directory, 'data/uploads', file.storageKey)), original);
  const requestId = randomUUID(), payload = { requestId, revision: p.revision, voiceId: voice.id, originalVolume: 0 };
  assert.equal((await work.enqueueNarrationRender(p.id, payload)).id, requestId); assert.equal((await work.enqueueNarrationRender(p.id, payload)).id, requestId);
  await assert.rejects(() => work.enqueueNarrationRender(p.id, { ...payload, originalVolume: .5 }), /编号/);
  await work.processNextNarration(); snapshot = await work.narrationSnapshot(); render = snapshot.renders.find(r => r.id === requestId)!; assert.equal(render.status, 'completed'); assert.equal(syntheses, beforeSpeech + 3);
  assert.ok(!('clips' in render)); assert.ok(!('media' in snapshot.projects[0])); assert.ok(!('frames' in snapshot.projects[0]));
  const req = (url: string) => new Request('http://localhost/api/' + url);
  const range = await http.handleApi(new Request('http://localhost/api/narration-files/' + render.id, { headers: { Range: 'bytes=0-31' } }), ['narration-files', render.id]); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32);
  const captions = await http.handleApi(req(`narration-files/${render.id}?captions`), ['narration-files', render.id]); assert.match(await captions.text(), /换一句/);
  for (const table of ['merchants', 'projects', 'assets'] as const) assert.equal((await store.all(table)).length, 0);
});
test('文案编辑版本冲突、时间线注入、未授权读取和跨来源写入被拒绝', async () => {
  const voice = await readyVoice(), project = await upload(voice.id); await work.processNextNarration();
  const p = (await work.narrationSnapshot()).projects[0];
  await assert.rejects(() => work.saveNarration(p.id, { revision: 1, title: p.title, shots: p.shots.map((s, i) => i ? s : { ...s, end: 500 }) }), /时间线/);
  await assert.rejects(() => work.saveNarration(p.id, { revision: 1, title: p.title, segments: p.segments.map(s => ({ ...s, end: 500 })) }), /范围/);
  await assert.rejects(() => work.saveNarration(p.id, { revision: 1, title: p.title, segments: p.segments.map((s, i) => i ? { ...s, start: 0 } : s) }), /重叠/);
  await work.saveNarration(p.id, { revision: 1, title: '新标题', segments: p.segments });
  await assert.rejects(() => work.saveNarration(p.id, { revision: 1, title: '旧页面', segments: p.segments }), /其他页面/);
  process.env.HUB_ACCESS_TOKEN = 'narration-private-token';
  try {
    assert.equal((await http.handleApi(new Request('http://localhost/api/narration-files/' + p.id + '?source'), ['narration-files', p.id])).status, 401);
    assert.equal((await http.handleApi(new Request('http://localhost/api/narrations/' + p.id, { method: 'PATCH', headers: { Authorization: 'Bearer narration-private-token', Origin: 'https://foreign.example' } }), ['narrations', p.id])).status, 403);
  } finally { delete process.env.HUB_ACCESS_TOKEN; }
});
test('模型生成跨越两个镜头的长句，字幕跟随声音，片尾静音不足2秒且切镜后声音保留', async () => {
  groupedVision = true;
  const voice = await readyVoice(), before = syntheses, project = await upload(voice.id); await work.processNextNarration();
  const p = (await work.narrationSnapshot()).projects[0]; assert.equal(p.status, 'ready'); assert.equal(p.shots.length, 2); assert.equal(p.segments.length, 1); assert.ok(p.segments[0].text.length > narrationTextBudget(6, 'zh'));
  await work.processNextNarration(); await work.processNextNarration();
  const r = (await work.narrationSnapshot()).renders[0]; assert.equal(r.status, 'completed'); assert.equal(syntheses, before + 1); assert.equal(r.alignedSegments!.length, 1); assert.ok(12 - r.alignedSegments![0].end < 2);
  const response = await http.handleApi(new Request(`http://localhost/api/narration-files/${r.id}?captions`), ['narration-files', r.id]); assert.match(await response.text(), /00:00:10\./);
  const media = await work.narrationFile(project.id, false);
  const silence = spawnSync('ffmpeg', ['-hide_banner', '-i', join(directory, 'data/uploads', media.storageKey), '-vn', '-af', 'silencedetect=noise=-45dB:d=0.05', '-f', 'null', '-'], { encoding: 'utf8' }); assert.equal(silence.status, 0);
  const gaps = [...silence.stderr.matchAll(/silence_duration: ([\d.]+)/g)].map(m => Number(m[1])); assert.ok(gaps.length >= 2); assert.ok(gaps.every(gap => gap <= 2), JSON.stringify(gaps));
  const decoded = execFileSync('ffmpeg', ['-v', 'error', '-ss', '6.5', '-i', join(directory, 'data/uploads', media.storageKey), '-t', '0.5', '-vn', '-ac', '1', '-ar', '24000', '-f', 's16le', '-']);
  let peak = 0; for (let i = 0; i < decoded.length; i += 2) peak = Math.max(peak, Math.abs(decoded.readInt16LE(i))); assert.ok(peak > 100, '镜头在6秒切换后仍有旁白声音');
});
test('旧项目、旧成片与旧本机草稿可转换为独立旁白，保存跨镜头编辑不改动画面', async () => {
  const voice = await readyVoice(), project = await upload(voice.id); await work.processNextNarration();
  const stored = (await store.get('narrations', project.id))!;
  const { segments, ...legacy } = stored;
  const legacyShots = legacy.shots.map((s, i) => ({ ...s, ...segments![i] }));
  await store.put('narrations', { ...legacy, shots: legacyShots });
  const recovered = (await work.narrationSnapshot()).projects[0]; assert.deepEqual(recovered.segments, segments);
  const draft = readNarrationDraft(JSON.stringify({ revision: 1, title: '旧草稿', shots: legacyShots })); assert.deepEqual(draft?.segments, segments);
  const merged = mergeNarrationSegments(recovered.segments, 0)!;
  const saved = await work.saveNarration(project.id, { revision: 1, title: recovered.title, segments: merged }); assert.equal(saved.shots.length, 2); assert.equal(saved.segments.length, 1); assert.equal(saved.segments[0].end, 12);
});
test('分析未知收费请求不自动重提，显式重试可恢复，服务错误不回传上游正文', async () => {
  const voice = await readyVoice(), p = await upload(voice.id), stored = (await store.get('narrations', p.id))!, before = visionCalls;
  await store.put('narrations', { ...stored, status: 'analyzing', analysisSubmitted: true, leaseUntil: 0, leaseToken: 'dead-process' });
  await work.processNextNarration(); assert.equal(visionCalls, before); assert.match((await store.get('narrations', p.id))!.error!, /未确认/);
  failVision = true; await work.retryNarration(p.id); await work.processNextNarration(); assert.equal(visionCalls, before + 1); assert.doesNotMatch((await store.get('narrations', p.id))!.error!, /secret-provider-body/);
  failVision = false; await work.retryNarration(p.id); await work.processNextNarration(); assert.equal((await store.get('narrations', p.id))?.status, 'ready');
});
test('成片中断保护和继续生成保留已完成片段，纯留白不会调用语音服务', async () => {
  const voice = await readyVoice(), p = await upload(voice.id); await work.processNextNarration(); await work.processNextNarration();
  const before = syntheses; failText = '慢一点。'; await work.processNextNarration();
  let r = (await store.get('narration_renders', p.id))!; assert.equal(r.status, 'failed'); assert.ok(r.clips[0]?.output); assert.equal(syntheses, before + 2);
  await store.put('narration_renders', { ...r, status: 'processing', leaseToken: 'dead-process', leaseUntil: 0 }); failText = '';
  await work.processNextNarration(); assert.equal(syntheses, before + 2); assert.match((await store.get('narration_renders', p.id))!.error!, /未确认/);
  await work.retryNarrationRender(p.id); await work.processNextNarration(); r = (await store.get('narration_renders', p.id))!; assert.equal(r.status, 'completed'); assert.equal(syntheses, before + 3);
  const project = (await work.narrationSnapshot()).projects[0], segments = project.segments.map((s, i) => i ? { ...s, text: '' } : s);
  const saved = await work.saveNarration(project.id, { revision: project.revision, title: project.title, segments }); const id = randomUUID();
  await work.enqueueNarrationRender(p.id, { requestId: id, revision: saved.revision, voiceId: voice.id }); await work.processNextNarration(); assert.equal((await store.get('narration_renders', id))?.status, 'failed'); assert.match((await store.get('narration_renders', id))!.error!, /旁白内容偏短/); assert.equal(syntheses, before + 3);
});
test('旁白过长立即暂停后续收费合成，保留该段结果供编辑恢复', async () => {
  const voice = await readyVoice(), p = await upload(voice.id); await work.processNextNarration(); await work.processNextNarration();
  useLongSpeech = true; const before = syntheses; await work.processNextNarration();
  const r = (await store.get('narration_renders', p.id))!; assert.equal(r.status, 'failed'); assert.match(r.error!, /整段旁白.*精简/); assert.equal(syntheses, before + 1); assert.ok(r.clips[0]?.output);
});
test('有原声视频可混合原声音量，混音新版本复用旁白且保持视频时长', async () => {
  const voice = await readyVoice(), p = await upload(voice.id, randomUUID(), audible); assert.equal(p.hasOriginalAudio, true);
  await work.processNextNarration(); await work.processNextNarration(); await work.processNextNarration();
  const project = (await work.narrationSnapshot()).projects[0], id = randomUUID(), before = syntheses;
  await work.enqueueNarrationRender(p.id, { requestId: id, revision: project.revision, voiceId: voice.id, originalVolume: .25 }); await work.processNextNarration();
  const r = (await store.get('narration_renders', id))!; assert.equal(r.status, 'completed'); assert.equal(syntheses, before); assert.ok(Math.abs(r.output!.duration! - 12) < .2);
});
test('双语成片：自动翻译、中文在上英文在下写入画面、无字幕版本和独立SRT，改译文不重复合成', { skip: !canBurnCaptions }, async () => {
  const voice = await readyVoice(), project = await upload(voice.id); await work.processNextNarration(); await work.processNextNarration(); await work.processNextNarration();
  let p = (await work.narrationSnapshot()).projects[0];
  const beforeSpeech = syntheses, beforeTranslation = translationCalls, id = randomUUID();
  const queued = await work.enqueueNarrationRender(p.id, { requestId: id, revision: p.revision, voiceId: voice.id, originalVolume: 0, subtitleMode: 'bilingual' });
  await assert.rejects(() => work.enqueueNarrationRender(p.id, { requestId: id, revision: p.revision, voiceId: voice.id, originalVolume: 0, subtitleMode: 'original' }), /编号/);
  assert.equal(queued.subtitleMode, 'bilingual'); await work.processNextNarration();
  let snapshot = await work.narrationSnapshot(), render = snapshot.renders.find(r => r.id === id)!; assert.equal(render.status, 'completed'); assert.equal(render.burnedCaptions, true); assert.equal(render.hasCleanVideo, true); assert.equal(translationCalls, beforeTranslation + 1); assert.equal(syntheses, beforeSpeech);
  p = snapshot.projects[0]; assert.ok(p.segments.every(s => s.translation?.lines.every(line => !!line.text))); assert.ok(!('translationCache' in p));
  assert.equal((await work.saveNarration(p.id, { revision: p.revision, title: p.title, segments: p.segments })).revision, p.revision);
  const output = await work.narrationFile(id, false), clean = await work.narrationFile(id, false, undefined, true), originalBytes = readFileSync(join(directory, 'data/uploads', output.storageKey));
  const frame = (key: string) => execFileSync('ffmpeg', ['-v', 'error', '-ss', '3', '-i', join(directory, 'data/uploads', key), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const visible = frame(output.storageKey), blank = frame(clean.storageKey); assert.equal(visible.length, blank.length);
  mkdirSync('data/qa/narration', { recursive: true }); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '320x180', '-i', '-', '-frames:v', '1', join(process.cwd(), 'data/qa/narration/bilingual-render-test.png')], { input: visible });
  const countWhite = (bytes: Buffer, start: number, end: number) => { let count = 0; for (let y = start; y < end; y++) for (let x = 0; x < 320; x++) { const at = (y * 320 + x) * 3; if (bytes[at] > 200 && bytes[at + 1] > 200 && bytes[at + 2] > 200) count++; } return count; };
  assert.ok(countWhite(visible, 100, 121) > countWhite(blank, 100, 121) + 20, '中文已写入上方画面'); assert.ok(countWhite(visible, 122, 150) > countWhite(blank, 122, 150) + 10, '英文已写入下方画面：' + countWhite(visible, 122, 150));
  const request = (track: string) => http.handleApi(new Request(`http://localhost/api/narration-files/${id}?captions&format=srt&track=${track}&download`), ['narration-files', id]);
  const english = await request('en'), chinese = await request('zh'); assert.match(english.headers.get('content-type')!, /subrip/); assert.match(await english.text(), /A quiet moment/); assert.match(await chinese.text(), /开始了/);
  const segments = p.segments.map((s, i) => i ? s : { ...s, translation: { ...s.translation!, lines: s.translation!.lines.map((line, j) => j ? line : { ...line, text: 'My own pace.' }) } });
  p = await work.saveNarration(p.id, { revision: p.revision, title: p.title, segments }); const changedId = randomUUID();
  await work.enqueueNarrationRender(p.id, { requestId: changedId, revision: p.revision, voiceId: voice.id, originalVolume: 0, subtitleMode: 'bilingual' }); await work.processNextNarration();
  snapshot = await work.narrationSnapshot(); render = snapshot.renders.find(r => r.id === changedId)!; assert.equal(render.status, 'completed'); assert.equal(syntheses, beforeSpeech); assert.equal(translationCalls, beforeTranslation + 1);
  assert.deepEqual(readFileSync(join(directory, 'data/uploads', output.storageKey)), originalBytes); assert.equal(render.segments[0].translation!.lines[0].text, 'My own pace.');
  assert.ok((await work.narrationFile(changedId, false, undefined, true)).storageKey !== clean.storageKey);
});
test('未知翻译请求不自动重提，手动继续可恢复，失败不会丢失文案或调用配音', { skip: !canBurnCaptions }, async () => {
  const voice = await readyVoice(), project = await upload(voice.id); await work.processNextNarration(); await work.processNextNarration(); await work.processNextNarration();
  const p = (await work.narrationSnapshot()).projects[0], id = randomUUID(), beforeSpeech = syntheses, beforeTranslation = translationCalls;
  await work.enqueueNarrationRender(p.id, { requestId: id, revision: p.revision, voiceId: voice.id, subtitleMode: 'bilingual' });
  const queued = (await store.get('narration_renders', id))!; await store.put('narration_renders', { ...queued, status: 'processing', translationSubmitted: true, leaseToken: 'interrupted', leaseUntil: 0 });
  await work.processNextNarration(); assert.equal(translationCalls, beforeTranslation); assert.match((await store.get('narration_renders', id))!.error!, /翻译结果未确认/);
  failTranslation = true; await work.retryNarrationRender(id); await work.processNextNarration(); assert.equal(translationCalls, beforeTranslation + 1); assert.doesNotMatch((await store.get('narration_renders', id))!.error!, /secret-translation-body/); assert.equal(syntheses, beforeSpeech);
  failTranslation = false; await work.retryNarrationRender(id); await work.processNextNarration(); assert.equal((await store.get('narration_renders', id))!.status, 'completed'); assert.equal(syntheses, beforeSpeech); assert.equal((await work.narrationSnapshot()).projects[0].segments[0].text, p.segments[0].text);
});
