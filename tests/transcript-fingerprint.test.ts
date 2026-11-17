import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Asset } from '../src/shared/types';
import { transcriptFingerprint, legacyTranscriptFingerprint } from '../src/server/transcript-fingerprint';

const asset = {
  storageKey: 'battery.mp4',
  segments: [{ start: 0, end: 3, text: '三轮车锂电池', words: [{ start: 0, end: 1, text: '三轮车' }, { start: 1, end: 3, text: '锂电池' }], speakerId: 0 }],
} as Asset;

test('JSONB object key order does not invalidate an unchanged transcript job', () => {
  const stored = { ...asset, segments: asset.segments.map(segment => ({ speakerId: segment.speakerId, words: segment.words?.map(word => ({ text: word.text, end: word.end, start: word.start })), text: segment.text, end: segment.end, start: segment.start })) };
  assert.equal(transcriptFingerprint(stored), transcriptFingerprint(asset));
  assert.notEqual(legacyTranscriptFingerprint(stored), legacyTranscriptFingerprint(asset));
});

test('manual sentence and word corrections invalidate the previous transcript job', () => {
  for (const change of [
    { ...asset, segments: [{ ...asset.segments[0], text: '静姐的锂电池' }] },
    { ...asset, segments: [{ ...asset.segments[0], words: [...asset.segments[0].words!].reverse() }] },
    { ...asset, segments: [{ ...asset.segments[0], end: 4 }] },
  ]) assert.notEqual(transcriptFingerprint(change), transcriptFingerprint(asset));
});

test('replacing the original file invalidates the previous transcript job', () => {
  assert.notEqual(transcriptFingerprint({ ...asset, storageKey: 'replacement.mp4' }), transcriptFingerprint(asset));
});
