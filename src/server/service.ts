import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { all, databaseDriver, get, id, log, now, put, remove, transaction } from './db';
import { assetsWithTranscription, enqueueTranscription, reconcileAssetTranscription, transcriptFingerprint, withTranscription } from './transcription-queue';
import { AsrError, asrConfiguration, asrReady } from './asr';
import { MAX_CREATION_SOURCES, resolveCreationSources } from '../shared/creation-sources';
import { generateIdeas } from './ai';
import { indexTags, isUsable, parseTranscript, searchAssets } from './search';
import { hasCommand, roughCut, saveUpload, transcribe } from './media';
import { isDeletableDraft, MAX_DRAFT_DELETE_BATCH, type Asset, type Content, type ContentStatus, type Snapshot } from '../shared/types';
import { ApiError, required } from './errors';

export { ApiError, required } from './errors';
const text = z.string().trim().min(1).max(200);
const date = z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/).refine(v => !v || !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, '无效日期');
const notes = z.string().trim().max(4000).default('');
const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(24);
export const merchantSchema = z.object({ name: text, industry: text, city: text, audience: notes, positioning: notes, brandTone: z.string().max(200).default('自然、真诚') });
export const projectSchema = z.object({ merchantId: text, name: text, mode: z.enum(['shoot', 'managed']), dueDate: date, deliverables: z.number().int().min(1).max(1000), fee: z.number().min(0).max(100_000_000).default(0), goal: notes });
export async function createMerchant(input: unknown) { return (await put('merchants', { ...merchantSchema.parse(input), id: id(), createdAt: now() })); }
export async function createProject(input: unknown) {
  const data = projectSchema.parse(input); required((await get('merchants', data.merchantId)), '商家不存在');
  return (await transaction(async () => { const project = (await put('projects', { ...data, id: id(), createdAt: now() })); (await log(project.id, '项目已建档')); return project; }));
}
export async function projectAssets(projectId: string) { required((await get('projects', projectId)), '项目不存在'); return (await all('assets')).filter(a => a.projectId === projectId); }
export async function snapshot(): Promise<Snapshot> {
  const [ffmpeg, ffprobe] = await Promise.all([hasCommand('ffmpeg'), hasCommand('ffprobe')]);
  const asr = asrReady() ? asrConfiguration() : null;
  return { merchants: (await all('merchants')), projects: (await all('projects')), assets: (await assetsWithTranscription()), contents: (await all('contents')).map(c => ({ ...c, reviewToken: null })), tasks: (await all('tasks')), activities: (await all('activities')).slice(0, 60), capabilities: { ai: !!(process.env.AI_BASE_URL && process.env.AI_API_KEY && process.env.AI_MODEL), asr: !!asr, asrProvider: asr?.provider, asrModel: asr?.model, ffmpeg, ffprobe, authRequired: !!process.env.HUB_ACCESS_TOKEN, storage: `${databaseDriver === 'postgres' ? 'PostgreSQL' : 'SQLite 演示'} · 本地文件`, search: '关键词 + 同义词扩展（非向量检索）' } };
}
export async function upload(form: FormData) {
  const projectId = text.parse(form.get('projectId')); required((await get('projects', projectId)), '项目不存在');
  const file = form.get('file'); if (!(file instanceof File)) throw new ApiError('请选择文件');
  const tags = tagsSchema.parse(String(form.get('tags') || '').split(/[,，、]/).map(s => s.trim()).filter(Boolean));
  const rights = z.enum(['authorized', 'pending', 'expired']).parse(form.get('rights') || 'pending');
  const expiresAt = date.parse(String(form.get('expiresAt') || ''));
  const note = notes.parse(String(form.get('note') || ''));
  const asset = await saveUpload(file, projectId, tags, rights, expiresAt, note);
  (await transaction(async () => { (await put('assets', asset)); (await enqueueTranscription(asset)); (await log(projectId, `上传素材「${asset.name}」`)); }));
  return (await withTranscription(asset));
}
export async function updateAsset(assetId: string, input: unknown) {
  const data = z.object({ tags: tagsSchema.optional(), rights: z.enum(['authorized', 'pending', 'expired']).optional(), expiresAt: date.optional(), note: notes.optional(), transcript: z.string().max(100_000).optional() }).strict().parse(input);
  return (await transaction(async () => {
    const asset = required((await get('assets', assetId)));
    const { transcript, ...fields } = data;
    const segments = transcript === undefined ? asset.segments : parseTranscript(transcript);
    const updated = (await put('assets', { ...asset, ...fields, segments, tags: indexTags(segments, fields.tags || asset.tags), transcriptSource: transcript === undefined ? asset.transcriptSource : segments.length ? 'manual' : 'none' }));
    (await reconcileAssetTranscription(updated, transcript !== undefined));
    (await log(asset.projectId, `更新素材索引「${asset.name}」`)); return (await withTranscription(updated));
  }));
}
const transcriptionInFlight = new Map<string, Promise<Asset>>();
export function runTranscription(assetId: string, options: { signal?: AbortSignal; isCurrent?: () => boolean | Promise<boolean>; beforeSubmit?: () => void | Promise<void>; onSaved?: () => void | Promise<void> } = {}): Promise<Asset> {
  const existing = transcriptionInFlight.get(assetId); if (existing) return existing;
  const work = transcribeAndSave(assetId, options).finally(() => { transcriptionInFlight.delete(assetId); });
  transcriptionInFlight.set(assetId, work); return work;
}
async function transcribeAndSave(assetId: string, options: { signal?: AbortSignal; isCurrent?: () => boolean | Promise<boolean>; beforeSubmit?: () => void | Promise<void>; onSaved?: () => void | Promise<void> }) {
  const asset = required((await get('assets', assetId)));
  if (!isUsable(asset)) throw new ApiError('请先确认素材授权，过期素材不能转写');
  const config = asrConfiguration();
  const fingerprint = transcriptFingerprint(asset);
  let pending = (await get('asr_jobs', assetId));
  if (pending && (config?.provider !== 'aliyun' || pending.model !== config.model || pending.baseUrl !== config.baseUrl || pending.fingerprint !== fingerprint || Date.now() - Date.parse(pending.createdAt) > 23 * 3600000)) {
    (await remove('asr_jobs', assetId)); pending = undefined;
  }
  try {
    options.signal?.throwIfAborted();
    const segments = await transcribe(asset, pending, async taskId => {
      required((await get('assets', assetId)));
      (await put('asr_jobs', { id: assetId, projectId: asset.projectId, taskId, baseUrl: config!.baseUrl, model: config!.model, fingerprint, createdAt: now() }));
    }, options);
    return (await transaction(async () => {
      const current = required((await get('assets', assetId)));
      options.signal?.throwIfAborted();
      if (options.isCurrent && !(await options.isCurrent())) throw new ApiError('转写任务已更新，后台结果未覆盖', 409);
      if (transcriptFingerprint(current) !== fingerprint) throw new ApiError('转写期间逐字稿已被修改，请重新尝试', 409);
      if (!isUsable(current)) throw new ApiError('转写期间素材授权发生变更', 409);
      const updated = (await put('assets', { ...current, segments, tags: indexTags(segments, current.tags), transcriptSource: 'asr', error: null }));
      (await remove('asr_jobs', assetId)); await options.onSaved?.();
      (await log(asset.projectId, `真实 ASR 完成「${asset.name}」${config?.provider === 'aliyun' ? ' · 阿里云百炼' : ''}`)); return updated;
    }));
  } catch (error) {
    if (error instanceof AsrError && error.terminal) (await remove('asr_jobs', assetId));
    throw error;
  }
}
export async function requestTranscription(assetId: string) {
  return (await transaction(async () => {
    const asset = required((await get('assets', assetId)));
    if (!asset.storageKey || !['video', 'audio'].includes(asset.kind)) throw new ApiError('请上传真实视频或音频');
    if (!isUsable(asset)) throw new ApiError('请先确认素材授权，过期素材不能转写');
    if (!asrReady()) throw new ApiError('尚未配置真实 ASR；可先导入逐字稿或 SRT');
    (await enqueueTranscription(asset, true)); return (await withTranscription(asset));
  }));
}
export async function cutAsset(assetId: string, input: unknown) {
  const data = z.object({ start: z.number().finite().min(0), end: z.number().finite().positive() }).parse(input);
  const asset = required((await get('assets', assetId))); if (!isUsable(asset)) throw new ApiError('素材授权未确认或已过期');
  const cut = await roughCut(asset, data.start, data.end);
  return (await transaction(async () => {
    const current = required((await get('assets', assetId))); if (!isUsable(current)) throw new ApiError('处理期间素材授权发生变更', 409);
    (await put('assets', { ...cut, rights: current.rights, expiresAt: current.expiresAt })); (await log(asset.projectId, `生成真实粗剪「${cut.name}」`)); return cut;
  }));
}
export async function deleteAsset(assetId: string) {
  return (await transaction(async () => {
    const asset = required((await get('assets', assetId)));
    if ((await all('contents')).some(c => c.sourceAssetIds.includes(assetId) || c.mediaAssetId === assetId)) throw new ApiError('素材已被内容引用，请先修改内容再删除', 409);
    if ((await all('studio_sessions')).some(s => s.turns.some(t => t.assetIds.includes(assetId)) || s.attached.includes(assetId))) throw new ApiError('素材已被创作对话或画布引用', 409);
    (await remove('assets', assetId)); (await log(asset.projectId, `移除素材「${asset.name}」（磁盘文件保留供恢复）`));
    return { ok: true };
  }));
}
export async function deleteDrafts(input: unknown) {
  const data = z.object({ projectId: text, items: z.array(z.object({ id: text, version: z.number().int().positive() })).min(1).max(MAX_DRAFT_DELETE_BATCH) }).parse(input);
  required((await get('projects', data.projectId)), '项目不存在');
  if (new Set(data.items.map(item => item.id)).size !== data.items.length) throw new ApiError('删除列表包含重复草稿');
  return (await transaction(async () => {
    // Validate the entire batch before removing anything; stale state rejects all items.
    const contents = await Promise.all(data.items.map(async item => {
      const content = required((await get('contents', item.id)), '草稿不存在或已被删除');
      if (content.projectId !== data.projectId) throw new ApiError('只能删除当前项目的草稿');
      if (content.version !== item.version) throw new ApiError('草稿版本已变化，请刷新后重新确认', 409);
      if (!isDeletableDraft(content)) throw new ApiError('仅草稿和待修改内容可以删除；审核中、已通过、已交付或已排期内容请先处理其业务状态', 409);
      return content;
    }));
    for (const content of contents) {
      (await remove('contents', content.id));
      (await log(content.projectId, `删除草稿「${content.title}」v${content.version}（关联素材保留）`));
    }
    return { ok: true, deletedIds: contents.map(content => content.id), count: contents.length };
  }));
}
export async function search(projectId: string, query: string) { return searchAssets((await projectAssets(projectId)), z.string().trim().min(1).max(500).parse(query)); }
export async function generate(input: unknown) {
  const { projectId, objective, platform, referenceMode, referenceAssetIds } = z.object({ projectId: text, objective: z.string().max(2000).default(''), platform: z.enum(['抖音', '小红书', '视频号']), referenceMode: z.enum(['manual', 'auto']).default('manual'), referenceAssetIds: z.array(text).max(MAX_CREATION_SOURCES).optional() }).parse(input);
  const project = required((await get('projects', projectId))); const merchant = required((await get('merchants', project.merchantId)));
  const references = resolveCreationSources((await projectAssets(projectId)), projectId, { mode: referenceMode, assetIds: referenceAssetIds });
  const result = await generateIdeas(merchant, project, references, objective, platform);
  return (await transaction(async () => {
    for (const reference of references) {
      const current = required((await get('assets', reference.id)), '生成期间参考素材已被删除，请重新选择');
      if (current.projectId !== projectId || !isUsable(current)) throw new ApiError('生成期间参考素材授权或归属发生变化，请重新选择', 409);
    }
    const contents = await Promise.all(result.ideas.map(async idea => {
      for (const key of idea.sourceAssetIds) { const a = required(await get('assets', key)); if (a.projectId !== projectId || !isUsable(a)) throw new ApiError('生成期间素材授权或归属发生变化，请重试', 409); }
      return (await put('contents', { ...idea, id: id(), projectId, platform, mediaAssetId: null, provider: result.provider, status: 'draft', version: 1, reviews: [], reviewToken: null, reviewExpiresAt: null, scheduledAt: null, createdAt: now() }));
    }));
    (await log(projectId, `生成 ${contents.length} 条选题文案 · ${result.provider === 'demo' ? '演示模板' : '真实 AI'}`));
    return { contents, provider: result.provider };
  }));
}
async function verifySources(content: Content) {
  for (const assetId of [...content.sourceAssetIds, ...(content.mediaAssetId ? [content.mediaAssetId] : [])]) {
    const asset = required((await get('assets', assetId)), '引用素材不存在');
    if (asset.projectId !== content.projectId) throw new ApiError('禁止引用其他项目的素材');
    if (!isUsable(asset)) throw new ApiError(`素材「${asset.name}」未授权或已过期`);
  }
  if (content.mediaAssetId && !(await get('assets', content.mediaAssetId))?.storageKey) throw new ApiError('交付媒体必须是实际上传或生成的文件');
}
export async function revise(contentId: string, input: unknown) {
  const data = z.object({ version: z.number().int(), title: text, platform: z.enum(['抖音', '小红书', '视频号']), brief: notes, script: z.string().max(12000), caption: z.string().max(6000), hashtags: z.array(z.string().max(60)).max(12), sourceAssetIds: z.array(text).max(30), mediaAssetId: text.nullable() }).parse(input);
  return (await transaction(async () => {
    const current = required((await get('contents', contentId))); if (data.version !== current.version) throw new ApiError('内容版本已变化，请刷新后重试', 409);
    const updated: Content = { ...current, ...data, status: 'draft', version: current.version + 1, reviewToken: null, reviewExpiresAt: null, scheduledAt: null, reviews: [...current.reviews, { id: id(), action: 'revise', author: '运营团队', comment: '已修订，原审核链接失效，需重新提交', version: current.version + 1, at: now() }] };
    (await verifySources(updated)); (await put('contents', updated)); (await log(current.projectId, `修订「${updated.title}」至 v${updated.version}`)); return updated;
  }));
}
export async function transition(contentId: string, input: unknown, reviewer = '运营团队') {
  const data = z.object({ action: z.enum(['submit', 'approve', 'request_changes', 'deliver', 'schedule', 'publish']), version: z.number().int(), comment: z.string().trim().max(2000).default(''), scheduledAt: z.string().max(50).optional() }).parse(input);
  return (await transaction(async () => {
    const current = required((await get('contents', contentId))); if (current.version !== data.version) throw new ApiError('内容版本已变化，请刷新', 409);
    const project = required((await get('projects', current.projectId)));
    const rules: Record<typeof data.action, { from: ContentStatus[]; to: ContentStatus }> = {
      submit: { from: ['draft', 'changes_requested'], to: 'in_review' }, approve: { from: ['in_review'], to: 'approved' },
      request_changes: { from: ['in_review'], to: 'changes_requested' }, deliver: { from: ['approved'], to: 'delivered' },
      schedule: { from: ['approved'], to: 'scheduled' }, publish: { from: ['scheduled'], to: 'published' }
    };
    const rule = rules[data.action]; if (!rule.from.includes(current.status)) throw new ApiError('当前状态不允许此操作，请刷新状态', 409);
    if (data.action === 'deliver' && project.mode !== 'shoot') throw new ApiError('代运营项目请使用排期流程');
    if (['schedule', 'publish'].includes(data.action) && project.mode !== 'managed') throw new ApiError('拍摄交付项目不提供运营排期');
    if (data.action === 'request_changes' && !data.comment) throw new ApiError('请填写修改意见');
    if (data.action !== 'request_changes') (await verifySources(current));
    const updated = { ...current, status: rule.to, reviews: [...current.reviews, { id: id(), action: data.action, author: reviewer, comment: data.comment, version: current.version, at: now() }] };
    if (data.action === 'submit') { updated.reviewToken = randomBytes(24).toString('hex'); updated.reviewExpiresAt = new Date(Date.now() + 7 * 86400000).toISOString(); }
    if (data.action === 'schedule') {
      if (!data.scheduledAt || Number.isNaN(Date.parse(data.scheduledAt)) || Date.parse(data.scheduledAt) < Date.now()) throw new ApiError('排期时间必须为未来时间');
      updated.scheduledAt = new Date(data.scheduledAt).toISOString();
    }
    if (data.action === 'publish' && current.scheduledAt && Date.parse(current.scheduledAt) > Date.now()) throw new ApiError('尚未到排期时间，请到时确认发布');
    (await put('contents', updated)); (await log(current.projectId, `「${current.title}」状态更新：${rule.to}`)); return updated;
  }));
}
export async function reviewContent(token: string) {
  if (!/^[a-f0-9]{48}$/.test(token)) throw new ApiError('审核链接无效或已失效', 404);
  const content = required((await all('contents')).find(c => c.reviewToken === token), '审核链接无效或已失效');
  if (!content.reviewExpiresAt || Date.parse(content.reviewExpiresAt) < Date.now()) throw new ApiError('审核链接已过期', 410);
  return content;
}
export async function publicReview(token: string) {
  const c = (await reviewContent(token)); const project = required((await get('projects', c.projectId))); const merchant = required((await get('merchants', project.merchantId)));
  const media = c.mediaAssetId ? (await get('assets', c.mediaAssetId)) : undefined;
  return { id: c.id, title: c.title, platform: c.platform, brief: c.brief, script: c.script, caption: c.caption, hashtags: c.hashtags, provider: c.provider, status: c.status, version: c.version, reviews: c.reviews, merchantName: merchant.name, projectName: project.name, mode: project.mode, media: media && isUsable(media) && media.storageKey ? { name: media.name, kind: media.kind } : null };
}
export async function createTask(input: unknown) {
  const data = z.object({ projectId: text, title: text, description: notes, owner: z.string().max(100).default('未分配'), dueDate: date, priority: z.enum(['high', 'normal']).default('normal') }).parse(input);
  required((await get('projects', data.projectId))); return (await transaction(async () => { const t = (await put('tasks', { ...data, id: id(), status: 'todo', createdAt: now() })); (await log(data.projectId, `新增拍摄任务「${data.title}」`)); return t; }));
}
export async function updateTask(taskId: string, input: unknown) {
  const data = z.object({ status: z.enum(['todo', 'done']) }).parse(input);
  return (await transaction(async () => { const task = required((await get('tasks', taskId))); const t = (await put('tasks', { ...task, ...data })); (await log(task.projectId, `${data.status === 'done' ? '完成' : '重新打开'}拍摄任务「${task.title}」`)); return t; }));
}
export async function delivery(projectId: string) {
  const project = required((await get('projects', projectId))), merchant = required((await get('merchants', project.merchantId)));
  const contents = (await all('contents')).filter(c => c.projectId === projectId && ['approved', 'delivered', 'scheduled', 'published'].includes(c.status));
  if (!contents.length) throw new ApiError('没有审核通过的内容，暂不能导出交付包');
  for (const content of contents) await verifySources(content);
  return { generatedAt: now(), project, merchant, warning: '本包为内容交付清单。未关联成片的内容仅含脚本与文案。演示模板均标注 provider=demo。', contents: contents.map(({ reviewToken: _token, ...c }) => ({ ...c, mediaDownload: c.mediaAssetId ? `/api/files/${c.mediaAssetId}?download=1` : null })), assets: (await projectAssets(projectId)).filter(a => contents.some(c => c.sourceAssetIds.includes(a.id) || c.mediaAssetId === a.id)).map(({ storageKey: _key, thumbnailKey: _thumb, ...a }) => ({ ...a, download: a.size ? `/api/files/${a.id}?download=1` : null })) };
}
