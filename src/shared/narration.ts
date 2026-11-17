import type { DubbingSettings } from './dubbing-settings';
import type { VoiceProfile } from './types';

export const MAX_NARRATION_SECONDS = 600;
export const MAX_NARRATION_SHOTS = 60;
export const narrationStyles = { natural: '自然讲述', documentary: '纪实解说', warm: '温暖舒缓', lively: '轻快有活力' } as const;
export type NarrationStyle = keyof typeof narrationStyles;
export interface NarrationShot { id: string; start: number; end: number; description: string; text: string; settings: DubbingSettings }
export type NarrationSubtitleMode = 'original' | 'bilingual';
export interface NarrationTranslation { sourceText: string; lines: { source: string; text: string }[] }
export interface NarrationSegment { id: string; start: number; end: number; text: string; settings: DubbingSettings; translation?: NarrationTranslation }
export interface NarrationProject {
  id: string; title: string; name: string; duration: number; hasOriginalAudio: boolean;
  voiceId: string; language: 'zh' | 'en'; style: NarrationStyle; revision: number; subtitleMode: NarrationSubtitleMode;
  status: 'queued' | 'analyzing' | 'ready' | 'failed'; stage: string;
  summary: string; shots: NarrationShot[]; segments: NarrationSegment[]; error: string | null; autoRenderPending: boolean;
  createdAt: string; updatedAt: string;
}
export interface NarrationRender {
  id: string; projectId: string; revision: number; title: string; voiceId: string; voiceName: string;
  shots: NarrationShot[]; segments: NarrationSegment[]; alignedSegments: NarrationSegment[] | null; originalVolume: number; subtitleMode: NarrationSubtitleMode; burnedCaptions: boolean; hasCleanVideo: boolean; language: 'zh' | 'en'; status: 'queued' | 'processing' | 'completed' | 'failed';
  completedShots: number; stage: string; error: string | null; hasVideo: boolean; createdAt: string; updatedAt: string;
}
export interface NarrationSnapshot {
  projects: NarrationProject[]; renders: NarrationRender[]; voices: VoiceProfile[];
  capabilities: { vision: boolean; tts: boolean; translation: boolean; media: boolean; authRequired: boolean; maxUploadMB: number; maxSeconds: number };
}
export function narrationIdentity(shots: NarrationShot[]) {
  return shots.map(s => [s.id, s.start, s.end, s.description, s.text, s.settings.rate, s.settings.pitch, s.settings.tone, s.settings.emotion]);
}
export function narrationSegments(record: { shots: NarrationShot[]; segments?: NarrationSegment[] }): NarrationSegment[] {
  return record.segments ?? record.shots.map(({ id, start, end, text, settings }) => ({ id, start, end, text, settings }));
}
export function narrationSegmentIdentity(segments: NarrationSegment[]) {
  return segments.map(s => [s.id, s.start, s.end, s.text, s.settings.rate, s.settings.pitch, s.settings.tone, s.settings.emotion, s.translation ? [s.translation.sourceText, s.translation.lines.map(line => [line.source, line.text])] : null]);
}
export function mergeNarrationSegments(segments: NarrationSegment[], index: number) {
  const first = segments[index], next = segments[index + 1];
  if (!first || !next) return null;
  const text = [first.text.trim(), next.text.trim()].filter(Boolean).join(' ');
  if (text.length > 500) return null;
  const translation = first.translation || next.translation ? { sourceText: text, lines: [...(first.translation?.lines ?? []), ...(next.translation?.lines ?? [])] } : undefined;
  return [...segments.slice(0, index), { ...first, end: next.end, text, ...(translation ? { translation } : {}) }, ...segments.slice(index + 2)];
}
export function splitNarrationSegment(segments: NarrationSegment[], index: number, id: string) {
  const segment = segments[index];
  if (!segment || segment.text.trim().length < 2 || segment.end - segment.start < 0.2 || segments.length >= MAX_NARRATION_SHOTS) return null;
  const text = segment.text.trim(), candidates = [...text.matchAll(/[。！？!?；;，,]\s*/g)].map(m => m.index! + m[0].length).filter(i => i > 0 && i < text.length);
  const characters = Array.from(text);
  if (characters.length < 2) return null;
  const cut = candidates.sort((a, b) => Math.abs(a - text.length / 2) - Math.abs(b - text.length / 2))[0] ?? characters.slice(0, Math.ceil(characters.length / 2)).join('').length;
  const at = Number(Math.min(segment.end - 0.001, Math.max(segment.start + 0.001, segment.start + (segment.end - segment.start) * cut / text.length)).toFixed(3));
  return [...segments.slice(0, index), { ...segment, end: at, text: text.slice(0, cut).trim() }, { ...segment, id, start: at, text: text.slice(cut).trim() }, ...segments.slice(index + 1)];
}
export function narrationTextBudget(seconds: number, language: 'zh' | 'en') {
  return Math.max(1, Math.floor(seconds * (language === 'en' ? 9 : 3)));
}
export function narrationTimestamp(seconds: number) {
  const ms = Math.round(seconds * 1000);
  return `${Math.floor(ms / 3600000).toString().padStart(2, '0')}:${Math.floor(ms / 60000 % 60).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}.${(ms % 1000).toString().padStart(3, '0')}`;
}
export function narrationVtt(shots: Pick<NarrationSegment, 'start' | 'end' | 'text'>[]) {
  return 'WEBVTT\n\n' + shots.filter(s => s.text.trim()).map(s => `${narrationTimestamp(s.start)} --> ${narrationTimestamp(s.end)}\n${s.text.replaceAll('-->', '→').replace(/[<>&]/g, '').replace(/\n+/g, ' ')}\n`).join('\n');
}
