export interface DouyinCue { id: number; start: number; end: number; text: string }
export interface DouyinExtraction {
  projectId?: string; id: string; sourceUrl: string; position: 'bottom' | 'middle' | 'full'; status: 'queued' | 'processing' | 'completed' | 'failed'; stage: string;
  title: string; videoId: string | null; duration: number | null; text: string; cues: DouyinCue[];
  reviewStatus: 'unreviewed' | 'reviewed'; error: string | null; timings: Record<string, number>;
  createdAt: string; updatedAt: string; revision: number;
}
export interface DouyinSnapshot { jobs: DouyinExtraction[]; available: boolean }
export const douyinStages: Record<string, string> = { queued: '等待提取', resolving: '正在解析链接', downloading: '正在获取视频', sampling: '正在读取画面', recognizing: '正在识别中文字幕', preparing_ocr: '正在准备识别服务', exporting: '正在整理文案', completed: '文案已提取', failed: '提取失败' };
export function douyinText(cues: DouyinCue[]) { return cues.map(cue => cue.text).join('\n'); }
export function douyinSrt(cues: DouyinCue[]) {
  const stamp = (seconds: number) => { const ms = Math.round(seconds * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  return cues.map((cue, index) => `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}`).join('\n\n') + '\n';
}
