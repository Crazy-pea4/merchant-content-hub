export const dubbingTones = ['natural', 'conversational', 'storytelling', 'broadcast', 'emphasis'] as const;
export const dubbingEmotions = ['neutral', 'warm', 'happy', 'calm', 'serious', 'sad', 'excited', 'relaxed'] as const;
export type DubbingTone = typeof dubbingTones[number];
export type DubbingEmotion = typeof dubbingEmotions[number];
export interface DubbingSettings { rate: number; pitch: number; tone: DubbingTone; emotion: DubbingEmotion }
export const defaultDubbingSettings: DubbingSettings = { rate: 1, pitch: 1, tone: 'natural', emotion: 'neutral' };
export const dubbingToneLabels: Record<DubbingTone, string> = { natural: '自然朗读', conversational: '日常聊天', storytelling: '讲述故事', broadcast: '清晰播报', emphasis: '重点强调' };
export const dubbingEmotionLabels: Record<DubbingEmotion, string> = { neutral: '自然表达', warm: '温暖亲切', happy: '开心愉快', calm: '平静沉稳', serious: '严肃认真', sad: '低落悲伤', excited: '兴奋有活力', relaxed: '轻松自然' };
const toneInstructions: Record<DubbingTone, string> = { natural: '', conversational: '用日常聊天的语调，表达自然流畅。', storytelling: '用讲故事的语调，句间停顿自然。', broadcast: '用清晰播报的语调，吐字清楚。', emphasis: '用重点突出的语调，适当强调关键词。' };
const emotionInstructions: Record<DubbingEmotion, string> = { neutral: '', warm: '语气温暖亲切。', happy: '情绪开心愉快。', calm: '情绪平静沉稳。', serious: '语气严肃认真。', sad: '情绪低落悲伤，表达克制。', excited: '情绪兴奋有活力。', relaxed: '情绪轻松自然，表达舒展。' };
export function resolveDubbingSettings(value: Partial<DubbingSettings>): DubbingSettings {
  return { rate: value.rate ?? 1, pitch: value.pitch ?? 1, tone: value.tone ?? 'natural', emotion: value.emotion ?? 'neutral' };
}
export function dubbingInstruction(settings: DubbingSettings) { return toneInstructions[settings.tone] + emotionInstructions[settings.emotion]; }
export function supportsDubbingExpression(model: string) { return ['cosyvoice-v3-flash', 'cosyvoice-v3.5-flash', 'cosyvoice-v3.5-plus'].includes(model); }
export function dubbingSettingsLabel(value: Partial<DubbingSettings>) {
  const settings = resolveDubbingSettings(value);
  return `${dubbingToneLabels[settings.tone]} · ${dubbingEmotionLabels[settings.emotion]} · 音高 ${settings.pitch.toFixed(2)} 倍 · ${settings.rate} 倍语速`;
}
