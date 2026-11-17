import { z } from 'zod';
import { dubbingEmotions, dubbingInstruction, dubbingTones, supportsDubbingExpression, type DubbingSettings } from '../shared/dubbing-settings';
import { ApiError } from './errors';

export const dubbingSettingsShape = {
  rate: z.number().finite().min(0.5).max(2).default(1),
  pitch: z.number().finite().min(0.5).max(2).default(1),
  tone: z.enum(dubbingTones).default('natural'),
  emotion: z.enum(dubbingEmotions).default('neutral')
};
export const dubbingSettingsSchema = z.object(dubbingSettingsShape);
export function assertDubbingExpression(model: string, settings: DubbingSettings) {
  if (dubbingInstruction(settings) && !supportsDubbingExpression(model)) throw new ApiError('当前音色不支持语调和情感控制，请选择自然朗读与自然表达，或使用支持表达控制的音色');
}
