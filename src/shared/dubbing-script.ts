import { resolveDubbingSettings, type DubbingSettings } from './dubbing-settings';
import { dubbingPreviewText } from './dubbing-preview';

export const MAX_DUBBING_PARTS = 60;
export const MAX_DUBBING_PART_TEXT = 500;
export interface DubbingPart { id: string; text: string; settings?: Partial<DubbingSettings>; pauseAfterMs?: number }
export type DubbingPreviewScope = 'opening' | 'sentence' | 'context';
export interface SpeechPart { text: string; settings: DubbingSettings; pauseAfterMs: number }
export const dubbingScriptText = (parts: DubbingPart[]) => parts.map(part => part.text.trim()).join('\n');
export const dubbingPartsIdentity = (parts?: DubbingPart[]) => parts?.map(part => [part.id, part.text, part.settings?.rate ?? null, part.settings?.pitch ?? null, part.settings?.tone ?? null, part.settings?.emotion ?? null, part.pauseAfterMs ?? 0]);
export const effectivePartSettings = (global: DubbingSettings, part: DubbingPart) => resolveDubbingSettings({ ...global, ...part.settings });
export function speechPlan(parts: DubbingPart[], global: DubbingSettings): SpeechPart[] {
  return parts.map(part => ({ text: part.text.trim(), settings: effectivePartSettings(global, part), pauseAfterMs: part.pauseAfterMs ?? 0 }));
}
export function splitDubbingText(text: string): string[] {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'sentence' });
  const sentences = text.split(/\r?\n/).flatMap(line => Array.from(segmenter.segment(line), item => item.segment.trim())).filter(Boolean);
  const result: string[] = [];
  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length > MAX_DUBBING_PART_TEXT) {
      let cut = MAX_DUBBING_PART_TEXT;
      const space = rest.lastIndexOf(' ', cut);
      if (space > cut / 2) cut = space;
      if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
      result.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
    }
    if (rest) result.push(rest);
  }
  // Very short sentences may exceed the editor's limit. Merge neighbors without dropping text.
  while (result.length > MAX_DUBBING_PARTS) {
    const index = result.slice(0, -1).findIndex((value, i) => value.length + result[i + 1].length + 1 <= MAX_DUBBING_PART_TEXT);
    if (index < 0) break;
    result.splice(index, 2, result[index] + ' ' + result[index + 1]);
  }
  return result;
}
// Preserve manual boundaries and local settings outside the edited passage.
export function reconcileDubbingParts(previous: DubbingPart[], text: string): DubbingPart[] {
  if (text === dubbingScriptText(previous)) return previous;
  let rest = text.trim();
  const before: DubbingPart[] = [], after: DubbingPart[] = [];
  let start = 0, end = previous.length;
  while (start < end && rest.startsWith(previous[start].text) && (!rest[previous[start].text.length] || /\s/.test(rest[previous[start].text.length]))) {
    before.push(previous[start]); rest = rest.slice(previous[start++].text.length).trimStart();
  }
  while (end > start && rest.endsWith(previous[end - 1].text)) {
    const part = previous[end - 1], offset = rest.length - part.text.length;
    if (offset && !/\s/.test(rest[offset - 1])) break;
    after.unshift(part); rest = rest.slice(0, offset).trimEnd(); end--;
  }
  const used = new Set<string>();
  const middle = splitDubbingText(rest).map(value => {
    const same = previous.slice(start, end).find(part => part.text === value && !used.has(part.id));
    if (same) { used.add(same.id); return same; }
    return { id: crypto.randomUUID(), text: value };
  });
  return [...before, ...middle, ...after];
}
export function previewSpeechPlan(parts: DubbingPart[], global: DubbingSettings, scope: DubbingPreviewScope, partId?: string): SpeechPart[] {
  if (scope !== 'opening') {
    const index = parts.findIndex(part => part.id === partId);
    if (index < 0) return [];
    const selected = scope === 'sentence' ? [parts[index]] : parts.slice(Math.max(0, index - 1), index + 2);
    return speechPlan(selected, global);
  }
  let remaining = dubbingPreviewText(dubbingScriptText(parts)).length;
  const opening: DubbingPart[] = [];
  for (const part of parts) {
    if (remaining <= 0) break;
    const text = part.text.slice(0, remaining).trim();
    if (text) opening.push({ ...part, text });
    remaining -= part.text.length + 1;
  }
  if (opening.length) opening[opening.length - 1] = { ...opening.at(-1)!, pauseAfterMs: 0 };
  return speechPlan(opening, global);
}
