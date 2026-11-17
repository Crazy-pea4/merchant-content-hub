import { z } from 'zod';
import { MAX_DUBBING_PARTS, MAX_DUBBING_PART_TEXT, dubbingScriptText, speechPlan, type DubbingPart } from '../shared/dubbing-script';
import type { DubbingSettings } from '../shared/dubbing-settings';
import { dubbingSettingsSchema, assertDubbingExpression } from './dubbing-settings';
import { ApiError } from './errors';

export const dubbingPartsSchema = z.array(z.object({
  id: z.string().uuid(), text: z.string().trim().min(1).max(MAX_DUBBING_PART_TEXT),
  settings: dubbingSettingsSchema.partial().strict().optional(),
  pauseAfterMs: z.number().int().min(0).max(3000).optional()
}).strict()).min(1).max(MAX_DUBBING_PARTS).optional();
export function validateDubbingScript(text: string, parts?: DubbingPart[]) {
  if (!parts) return;
  if (new Set(parts.map(part => part.id)).size !== parts.length) throw new ApiError('句子编号不能重复');
  if (dubbingScriptText(parts) !== text) throw new ApiError('逐句文案与整篇文案不一致，请重新检查');
}
export function assertScriptExpression(model: string, global: DubbingSettings, parts?: DubbingPart[]) {
  for (const part of parts ? speechPlan(parts, global) : [{ settings: global }]) assertDubbingExpression(model, part.settings);
}
