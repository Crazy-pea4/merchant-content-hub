import type { NarrationShot, NarrationSegment } from '../shared/narration';
import { ApiError } from './errors';
import { validNarrationTimeline } from '../shared/narration-draft';
export { narrationShotSchema, narrationShotsSchema, narrationSegmentsSchema } from '../shared/narration-draft';
export function validateNarrationSegments(segments: NarrationSegment[], duration: number) {
  if (!validNarrationTimeline(segments, duration)) throw new ApiError('旁白段落的时间范围需在视频内，并按顺序排列，不能相互重叠');
  if (!segments.some(s => s.text.trim())) throw new ApiError('请至少填写一段旁白，其余时间可以留白');
}
export function validateNarrationShots(shots: NarrationShot[], original: NarrationShot[]) {
  if (shots.length !== original.length || new Set(shots.map(s => s.id)).size !== shots.length || shots.some((s, i) => s.id !== original[i].id || s.start !== original[i].start || s.end !== original[i].end)) throw new ApiError('分镜时间线已变化，请刷新后重新编辑', 409);
  if (!shots.some(s => s.text.trim())) throw new ApiError('请至少为一个分镜填写旁白，其余分镜可以留白');
}
