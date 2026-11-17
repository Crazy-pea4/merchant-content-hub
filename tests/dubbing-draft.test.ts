import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readDubbingDraft, type DubbingDraft } from '../src/shared/dubbing-draft';

const draft: DubbingDraft = { version: 1, title: '尚未生成的草稿', text: '重点句。\n慢读句。', mode: 'video', scriptView: 'sentences', voiceId: randomUUID(), sourceId: randomUUID(), usedSourceId: randomUUID(), selectedPartId: '', rate: '1.25', pitch: '1.1', tone: 'storytelling', emotion: 'warm', parts: [{ id: randomUUID(), text: '重点句。', settings: { tone: 'emphasis', emotion: 'serious' } }, { id: randomUUID(), text: '慢读句。', settings: { emotion: 'relaxed', rate: 0.85 }, pauseAfterMs: 500 }] };
test('本机草稿保留原始文本、来源、音色及逐句设置，未完成的空句也可以恢复', () => {
  assert.deepEqual(readDubbingDraft(JSON.stringify(draft)), draft);
  const editing = { ...draft, text: '未完成的文案  ', parts: [{ id: randomUUID(), text: '' }] }; assert.deepEqual(readDubbingDraft(JSON.stringify(editing)), editing);
  const oversized = { ...draft, text: '字'.repeat(3000) }; assert.equal(readDubbingDraft(JSON.stringify(oversized))?.text.length, 3000);
});
test('损坏、不兼容或超限草稿不会导致页面报错，草稿不恢复录音或授权状态', () => {
  for (const value of [null, '', '{bad', JSON.stringify({}), JSON.stringify({ ...draft, version: 2 }), JSON.stringify({ ...draft, rate: '0' }), JSON.stringify({ ...draft, parts: [draft.parts![0], draft.parts![0]] }), 'x'.repeat(200001)]) assert.equal(readDubbingDraft(value), null);
  const safe = readDubbingDraft(JSON.stringify({ ...draft, consent: true, voiceFile: 'data:audio/wav;base64,not-a-draft-field', token: 'not-a-draft-field' }))!;
  assert.ok(!('consent' in safe)); assert.ok(!('voiceFile' in safe)); assert.ok(!('token' in safe));
  assert.equal(readDubbingDraft(JSON.stringify({ ...draft, parts: [] }))?.scriptView, 'whole');
});
