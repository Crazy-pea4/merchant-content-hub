import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { narrationCaptionLines, narrationCaptions, narrationCaptionFile, narrationAss, currentNarrationTranslation, editableNarrationTranslation } from '../src/shared/narration-captions';
import { defaultDubbingSettings } from '../src/shared/dubbing-settings';
import { narrationSegmentIdentity, type NarrationSegment } from '../src/shared/narration';
import { cachedNarrationTranslations, translateNarration, translationKey } from '../src/server/narration-translation';

function segment(): NarrationSegment { return { id: randomUUID(), start: 1.85, end: 16.75, text: '一个人跑步，其实挺舒服的。不用迁就别人的速度。', settings: { ...defaultDubbingSettings } }; }
test('双语短句共享同一条声音时间线，中英SRT可独立导入且最后一条精确到结束时间', () => {
  const s = segment(); s.translation = editableNarrationTranslation(s, 'zh');
  s.translation.lines.forEach((line, i) => { line.text = ['Running alone,', 'actually feels quite nice.', 'There is no need to match anyone else’s pace.'][i]; });
  assert.ok(currentNarrationTranslation(s, 'zh'));
  const cues = narrationCaptions([s], 'zh'); assert.equal(cues.length, 3); assert.equal(cues[0].start, 1.85); assert.equal(cues.at(-1)!.end, 16.75);
  assert.ok(cues.every((cue, i) => cue.end > cue.start && (!i || cue.start === cues[i - 1].end)));
  const zh = narrationCaptionFile(cues, 'srt', 'zh'), en = narrationCaptionFile(cues, 'srt', 'en'), both = narrationCaptionFile(cues, 'vtt', 'bilingual');
  assert.match(zh, /00:00:01,850 -->/); assert.match(zh, /00:00:16,750/); assert.ok(!zh.includes('Running')); assert.ok(!en.includes('一个人')); assert.ok(both.startsWith('WEBVTT'));
  assert.ok(both.indexOf('一个人跑步，') < both.indexOf('Running alone,'));
  const changed = { ...s, text: '换一段新的文案。' }; assert.equal(currentNarrationTranslation(changed, 'zh'), false);
});
test('英文朗读时仍然中文在上英文在下，字幕排版不允许文本注入ASS指令', () => {
  const s = { ...segment(), text: 'Take your time, and enjoy the view.' }; s.translation = editableNarrationTranslation(s, 'en'); s.translation.lines.forEach(line => { line.text = '慢慢来，看看风景。'; });
  const cues = narrationCaptions([s], 'en'); assert.equal(cues[0].en, 'Take your time,'); assert.equal(cues[0].zh, '慢慢来，看看风景。');
  const ass = narrationAss([{ ...cues[0], zh: '{\\pos(0,0)}<字>', en: 'A very long translation that should wrap safely inside the picture without crossing the edge.' }], 590, 1280, true, 'en');
  assert.ok(ass.includes('Noto Serif CJK SC')); assert.ok(!ass.includes('{\\pos(0,0)}')); assert.ok(ass.includes('｛＼pos(0,0)｝')); assert.ok(ass.includes('\\N'));
  const long = '这是一段没有任何标点的很长的中文'.repeat(12); assert.equal(narrationCaptionLines(long, 'zh').join(''), long);
});
test('译文身份不受PostgreSQL键顺序影响，改译文只改变字幕版本', () => {
  const s = segment(); s.translation = editableNarrationTranslation(s, 'zh'); s.translation.lines.forEach(line => { line.text = 'A quiet moment.'; });
  const reordered = JSON.parse(JSON.stringify(s)); reordered.translation = { lines: s.translation.lines.map(line => ({ text: line.text, source: line.source })), sourceText: s.translation.sourceText };
  assert.deepEqual(narrationSegmentIdentity([s]), narrationSegmentIdentity([reordered]));
  const changed = structuredClone(s); changed.translation!.lines[0].text = 'My own pace.'; assert.notDeepEqual(narrationSegmentIdentity([s]), narrationSegmentIdentity([changed])); assert.equal(changed.text, s.text);
});
test('自动翻译仅发送文案短句，保留手改译文，完整手工译文不调用模型，失败不泄露上游正文', async () => {
  const previousFetch = globalThis.fetch, saved = { key: process.env.AI_API_KEY, base: process.env.AI_BASE_URL, model: process.env.AI_MODEL };
  let calls = 0, submissions = 0;
  try {
    process.env.AI_API_KEY = 'caption-test-only'; process.env.AI_BASE_URL = 'https://translation.invalid/v1'; process.env.AI_MODEL = 'translation-test';
    const s = segment(); s.translation = editableNarrationTranslation(s, 'zh'); s.translation.lines[0].text = 'My own wording.';
    globalThis.fetch = async (_url, options) => {
      calls++; const body = JSON.parse(options!.body as string), context = JSON.parse(body.messages[1].content);
      assert.equal(context.targetLanguage, 'en'); assert.ok(!JSON.stringify(context).includes('merchant')); assert.ok(!JSON.stringify(context).includes('image_url'));
      return Response.json({ choices: [{ message: { content: JSON.stringify({ segments: context.segments.map((part: { id: string; lines: { index: number }[] }) => ({ id: part.id, lines: part.lines.map(line => ({ index: line.index, text: 'A translated sentence.' })) })) }) } }] });
    };
    const result = await translateNarration([s], 'zh', new AbortController().signal, async () => { submissions++; });
    assert.equal(calls, 1); assert.equal(submissions, 1); assert.equal(result[0].translation!.lines[0].text, 'My own wording.'); assert.ok(currentNarrationTranslation(result[0], 'zh'));
    await translateNarration(result, 'zh', new AbortController().signal, async () => { submissions++; }); assert.equal(calls, 1);
    const cache = { [translationKey(s.text, 'zh')]: result[0].translation! }; assert.ok(currentNarrationTranslation(cachedNarrationTranslations([{ ...s, translation: undefined }], 'zh', cache)[0], 'zh'));
    const partial = structuredClone(result[0]); partial.translation!.lines[0].text = 'Preserve my edit.'; partial.translation!.lines[1].text = '';
    const restored = cachedNarrationTranslations([partial], 'zh', cache)[0]; assert.equal(restored.translation!.lines[0].text, 'Preserve my edit.'); assert.ok(restored.translation!.lines[1].text);
    assert.equal(currentNarrationTranslation(cachedNarrationTranslations([{ ...s, text: '完全不同的内容。', translation: undefined }], 'zh', cache)[0], 'zh'), false);
    globalThis.fetch = async () => new Response('secret-provider-body', { status: 503 });
    await assert.rejects(() => translateNarration([segment()], 'zh', new AbortController().signal, async () => {}), error => error instanceof Error && error.message.includes('HTTP 503') && !error.message.includes('secret-provider-body'));
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of [['AI_API_KEY', saved.key], ['AI_BASE_URL', saved.base], ['AI_MODEL', saved.model]]) { if (value === undefined) delete process.env[name!]; else process.env[name!] = value; }
  }
});
