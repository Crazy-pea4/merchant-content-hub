import { z } from 'zod';
import { dubbingEmotions, dubbingTones } from './dubbing-settings';
import { MAX_DUBBING_PARTS, MAX_DUBBING_PART_TEXT } from './dubbing-script';

export const DUBBING_DRAFT_KEY = 'personal-dubbing-draft:v1';
const reference = z.string().max(200);
// Drafts may contain unfinished/empty sentences and exceed the generation limit while being edited.
const draftSchema = z.object({
  version: z.literal(1), title: z.string().max(120), text: z.string().max(50000),
  mode: z.enum(['text', 'video']), scriptView: z.enum(['whole', 'sentences']),
  voiceId: reference, sourceId: reference, usedSourceId: reference.nullable(), selectedPartId: reference,
  rate: z.enum(['0.75', '1', '1.25', '1.5']), pitch: z.enum(['0.9', '1', '1.1']),
  tone: z.enum(dubbingTones), emotion: z.enum(dubbingEmotions),
  parts: z.array(z.object({ id: z.string().uuid(), text: z.string().max(MAX_DUBBING_PART_TEXT),
    settings: z.object({ rate: z.number().finite().min(0.5).max(2).optional(), pitch: z.number().finite().min(0.5).max(2).optional(), tone: z.enum(dubbingTones).optional(), emotion: z.enum(dubbingEmotions).optional() }).optional(),
    pauseAfterMs: z.number().int().min(0).max(3000).optional()
  })).max(MAX_DUBBING_PARTS).optional()
});
export type DubbingDraft = z.infer<typeof draftSchema>;
export function readDubbingDraft(value: string | null): DubbingDraft | null {
  if (!value || value.length > 200000) return null;
  try {
    const result = draftSchema.safeParse(JSON.parse(value));
    if (!result.success) return null;
    const draft = result.data;
    if (!draft.parts?.length) draft.scriptView = 'whole';
    if (draft.parts && new Set(draft.parts.map(part => part.id)).size !== draft.parts.length) return null;
    return draft;
  } catch { return null; }
}
