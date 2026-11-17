import type { DubbingSettings } from './dubbing-settings';
import type { DubbingPart } from './dubbing-script';
export type BusinessMode = 'shoot' | 'managed';
export type ContentStatus = 'draft' | 'in_review' | 'changes_requested' | 'approved' | 'delivered' | 'scheduled' | 'published';
export type Rights = 'authorized' | 'pending' | 'expired';
export interface Merchant {
  id: string; name: string; industry: string; city: string; audience: string;
  positioning: string; brandTone: string; createdAt: string;
}
export interface Project {
  id: string; merchantId: string; name: string; mode: BusinessMode;
  dueDate: string; deliverables: number; fee: number; goal: string; createdAt: string;
}
export interface WordTiming { start: number; end: number; text: string; punctuation?: string }
export interface Segment { start: number | null; end: number | null; text: string; words?: WordTiming[]; speakerId?: number }
export type TranscriptionStatus = 'waiting_authorization' | 'waiting_configuration' | 'queued' | 'processing' | 'retrying' | 'completed' | 'failed' | 'cancelled' | 'skipped';
export interface TranscriptionState { status: TranscriptionStatus; updatedAt: string; error: string | null; nextAttemptAt?: string }
export const transcriptionLabels: Record<TranscriptionStatus, string> = { waiting_authorization: '确认授权后自动转写', waiting_configuration: '等待配置语音服务', queued: '等待后台转写', processing: '后台转写中', retrying: '转写处理中，正在继续查询', completed: '语音转写完成', failed: '语音转写失败', cancelled: '已保留人工逐字稿', skipped: '无音轨，已跳过转写' };
export interface Asset {
  id: string; projectId: string; name: string; kind: 'video' | 'audio' | 'image' | 'document';
  toolSource?: { type: 'dubbing' | 'douyin' | 'dubbing-source'; id: string; revision?: number };
  mime: string; size: number; storageKey: string; thumbnailKey: string | null; duration: number | null;
  tags: string[]; segments: Segment[]; transcriptSource: 'none' | 'manual' | 'asr' | 'demo';
  hasAudio?: boolean; transcription?: TranscriptionState;
  rights: Rights; expiresAt: string; note: string; error: string | null; createdAt: string;
}
export interface Review { id: string; action: 'submit' | 'approve' | 'request_changes' | 'revise' | 'deliver' | 'schedule' | 'publish'; comment: string; author: string; version: number; at: string }
export interface Content {
  id: string; projectId: string; title: string; platform: string; brief: string;
  script: string; caption: string; hashtags: string[]; sourceAssetIds: string[];
  mediaAssetId: string | null; provider: 'demo' | 'api' | 'manual';
  status: ContentStatus; version: number; reviews: Review[]; reviewToken: string | null;
  reviewExpiresAt: string | null; scheduledAt: string | null; createdAt: string;
}
export interface ShotTask { id: string; projectId: string; title: string; description: string; owner: string; dueDate: string; priority: 'high' | 'normal'; status: 'todo' | 'done'; createdAt: string }
export interface Activity { id: string; projectId: string; text: string; at: string }
export type VoiceStatus = 'waiting_configuration' | 'queued' | 'processing' | 'ready' | 'failed' | 'deleting' | 'delete_failed';
export const MAX_DUBBING_TEXT = 2000;
export interface VoiceProfile {
  id: string; name: string; sampleDuration: number | null; model: string;
  status: VoiceStatus; error: string | null; consentAt: string; createdAt: string; updatedAt: string;
}
export type DubbingStatus = 'queued' | 'processing' | 'completed' | 'failed';
export interface Dubbing extends Partial<Pick<DubbingSettings, 'pitch' | 'tone' | 'emotion'>> {
  projectId?: string; parts?: DubbingPart[]; completedParts?: number;
  id: string; title: string; text: string; voiceId: string; voiceName: string;
  sourceId: string | null; rate: number; status: DubbingStatus; hasAudio: boolean;
  error: string | null; createdAt: string; updatedAt: string;
}
export interface DubbingMedia { id: string; name: string; kind: 'video' | 'audio'; mime: string; size: number; storageKey: string; duration: number | null; hasAudio?: boolean }
export interface DubbingSource { projectId?: string; id: string; name: string; duration: number | null; status: 'waiting_configuration' | 'queued' | 'processing' | 'completed' | 'failed' | 'skipped'; segments: Segment[]; error: string | null; createdAt: string; updatedAt: string }
export const dubbingSourceLabels: Record<DubbingSource['status'], string> = { waiting_configuration: '等待转写服务配置', queued: '等待提取文案', processing: '正在提取文案', completed: '文案已提取', failed: '文案提取失败', skipped: '视频没有音轨' };
export interface DubbingSnapshot { voices: VoiceProfile[]; dubbings: Dubbing[]; sources: DubbingSource[]; capabilities: { tts: boolean; ttsModel?: string; asr: boolean; ffmpeg: boolean; ffprobe: boolean; authRequired: boolean } }
export const voiceStatusLabels: Record<VoiceStatus, string> = { waiting_configuration: '等待语音服务配置', queued: '等待创建音色', processing: '正在创建音色', ready: '可用于配音', failed: '音色创建失败', deleting: '正在删除音色', delete_failed: '音色删除失败' };
export const dubbingStatusLabels: Record<DubbingStatus, string> = { queued: '等待生成', processing: '正在生成', completed: '配音已完成', failed: '生成失败' };
export interface Capabilities { ai: boolean; asr: boolean; asrProvider?: string; asrModel?: string; ffmpeg: boolean; ffprobe: boolean; authRequired: boolean; storage: string; search: string }
export interface Snapshot { merchants: Merchant[]; projects: Project[]; assets: Asset[]; contents: Content[]; tasks: ShotTask[]; activities: Activity[]; capabilities: Capabilities }
export interface SearchHit { asset: Asset; segment: Segment | null; score: number; reason: string }
export const statusLabels: Record<ContentStatus, string> = { draft: '草稿', in_review: '待客户审核', changes_requested: '待修改', approved: '已通过', delivered: '已交付', scheduled: '已排期', published: '已发布' };
export const modeLabels: Record<BusinessMode, string> = { shoot: '拍摄交付', managed: '代运营' };

export const MAX_DRAFT_DELETE_BATCH = 200;
export function isDeletableDraft(content: Pick<Content, 'status'>) { return content.status === 'draft' || content.status === 'changes_requested'; }
