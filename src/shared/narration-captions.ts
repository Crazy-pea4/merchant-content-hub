import { narrationTimestamp, type NarrationSegment, type NarrationTranslation } from './narration';

export function narrationCaptionLines(text: string, language: 'zh' | 'en') {
  const maximum = language === 'zh' ? 14 : 62, result: string[] = [];
  const phrases = text.trim().split(/(?<=[。！？!?；;，,])\s*/u).filter(Boolean);
  for (const phrase of phrases) {
    let rest = phrase.trim();
    while (Array.from(rest).length > maximum) {
      let cut = Array.from(rest).slice(0, maximum).join('').length;
      if (language === 'en') { const space = rest.lastIndexOf(' ', cut); if (space > maximum / 2) cut = space; }
      result.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
    }
    if (rest) result.push(rest);
  }
  return result;
}
export function currentNarrationTranslation(segment: NarrationSegment, language: 'zh' | 'en') {
  const translation = segment.translation, lines = narrationCaptionLines(segment.text, language);
  return !!translation && translation.sourceText === segment.text.trim() && translation.lines.length === lines.length && translation.lines.every((line, i) => line.source === lines[i] && !!line.text.trim());
}
export function editableNarrationTranslation(segment: NarrationSegment, language: 'zh' | 'en'): NarrationTranslation {
  return { sourceText: segment.text.trim(), lines: narrationCaptionLines(segment.text, language).map(source => ({ source, text: segment.translation?.lines.find(line => line.source === source)?.text ?? '' })) };
}
export interface NarrationCaption { start: number; end: number; zh: string; en: string }
export function narrationCaptions(segments: NarrationSegment[], language: 'zh' | 'en') {
  return segments.flatMap(segment => {
    const lines = narrationCaptionLines(segment.text, language);
    const weights = lines.map(line => Math.max(1, Array.from(line.replace(/[\s\p{P}]/gu, '')).length)), total = weights.reduce((a, b) => a + b, 0);
    let elapsed = 0;
    return lines.map((line, i): NarrationCaption => {
      const start = segment.start + (segment.end - segment.start) * elapsed / total; elapsed += weights[i];
      const end = i === lines.length - 1 ? segment.end : segment.start + (segment.end - segment.start) * elapsed / total;
      const translated = currentNarrationTranslation(segment, language) ? segment.translation!.lines[i].text.trim() : '';
      return { start, end, zh: language === 'zh' ? line : translated, en: language === 'en' ? line : translated };
    });
  });
}
function plain(text: string) { return text.replaceAll('-->', '→').replace(/[<>&]/g, '').replace(/[\r\n]+/g, ' '); }
export function narrationCaptionFile(captions: NarrationCaption[], format: 'vtt' | 'srt', track: 'zh' | 'en' | 'bilingual') {
  const entries = captions.map(c => ({ ...c, text: (track === 'bilingual' ? [c.zh, c.en] : [c[track]]).filter(Boolean).map(plain).join('\n') })).filter(c => c.text);
  return (format === 'vtt' ? 'WEBVTT\n\n' : '') + entries.map((c, i) => {
    const timestamp = (seconds: number) => format === 'srt' ? narrationTimestamp(seconds).replace('.', ',') : narrationTimestamp(seconds);
    return `${format === 'srt' ? `${i + 1}\n` : ''}${timestamp(c.start)} --> ${timestamp(c.end)}\n${c.text}\n`;
  }).join('\n');
}
function assText(text: string) { return text.replaceAll('\\', '＼').replaceAll('{', '｛').replaceAll('}', '｝').replace(/[\r\n]+/g, ' '); }
function wrap(text: string, max: number, words = false) {
  const tokens = words ? text.split(/\s+/).filter(Boolean) : Array.from(text), rows: string[] = []; let row = '';
  for (const token of tokens) { const next = row + (words && row ? ' ' : '') + token; if (Array.from(next).length > max && row) { rows.push(row); row = token; } else row = next; }
  if (row) rows.push(row);
  return rows.map(assText).join('\\N');
}
export function narrationAss(captions: NarrationCaption[], width: number, height: number, bilingual: boolean, language: 'zh' | 'en') {
  const chineseSize = Math.max(14, Math.round(width * (height > width ? 0.062 : 0.045))), englishSize = Math.max(10, Math.round(chineseSize * 0.59)), outline = Math.max(1, Math.round(chineseSize * 0.055));
  const time = (seconds: number) => { const cs = Math.round(seconds * 100); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Chinese,Noto Serif CJK SC,${chineseSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,0,0,0,1\nStyle: English,DejaVu Serif,${englishSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,-1,0,0,0,100,100,0.7,0,1,${Math.max(1, outline - 1)},0,8,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  return header + captions.map(c => {
    const lines = [];
    if (c.zh && (bilingual || language === 'zh')) lines.push(`Dialogue: 0,${time(c.start)},${time(c.end)},Chinese,,0,0,0,,{\\pos(${Math.round(width / 2)},${Math.round(height * 0.665)})}${wrap(c.zh, 14)}`);
    if (c.en && (bilingual || language === 'en')) lines.push(`Dialogue: 0,${time(c.start)},${time(c.end)},English,,0,0,0,,{\\pos(${Math.round(width / 2)},${Math.round(height * 0.665 + chineseSize * 0.23)})}${wrap(c.en, 43, true)}`);
    return lines.join('\n');
  }).join('\n') + '\n';
}
