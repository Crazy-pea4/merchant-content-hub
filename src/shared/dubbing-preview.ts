export const DUBBING_PREVIEW_SECONDS = 5;

// Bound synthesis to an opening passage, then trim its audio to the preview duration.
export function dubbingPreviewText(text: string) {
  const characters = Array.from(text.trim());
  let weight = 0, end = 0;
  for (const character of characters) {
    const cost = /[\p{Script=Latin}\p{Number}]/u.test(character) ? 0.25 : /\s|\p{Punctuation}/u.test(character) ? 0.15 : 1;
    if (weight + cost > 32 || end >= 128) break;
    weight += cost; end++;
  }
  let prefix = characters.slice(0, end).join('');
  if (end < characters.length && /\p{Script=Latin}/u.test(characters[end]) && /\p{Script=Latin}$/u.test(prefix) && /\s/.test(prefix)) prefix = prefix.replace(/\s+\S*$/u, '');
  return prefix.trim();
}
