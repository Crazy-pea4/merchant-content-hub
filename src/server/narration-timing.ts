import { ApiError } from './errors';
import type { NarrationSegment } from '../shared/narration';

export const MAX_NARRATION_SPEEDUP = 1.35;
export const MIN_NARRATION_SPEED = 0.85;
// Reserve room for the short pads around speech, time stretching and codec rounding.
export const MAX_NARRATION_GAP = 1.85;
export function assertNarrationDuration(total: number, videoDuration: number) {
  if (!Number.isFinite(total) || total <= 0) throw new ApiError('旁白没有有效声音');
  if (total > videoDuration * MAX_NARRATION_SPEEDUP + 0.001) throw new ApiError(`整段旁白约 ${total.toFixed(1)} 秒，视频共 ${videoDuration.toFixed(1)} 秒；请精简旁白或调快语速后重新生成。已完成的声音片段会保留。`);
}
export function planNarration(segments: NarrationSegment[], durations: (number | null)[], videoDuration: number) {
  const spoken = segments.flatMap((segment, i) => {
    if (!segment.text.trim()) return [];
    const duration = durations[i];
    if (!duration || !Number.isFinite(duration) || duration < 0) throw new ApiError(`第 ${i + 1} 段旁白无有效声音`);
    return [{ segment, duration }];
  });
  const total = spoken.reduce((sum, s) => sum + s.duration, 0);
  assertNarrationDuration(total, videoDuration);
  const minimumSpeech = Math.max(0, videoDuration - MAX_NARRATION_GAP * (spoken.length + 1));
  if (total / MIN_NARRATION_SPEED < minimumSpeech - 0.001) throw new ApiError(`旁白内容偏短，实际约 ${total.toFixed(1)} 秒，视频共 ${videoDuration.toFixed(1)} 秒；适度放慢后仍无法将每处留白控制在 2 秒内，请补充旁白文案。已完成的声音片段会保留。`);
  const speed = total < minimumSpeech ? total / minimumSpeech : Math.max(1, total / videoDuration);
  // Reserve enough room for all remaining speech, then keep each preferred start when space permits.
  let remaining = total / speed, end = 0;
  const preferred = spoken.map(({ segment, duration }) => {
    const start = Math.max(end, Math.min(segment.start, Math.max(0, videoDuration - remaining)));
    end = Math.min(videoDuration, start + duration / speed);
    remaining -= duration / speed;
    return { ...segment, start, end };
  });
  const gaps = preferred.map((s, i) => Math.min(MAX_NARRATION_GAP, Math.max(0, s.start - (preferred[i - 1]?.end ?? 0))));
  gaps.push(Math.min(MAX_NARRATION_GAP, Math.max(0, videoDuration - end)));
  let spare = Math.max(0, videoDuration - total / speed - gaps.reduce((sum, gap) => sum + gap, 0));
  // Share displaced silence among all gaps with room, rather than moving a long silent tail into the middle.
  while (spare > 0.000001) {
    const available = gaps.map((gap, i) => gap < MAX_NARRATION_GAP - 0.000001 ? i : -1).filter(i => i >= 0);
    if (!available.length) break;
    const share = spare / available.length;
    for (const i of available) { const added = Math.min(MAX_NARRATION_GAP - gaps[i], share); gaps[i] += added; spare -= added; }
  }
  end = 0;
  const alignedSegments = spoken.map(({ segment, duration }, i) => {
    const start = end + gaps[i]; end = Math.min(videoDuration, start + duration / speed);
    return { ...segment, start, end };
  });
  return { speed, alignedSegments };
}
