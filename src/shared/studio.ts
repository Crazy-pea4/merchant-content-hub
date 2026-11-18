import type { VideoEdit, EditExport } from './video-edit';
import type { Asset, Content, Project } from './types';

export const studioModes = { script: '剧本', shots: '分镜', copy: '文案' } as const;
export type StudioMode = keyof typeof studioModes;
export interface StudioTurn {
  id: string; prompt: string; mode: StudioMode; assetIds: string[]; previousId?: string;
  title: string; body: string; version: number; status: 'writing' | 'done' | 'failed';
  provider?: 'api' | 'demo'; error?: string; createdAt: string; updatedAt: string;
}
export interface BoardPoint { x: number; y: number }
export interface BoardLink { from: string; to: string }
export interface StudioSession {
  id: string; title: string; turns: StudioTurn[]; attached: string[];
  positions: Record<string, BoardPoint>; links: BoardLink[]; updatedAt: string;
}
export interface StudioMedia {
  id: string; title: string; kind: '配音' | '字幕' | '成片'; projectId?: string;
  url: string; text: string; createdAt: string;
}
export interface StudioState {
  edits: VideoEdit[]; exports: EditExport[]; projects: Pick<Project, 'id' | 'name' | 'createdAt'>[]; sessions: StudioSession[];
  assets: Asset[]; contents: Content[]; media: StudioMedia[]; ai: boolean;
}
export type BoardChange = { action: 'move'; node: string; x: number; y: number } |
  { action: 'connect' | 'disconnect'; from: string; to: string } | { action: 'attach'; assetId: string };
export function emptyStudioSession(id: string, title: string, at: string): StudioSession {
  return { id, title, updatedAt: at, turns: [], attached: [], positions: {}, links: [] };
}
