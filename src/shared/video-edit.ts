import type { Asset, Segment } from './types';

export const editFps = 30;
export const editMaxFrames = 10 * 60 * editFps;
export const maxEditClips = 96;
export const editSizes = { landscape: [1280, 720], portrait: [720, 1280], square: [960, 960] } as const;
export type EditAspect = keyof typeof editSizes;
export interface EditClip { id: string; assetId: string; start: number; end: number; volume: number }
export interface Timeline { clips: EditClip[]; aspect: EditAspect; voiceId: string; captions: boolean }
export interface EditMessage { id: string; prompt: string; reply: string; gaps: string[]; at: string }
export interface VideoEdit {
  id: string; projectId: string; title: string; revision: number; timeline: Timeline;
  scriptId?: string; messages: EditMessage[]; updatedAt: string; canUndo: boolean; canRedo: boolean;
}
export interface EditExport { id: string; editId: string; revision: number; status: 'queued'|'rendering'|'completed'|'failed'; error?: string; assetId?: string }
export const frames = (seconds: number) => Math.round(seconds * editFps);
export const clipLength = (c: EditClip) => c.end - c.start;
export const timelineLength = (t: Timeline) => t.clips.reduce((n,c) => n + clipLength(c), 0);
export const frameLabel = (f: number) => (f/editFps).toFixed(2) + ' 秒';
export function makeClip(asset: Asset): EditClip {
  return { id: crypto.randomUUID(), assetId: asset.id, start: 0, end: Math.min(editMaxFrames, frames(asset.duration || 0)), volume: 1 };
}
export function removeInterval(clip: EditClip, from: number, to: number): EditClip[] {
  if (to <= from || to <= clip.start || from >= clip.end) return [clip];
  const result: EditClip[] = [];
  if (from > clip.start) result.push({ ...clip, end: from });
  if (to < clip.end) result.push({ ...clip, id: result.length ? crypto.randomUUID() : clip.id, start: to });
  return result;
}
export function clipCues(asset: Asset | undefined, clip: EditClip): Segment[] {
  const cues: Segment[] = [];
  for (const s of asset?.segments ?? []) {
    if (s.start === null || s.end === null) continue;
    const start = Math.max(s.start, clip.start/editFps), end = Math.min(s.end, clip.end/editFps);
    if (end <= start) continue;
    const words = s.words?.filter(w => w.end > start && w.start < end).map(w => ({ ...w, start: Math.max(start,w.start), end: Math.min(end,w.end) }));
    const text = words?.length ? words.map(w => w.text + (w.punctuation || '')).join('') : s.text;
    cues.push({ ...s, start, end, text, words });
  }
  return cues;
}
export function timelineCues(t: Timeline, assets: Asset[]): Segment[] {
  let offset = 0;
  return t.clips.flatMap(c => {
    const shift = (offset - c.start)/editFps;
    offset += clipLength(c);
    return clipCues(assets.find(a=>a.id===c.assetId),c).map(s=>({ ...s, start:s.start!+shift, end:s.end!+shift,
      words:s.words?.map(w=>({...w,start:w.start+shift,end:w.end+shift})) }));
  });
}
