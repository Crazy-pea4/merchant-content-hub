import { z } from 'zod';
import { dubbingEmotions, dubbingTones } from './dubbing-settings';
import { MAX_NARRATION_SHOTS, narrationSegments } from './narration';

export const narrationShotSchema = z.object({
  id: z.string().uuid(), start: z.number().finite().min(0), end: z.number().finite().positive(),
  description: z.string().trim().max(1000), text: z.string().max(500),
  settings: z.object({ rate: z.number().finite().min(0.5).max(2), pitch: z.number().finite().min(0.5).max(2), tone: z.enum(dubbingTones), emotion: z.enum(dubbingEmotions) }).strict()
}).strict();
export const narrationShotsSchema = z.array(narrationShotSchema).min(1).max(MAX_NARRATION_SHOTS);
export const narrationTranslationSchema = z.object({ sourceText: z.string().max(500), lines: z.array(z.object({ source: z.string().max(500), text: z.string().max(1200) }).strict()).max(100) }).strict();
export const narrationSegmentSchema = narrationShotSchema.omit({ description: true }).extend({ translation: narrationTranslationSchema.optional() });
export const narrationSegmentsSchema = z.array(narrationSegmentSchema).min(1).max(MAX_NARRATION_SHOTS);
export function validNarrationTimeline(segments: { id: string; start: number; end: number }[], duration: number) {
  return new Set(segments.map(s => s.id)).size === segments.length && segments.every((s, i) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end > s.start && s.end <= duration + 0.001 && (!i || s.start >= segments[i - 1].end));
}
const draftSchema = z.object({ revision: z.number().int().positive(), title: z.string().max(120), shots: narrationShotsSchema, segments: narrationSegmentsSchema.optional(), subtitleMode: z.enum(['original', 'bilingual']).optional(), voiceId: z.string().uuid().optional(), originalVolume: z.number().finite().min(0).max(1).optional(), selectedShotId: z.string().uuid().optional(), selectedSegmentId: z.string().uuid().optional() });
export function readNarrationDraft(raw: string | null) {
  if (!raw || raw.length > 2000000) return null;
  try { const p = draftSchema.safeParse(JSON.parse(raw)); return p.success ? { ...p.data, segments: narrationSegments(p.data) } : null; } catch { return null; }
}
