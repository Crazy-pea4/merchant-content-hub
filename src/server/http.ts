import { createEdit, updateEdit, planEdit, enqueueEditExport } from './video-edits';
import { editPreviewResponse, editSourceMetadata } from './video-edit-media';
import { allowedOrigins } from '../api/config';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { all, get } from './db';
import { maxUploadBytes, uploadDir } from './media';
import { isUsable } from './search';
import * as service from './service';
import { studioState, openStudio, sendStudioTurn, editStudioTurn, changeBoard } from './studio';
import { saveToolAsset } from './tool-assets';
import { createVoice, deleteVoice, dubbingFile, dubbingSnapshot, enqueueDubbing, retryDubbing, retryVoice, retryDubbingSource, uploadDubbingSource } from './dubbing';
import { previewDubbing } from './dubbing-preview';
import { enqueueNarrationRender, narrationFile, narrationSnapshot, retryNarration, retryNarrationRender, saveNarration, uploadNarration } from './narration';
import { douyinSnapshot, enqueueDouyin, retryDouyin, saveDouyin } from './douyin';
import { douyinSrt } from '../shared/douyin';
import { narrationVtt, narrationSegments } from '../shared/narration';
import { narrationCaptions, narrationCaptionFile } from '../shared/narration-captions';

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
function matches(value: string, expected: string) {
  const a = Buffer.from(value), b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b);
}
function authenticated(req: Request) {
  const expected = process.env.HUB_ACCESS_TOKEN;
  if (!expected) return true;
  const bearer = req.headers.get('authorization')?.replace(/^Bearer /i, '') || '';
  const cookie = req.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith('hub_session='))?.slice(12) || '';
  return matches(bearer, expected) || matches(cookie, expected);
}
async function limitedBody(req: Request, max: number) {
  if (Number(req.headers.get('content-length')) > max) throw new service.ApiError('请求体超过大小限制', 413);
  const reader = req.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > max) { await reader.cancel(); throw new service.ApiError('请求体超过大小限制', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; } return data;
}
async function body(req: Request, limit = 200_000) {
  try { return JSON.parse(new TextDecoder().decode(await limitedBody(req, limit))); }
  catch (e) { if (e instanceof service.ApiError) throw e; throw new service.ApiError('请求不是有效 JSON'); }
}
async function fileResponse(assetId: string, req: Request, thumbnail = false, download = false, scoped = false) {
  const asset = service.required((await get('assets', assetId)));
  if (scoped && !isUsable(asset)) throw new service.ApiError('媒体授权不可用', 403);
  const key = thumbnail ? asset.thumbnailKey : asset.storageKey;
  if (!key) throw new service.ApiError('这是演示占位素材，没有实际文件', 404);
  return storedFileResponse({ ...asset, storageKey: key }, req, thumbnail, download);
}
async function storedFileResponse(file: { storageKey: string; name: string; mime: string; kind: string }, req: Request, thumbnail = false, download = false) {
  const key = file.storageKey;
  if (!key || basename(key) !== key) throw new service.ApiError('文件不存在', 404);
  let buffer: Buffer;
  try { buffer = await readFile(join(uploadDir, key)); } catch { throw new service.ApiError('文件不存在，请重新上传', 404); }
  const headers: Record<string, string> = { 'Content-Type': thumbnail ? 'image/jpeg' : file.mime, 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes', 'Content-Disposition': `${download || file.kind === 'document' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}` };
  const range = req.headers.get('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${buffer.length}` } });
    const start = match[1] ? Number(match[1]) : Math.max(0, buffer.length - Number(match[2]));
    const end = match[1] ? match[2] ? Math.min(Number(match[2]), buffer.length - 1) : buffer.length - 1 : buffer.length - 1;
    if (start >= buffer.length || start > end || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${buffer.length}` } });
    return new Response(new Uint8Array(buffer.subarray(start, end + 1)), { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${buffer.length}` } });
  }
  return new Response(new Uint8Array(buffer), { headers: { ...headers, 'Content-Length': String(buffer.length) } });
}
export async function handleApi(req: Request, path: string[]) {
  try {
    const [resource, key, action] = path; const url = new URL(req.url); const method = req.method;
    if (method !== 'GET') {
      const origin = req.headers.get('origin');
      // Next may normalize request.url to localhost; compare the browser origin to the received Host.
      const expectedOrigin = `${url.protocol}//${req.headers.get('host') || url.host}`;
      if (origin && origin !== expectedOrigin && !allowedOrigins().includes(origin)) throw new service.ApiError('不允许跨来源写入', 403);
    }
    if (resource === 'health' && method === 'GET') return json({ ok: true, authRequired: !!process.env.HUB_ACCESS_TOKEN, version: '0.1.0', backend: 'fastify' });
    if (resource === 'session' && method === 'POST') {
      const data = z.object({ token: z.string().max(500) }).parse(await body(req));
      if (!process.env.HUB_ACCESS_TOKEN || !matches(data.token, process.env.HUB_ACCESS_TOKEN)) throw new service.ApiError('访问口令不正确', 401);
      return Response.json({ ok: true }, { headers: { 'Set-Cookie': `hub_session=${process.env.HUB_ACCESS_TOKEN}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=43200${url.protocol === 'https:' || req.headers.get('origin')?.startsWith('https://') ? '; Secure' : ''}` } });
    }
    if (resource === 'review' && key) {
      const current = (await service.reviewContent(key));
      if (method === 'GET' && action === 'media') return await fileResponse(service.required(current.mediaAssetId || undefined, '尚未关联成片'), req, false, url.searchParams.has('download'), true);
      if (method === 'GET' && !action) return json((await service.publicReview(key)));
      if (method === 'POST' && !action) {
        const data = z.object({ action: z.enum(['approve', 'request_changes']), version: z.number().int(), comment: z.string().trim().max(2000).default(''), author: z.string().trim().min(1).max(100).default('商家客户') }).parse(await body(req));
        (await service.transition(current.id, data, data.author)); return json((await service.publicReview(key)));
      }
      throw new service.ApiError('接口不存在', 404);
    }
    if (!authenticated(req)) throw new service.ApiError('请输入访问口令', 401);
    if (resource === 'edit-previews' && key && method === 'GET') {
      if (action === 'metadata') return json(await editSourceMetadata(key));
      if (!action) return await editPreviewResponse(key, req);
    }
    if (resource === 'video-edits') {
      if (!key && method === 'POST') return json(await createEdit(await body(req)), 201);
      if (key && !action && method === 'PATCH') return json(await updateEdit(key, await body(req)));
      if (key && action === 'plan' && method === 'POST') return json(await planEdit(key, await body(req)));
      if (key && action === 'exports' && method === 'POST') return json(await enqueueEditExport(key, await body(req)), 202);
    }
    if (resource === 'studio' && !key && method === 'GET') return json(await studioState());
    if (resource === 'studio-sessions') {
      if (!key && method === 'POST') return json(await openStudio(await body(req)));
      if (key && action === 'turns' && method === 'POST') return json(await sendStudioTurn(key, await body(req)));
      if (key && action === 'turns' && method === 'PATCH') return json(await editStudioTurn(key, await body(req)));
      if (key && action === 'board' && method === 'PATCH') return json(await changeBoard(key, await body(req)));
    }
    if (resource === 'douyin-extractions' && key && method === 'PATCH' && !action) return json(await saveDouyin(key, await body(req)));
    if (resource === 'douyin-extractions' && method === 'POST') {
      if (!key) return json(await enqueueDouyin(await body(req)), 202);
      if (action === 'retry') return json(await retryDouyin(key), 202);
    }
    if (method === 'GET') {
      if (resource === 'douyin-workspace' && !key) return json(await douyinSnapshot(url.searchParams.get('projectId') || undefined));
      if (resource === 'douyin-extractions' && key && action === 'download') {
        const job = service.required(await get('douyin_extractions', key), '提取记录不存在');
        if (job.status !== 'completed') throw new service.ApiError('文案尚未提取完成', 409);
        const srt = url.searchParams.get('format') === 'srt';
        return new Response(srt ? douyinSrt(job.cues) : job.text + '\n', { headers: { 'Content-Type': srt ? 'application/x-subrip; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename="douyin-${key}.${srt ? 'srt' : 'txt'}"` } });
      }
      if (resource === 'narration-workspace' && !key) return json(await narrationSnapshot());
      if (resource === 'narration-files' && key) {
        if (url.searchParams.has('captions')) {
          const render = service.required(await get('narration_renders', key), '成片不存在');
          const language = render.language ?? (await get('narrations', render.projectId))?.language ?? 'zh';
          const format = url.searchParams.get('format') === 'srt' ? 'srt' : 'vtt', requested = url.searchParams.get('track');
          const track = requested === 'zh' || requested === 'en' || requested === 'bilingual' ? requested : render.subtitleMode === 'bilingual' ? 'bilingual' : language;
          const segments = render.alignedSegments ?? narrationSegments(render);
          const text = format === 'vtt' && !requested && render.subtitleMode !== 'bilingual' ? narrationVtt(segments) : narrationCaptionFile(narrationCaptions(segments, language), format, track);
          return new Response(text, { headers: { 'Content-Type': format === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8', 'Cache-Control': 'private, no-store', ...(url.searchParams.has('download') ? { 'Content-Disposition': `attachment; filename="narration-${key}-${track}.${format}"` } : {}) } });
        }
        return await storedFileResponse(await narrationFile(key, url.searchParams.has('source'), url.searchParams.get('frame') || undefined, url.searchParams.has('clean')), req, false, url.searchParams.has('download'));
      }
      if (resource === 'dubbing-workspace') return json(await dubbingSnapshot(url.searchParams.get('projectId') || undefined));
      if (resource === 'dubbing-files' && key) return await storedFileResponse(await dubbingFile(key, url.searchParams.has('sample'), url.searchParams.has('source')), req, false, url.searchParams.has('download'));
      if (resource === 'snapshot') return json(await service.snapshot());
      if (resource === 'contents' && key && action === 'review-link') {
        const content = service.required((await get('contents', key)));
        if (!content.reviewToken || !content.reviewExpiresAt || Date.parse(content.reviewExpiresAt) < Date.now()) throw new service.ApiError('审核链接已失效，请重新提交审核');
        return json({ reviewUrl: `/review/${content.reviewToken}` });
      }
      if (resource === 'search') return json({ hits: (await service.search(url.searchParams.get('projectId') || '', url.searchParams.get('q') || '')) });
      if (resource === 'files' && key) return await fileResponse(key, req, url.searchParams.has('thumb'), url.searchParams.has('download'));
      if (resource === 'projects' && key && action === 'delivery') return new Response(JSON.stringify((await service.delivery(key)), null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="delivery-${key}.json"`, 'Cache-Control': 'no-store' } });
    }
    if (method === 'POST') {
      if (resource === 'projects' && key && action === 'tool-assets') return json(await saveToolAsset(key, await body(req)));
      if (resource === 'narrations' && !key) {
        const data = await limitedBody(req, maxUploadBytes() + 2 * 1024 * 1024);
        const form = await new Response(data, { headers: { 'Content-Type': req.headers.get('content-type') || '' } }).formData();
        return json(await uploadNarration(form), 202);
      }
      if (resource === 'narrations' && key && action === 'retry') return json(await retryNarration(key), 202);
      if (resource === 'narrations' && key && action === 'renders') return json(await enqueueNarrationRender(key, await body(req)), 202);
      if (resource === 'narration-renders' && key && action === 'retry') return json(await retryNarrationRender(key), 202);
      if (resource === 'dubbings' && key === 'preview' && !action) {
        const audio = await previewDubbing(await body(req), req.signal);
        return new Response(new Uint8Array(audio), { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(audio.length), 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' } });
      }
      if (resource === 'dubbing-sources' && !key) {
        const data = await limitedBody(req, maxUploadBytes() + 2 * 1024 * 1024);
        const form = await new Response(data, { headers: { 'Content-Type': req.headers.get('content-type') || '' } }).formData();
        return json(await uploadDubbingSource(form), 202);
      }
      if (resource === 'dubbing-sources' && key && action === 'retry') return json(await retryDubbingSource(key), 202);
      if (resource === 'voices' && !key) {
        const data = await limitedBody(req, 12 * 1024 * 1024);
        const form = await new Response(data, { headers: { 'Content-Type': req.headers.get('content-type') || '' } }).formData();
        return json(await createVoice(form), 202);
      }
      if (resource === 'voices' && key && action === 'retry') return json(await retryVoice(key), 202);
      if (resource === 'dubbings' && !key) return json(await enqueueDubbing(await body(req)), 202);
      if (resource === 'dubbings' && key && action === 'retry') return json(await retryDubbing(key), 202);
      if (resource === 'merchants') return json((await service.createMerchant(await body(req))), 201);
      if (resource === 'projects') return json((await service.createProject(await body(req))), 201);
      if (resource === 'assets' && !key) {
        const data = await limitedBody(req, maxUploadBytes() + 2 * 1024 * 1024);
        const form = await new Response(data, { headers: { 'Content-Type': req.headers.get('content-type') || '' } }).formData();
        return json(await service.upload(form), 201);
      }
      if (resource === 'assets' && key && action === 'transcribe') return json((await service.requestTranscription(key)), 202);
      if (resource === 'assets' && key && action === 'cut') return json(await service.cutAsset(key, await body(req)), 201);
      if (resource === 'generate') return json(await service.generate(await body(req)), 201);
      if (resource === 'contents' && key === 'bulk-delete' && !action) return json((await service.deleteDrafts(await body(req))));
      if (resource === 'tasks') return json((await service.createTask(await body(req))), 201);
      if (resource === 'contents' && key && action === 'transition') {
        const content = (await service.transition(key, await body(req)));
        return json({ ...content, reviewUrl: content.reviewToken ? `/review/${content.reviewToken}` : null, reviewToken: null });
      }
    }
    if (method === 'PATCH') {
      if (resource === 'narrations' && key && !action) return json(await saveNarration(key, await body(req, 2_000_000)));
      if (resource === 'assets' && key) return json((await service.updateAsset(key, await body(req))));
      if (resource === 'contents' && key) return json((await service.revise(key, await body(req))));
      if (resource === 'tasks' && key) return json((await service.updateTask(key, await body(req))));
    }
    if (method === 'DELETE' && resource === 'contents' && key && !action) {
      const data = z.object({ projectId: z.string().min(1), version: z.number().int().positive() }).parse(await body(req));
      return json((await service.deleteDrafts({ projectId: data.projectId, items: [{ id: key, version: data.version }] })));
    }
    if (method === 'DELETE' && resource === 'assets' && key) return json((await service.deleteAsset(key)));
    if (method === 'DELETE' && resource === 'voices' && key && !action) return json(await deleteVoice(key), 202);
    throw new service.ApiError('接口不存在', 404);
  } catch (error) {
    if (error instanceof z.ZodError) return json({ error: '请检查输入内容', details: error.issues.map(e => `${e.path.join('.')}: ${e.message}`).slice(0, 8) }, 400);
    if (error instanceof service.ApiError) return json({ error: error.message }, error.status);
    // Service errors are deliberately safe messages; never return provider bodies or credentials.
    if (error instanceof Error && !('code' in error) && !/SQLITE|constraint|fetch failed|ECONN|ENOENT/i.test(error.message)) return json({ error: error.name === 'TimeoutError' ? '处理超时，请稍后重试' : error.message }, 400);
    console.error('Hub API failure', error instanceof Error ? error.name : 'unknown');
    return json({ error: '处理失败，请检查服务配置或稍后重试' }, 500);
  }
}
