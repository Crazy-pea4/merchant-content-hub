import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dubbingScriptText, splitDubbingText, reconcileDubbingParts, previewSpeechPlan, speechPlan, type DubbingPart } from '../src/shared/dubbing-script';
import { defaultDubbingSettings } from '../src/shared/dubbing-settings';
import { dubbingPartsSchema, validateDubbingScript } from '../src/server/dubbing-script';

test('自动分句保留中英混合、缩写和小数，长句及大量短句不丢内容', () => {
  assert.deepEqual(splitDubbingText('你好！Hello world. The rate is 1.25 today.\n下一段。'), ['你好！', 'Hello world.', 'The rate is 1.25 today.', '下一段。']);
  const long = '很'.repeat(1100); assert.equal(splitDubbingText(long).join(''), long); assert.ok(splitDubbingText(long).every(s => s.length <= 500));
  const short = '好。'.repeat(100); const result = splitDubbingText(short); assert.ok(result.length <= 60); assert.equal(result.join('').replaceAll(' ', ''), short);
});
test('整篇改写保留未改句子的设置以及手动边界，重分的句子继承全篇', () => {
  const parts: DubbingPart[] = [ { id: randomUUID(), text: '第一段没有句号', settings: { rate: 0.8 } }, { id: randomUUID(), text: '第二句。', settings: { tone: 'emphasis' } }, { id: randomUUID(), text: '第三句。', settings: { emotion: 'warm' } } ];
  assert.deepEqual(reconcileDubbingParts(parts, dubbingScriptText(parts)), parts);
  const result = reconcileDubbingParts(parts, '第一段没有句号\n第二句改写了。\n第三句。');
  assert.deepEqual(result[0], parts[0]); assert.deepEqual(result[2], parts[2]); assert.equal(result[1].settings, undefined);
  const appended = reconcileDubbingParts(parts, dubbingScriptText(parts) + '\n第四句。'); assert.equal(appended[0].id, parts[0].id); assert.equal(appended.length, 4);
});
test('局部覆盖逐项继承，试听范围和全篇共用同一个有效设置解析', () => {
  const parts: DubbingPart[] = [ { id: randomUUID(), text: '第一句。' }, { id: randomUUID(), text: '重点句。', settings: { tone: 'emphasis' }, pauseAfterMs: 500 }, { id: randomUUID(), text: '轻松说。', settings: { emotion: 'relaxed', rate: 0.85 } }, { id: randomUUID(), text: '尾句。' } ];
  const global = { ...defaultDubbingSettings, pitch: 1.1 };
  const plan = speechPlan(parts, global);
  assert.equal(plan[1].settings.pitch, 1.1); assert.equal(plan[1].settings.tone, 'emphasis');
  assert.deepEqual(previewSpeechPlan(parts, global, 'sentence', parts[2].id), [plan[2]]);
  assert.deepEqual(previewSpeechPlan(parts, global, 'context', parts[1].id), plan.slice(0, 3));
  assert.deepEqual(previewSpeechPlan(parts, global, 'context', parts[3].id), plan.slice(2));
  assert.equal(previewSpeechPlan(parts, global, 'sentence', 'missing').length, 0);
  assert.ok(previewSpeechPlan(parts, global, 'opening').at(-1)?.pauseAfterMs === 0);
});
test('分段参数拒绝编号冲突、文案漂移、空句、超长句与任意指令注入', () => {
  const part = { id: randomUUID(), text: '有效文案。' };
  assert.throws(() => validateDubbingScript('别的文案', [part]), /不一致/);
  assert.throws(() => validateDubbingScript('有效文案。\n有效文案。', [part, part]), /重复/);
  for (const patch of [{ text: '' }, { text: '字'.repeat(501) }, { pauseAfterMs: -1 }, { pauseAfterMs: 3001 }, { settings: { instruction: 'arbitrary' } }, { settings: { rate: 0.4 } }]) assert.equal(dubbingPartsSchema.safeParse([{ ...part, ...patch }]).success, false);
});
