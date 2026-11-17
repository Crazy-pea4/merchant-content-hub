import { z } from 'zod';
import { all, get, put, now, transaction } from './db';
import { ApiError, required } from './errors';
import { isUsable } from './search';
import { assetsWithTranscription } from './transcription-queue';
import { emptyStudioSession, type StudioState, type StudioTurn } from '../shared/studio';
import { visionReady } from './narration-vision';
import { writeStudioTurn } from './studio-writing';

async function sessionFor(key: string) {
  const project = required(await get('projects', key), '创作不存在');
  return await get('studio_sessions', key) || emptyStudioSession(key, project.name, project.createdAt);
}
export async function openStudio(input: unknown) {
  const { id, title } = z.object({ id: z.string().uuid(), title: z.string().trim().min(1).max(120) }).parse(input);
  return transaction(async () => {
    if (await get('projects', id)) return sessionFor(id);
    const at = now(), merchantId = 'fieldwork-personal';
    if (!await get('merchants', merchantId)) await put('merchants', { id: merchantId, name: '个人创作', industry: '', city: '', audience: '', positioning: '', brandTone: '', createdAt: at });
    await put('projects', { id, merchantId, name: title, mode: 'shoot', dueDate: '', deliverables: 1, fee: 0, goal: '', createdAt: at });
    return put('studio_sessions', emptyStudioSession(id, title, at));
  });
}
const timeoutMs = 120000;
function stale(t: StudioTurn) { return t.status === 'writing' && Date.now() - Date.parse(t.updatedAt) > timeoutMs + 15000; }

export async function studioState(): Promise<StudioState> {
  const [projects, sessions, assets, contents, voices, subtitles, renders] = await Promise.all([
    all('projects'), all('studio_sessions'), assetsWithTranscription(), all('contents'), all('dubbings'), all('douyin_extractions'), all('narration_renders'),
  ]);
  return {
    projects: projects.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
    sessions: sessions.map(s => ({ ...s, turns: s.turns.map(t => stale(t) ? { ...t, status: 'failed', error: '上次生成中断，可重新尝试' } : t) })),
    assets, contents: contents.map(c => ({ ...c, reviewToken: null })),
    ai: !!(process.env.AI_API_KEY && process.env.AI_BASE_URL && process.env.AI_MODEL) || visionReady(),
    media: [
      ...voices.filter(v => v.status === 'completed' && v.hasAudio).map(v => ({ id: v.id, title: v.title, kind: '配音' as const, projectId: v.projectId, url: '/api/dubbing-files/' + v.id, text: v.text, createdAt: v.createdAt })),
      ...subtitles.filter(v => v.status === 'completed').map(v => ({ id: v.id, title: v.title, kind: '字幕' as const, projectId: v.projectId, url: '/api/douyin-extractions/' + v.id + '/download?format=srt', text: v.text, createdAt: v.createdAt })),
      ...renders.filter(v => v.status === 'completed' && v.hasVideo).map(v => ({ id: v.id, title: v.title, kind: '成片' as const, url: '/api/narration-files/' + v.id, text: '', createdAt: v.createdAt })),
    ],
  };
}
const identifier = z.string().min(1).max(200);
async function usableAsset(id: string) {
  const a = required(await get('assets', id), '参考素材已移除，请重新选择');
  if (!isUsable(a)) throw new ApiError('「' + a.name + '」的使用授权待确认或已到期', 409);
  return a;
}
export async function sendStudioTurn(key: string, input: unknown) {
  const data = z.object({ id: z.string().uuid(), prompt: z.string().trim().min(1).max(8000), mode: z.enum(['script','shots','copy']),
    assetIds: z.array(identifier).max(8), baseId: identifier.optional() }).parse(input);
  const start = await transaction(async () => {
    const session = await sessionFor(key);
    const prior = session.turns.find(t => t.id === data.id);
    if (prior && (prior.prompt !== data.prompt || prior.mode !== data.mode)) throw new ApiError('请求已变化，请重新发送', 409);
    if (prior && (prior.status === 'done' || prior.status === 'writing' && !stale(prior))) return { completed: prior };
    if (session.turns.some(t => t.id !== data.id && t.status === 'writing' && !stale(t))) throw new ApiError('这段对话还在生成中，请稍候', 409);
    const done = session.turns.filter(t => t.status === 'done');
    const base = data.baseId && !done.some(t => t.id === data.baseId) ? await get('contents', data.baseId) : undefined;
    if (base && base.projectId !== key || data.baseId && !base && !done.some(t => t.id === data.baseId)) throw new ApiError('要续写的作品不属于本次创作', 409);
    const parent = data.baseId ? done.find(t => t.id === data.baseId) : done.at(-1);
    const history: StudioTurn[] = [];
    if (base) history.push({ id: base.id, prompt: base.title, mode: 'script', assetIds: base.sourceAssetIds, title: base.title, body: base.script, version: base.version, status: 'done', createdAt: base.createdAt, updatedAt: base.createdAt });
    for (let p = parent; p && history.length < 6; p = done.find(item => item.id === p?.previousId)) history.unshift(p);
    const assetIds = [...new Set(data.assetIds.length ? data.assetIds : parent?.assetIds || base?.sourceAssetIds || [])];
    if (assetIds.length > 8) throw new ApiError('每次最多参考 8 份素材，请选择本次需要的素材');
    const assets = await Promise.all(assetIds.map(usableAsset));
    for (const assetId of new Set(history.flatMap(t => t.assetIds))) await usableAsset(assetId);
    const at = now();
    const turn: StudioTurn = { id: data.id, prompt: data.prompt, mode: data.mode, assetIds, previousId: parent?.id || base?.id,
      title: '', body: '', version: 1, status: 'writing', createdAt: prior?.createdAt || at, updatedAt: at };
    session.turns = prior ? session.turns.map(t => t.id === prior.id ? turn : t) : [...session.turns, turn];
    await put('studio_sessions', { ...session, updatedAt: at, attached: [...new Set([...session.attached, ...assetIds])] });
    return { turn, assets, history };
  });
  if (start.completed) return start.completed;
  const { turn, history, assets } = start;
  try {
    const result = await writeStudioTurn(turn, history, assets, AbortSignal.timeout(timeoutMs));
    return await transaction(async () => {
      for (const id of new Set([...turn.assetIds, ...history.flatMap(t => t.assetIds)])) await usableAsset(id);
      const s = await sessionFor(key), current = required(s.turns.find(t => t.id === turn.id));
      if (current.updatedAt !== turn.updatedAt || current.status !== 'writing') return current;
      const updated: StudioTurn = { ...turn, ...result, status: 'done', updatedAt: now() };
      await put('studio_sessions', { ...s, updatedAt: updated.updatedAt, turns: s.turns.map(t => t.id === turn.id ? updated : t) });
      return updated;
    });
  } catch (error) {
    const message = error instanceof ApiError ? error.message : '连接创作服务失败或超时，已保留你的输入';
    await transaction(async () => {
      const s = await sessionFor(key);
      await put('studio_sessions', { ...s, turns: s.turns.map(t => t.id === turn.id && t.status === 'writing' && t.updatedAt === turn.updatedAt ? { ...t, status: 'failed', error: message, updatedAt: now() } : t) });
    });
    throw new ApiError(message, 409);
  }
}
export async function editStudioTurn(key: string, input: unknown) {
  const data = z.object({ id: identifier, version: z.number().int(), title: z.string().trim().min(1).max(160), body: z.string().trim().min(1).max(30000) }).parse(input);
  return transaction(async () => {
    const s = await sessionFor(key), turn = required(s.turns.find(t => t.id === data.id));
    if (turn.status !== 'done' || turn.version !== data.version) throw new ApiError('作品已更新，请重新打开后再保存', 409);
    const updated = { ...turn, title: data.title, body: data.body, version: turn.version + 1, updatedAt: now() };
    await put('studio_sessions', { ...s, updatedAt: updated.updatedAt, turns: s.turns.map(t => t.id === turn.id ? updated : t) });
    return updated;
  });
}
const boardInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('attach'), assetId: identifier }),
  z.object({ action: z.literal('move'), node: identifier, x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000) }),
  z.object({ action: z.literal('connect'), from: identifier, to: identifier }),
  z.object({ action: z.literal('disconnect'), from: identifier, to: identifier }),
]);
export async function changeBoard(key: string, input: unknown) {
  const change = boardInput.parse(input);
  return transaction(async () => {
    const s = await sessionFor(key);
    async function hasNode(node: string) {
      if (node.startsWith('a:')) { const id = node.slice(2); return s.attached.includes(id) || (await get('assets', id))?.projectId === key; }
      if (node.startsWith('w:')) return s.turns.some(t => t.id === node.slice(2) && t.status === 'done') || (await get('contents', node.slice(2)))?.projectId === key;
      return false;
    }
    if (change.action === 'attach') {
      await usableAsset(change.assetId);
      if (!s.attached.includes(change.assetId)) s.attached.push(change.assetId);
    } else if (change.action === 'move') {
      if (!await hasNode(change.node)) throw new ApiError('画布卡片不存在');
      s.positions[change.node] = { x: change.x, y: change.y };
    } else {
      if (change.from === change.to || !await hasNode(change.from) || !await hasNode(change.to)) throw new ApiError('请选择画布上的两张不同卡片');
      s.links = s.links.filter(l => l.from !== change.from || l.to !== change.to);
      if (change.action === 'connect') s.links.push({ from: change.from, to: change.to });
    }
    return put('studio_sessions', { ...s, updatedAt: now() });
  });
}
