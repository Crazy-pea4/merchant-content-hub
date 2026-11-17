import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Asset } from '../shared/types';
import { douyinSrt } from '../shared/douyin';
import { get, id, log, now, put, query, transaction } from './db';
import { ApiError, required } from './errors';
import { saveUpload, uploadDir } from './media';
import { indexTags, parseTranscript } from './search';

const sourceId = z.string().min(1).max(200);
const sourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('dubbing'), id: sourceId }),
  z.object({ type: z.literal('dubbing-source'), id: sourceId }),
  z.object({ type: z.literal('douyin'), id: sourceId, revision: z.number().int().positive() }),
]);

function checkProject(record: { projectId?: string }, projectId: string) {
  if (record.projectId && record.projectId !== projectId) throw new ApiError('此记录属于其他项目', 409);
}

export async function saveToolAsset(projectId: string, input: unknown): Promise<Asset> {
  const source = sourceSchema.parse(input);
  let newFile: string | undefined;
  try {
    return await transaction(async () => {
      required(await get('projects', projectId), '项目不存在');
      const existing = await query<{ data: Asset }>('SELECT data FROM assets WHERE project_id=$1', [projectId]);
      const saved = existing.rows.find(({ data: { toolSource } }) => toolSource?.type === source.type && toolSource.id === source.id && toolSource.revision === ('revision' in source ? source.revision : undefined));
      if (saved) return saved.data;

      let asset: Asset;
      if (source.type === 'dubbing') {
        const job = required(await get('dubbings', source.id), '配音不存在');
        checkProject(job, projectId);
        if (job.status !== 'completed' || !job.output) throw new ApiError('请等待配音完成', 409);
        const segments = parseTranscript(job.text);
        asset = { ...job.output, id: id(), projectId, kind: 'audio', thumbnailKey: null, rights: 'pending', expiresAt: '',
          segments, transcriptSource: 'manual', tags: indexTags(segments, ['配音']), note: '音色：' + job.voiceName, error: null, createdAt: now() };
      } else if (source.type === 'douyin') {
        const job = required(await get('douyin_extractions', source.id), '字幕记录不存在');
        checkProject(job, projectId);
        if (job.status !== 'completed' || job.revision !== source.revision) throw new ApiError('字幕版本已变化或尚未完成，请刷新后重试', 409);
        asset = await saveUpload(new File([douyinSrt(job.cues)], job.title.slice(0, 170) + '.srt'), projectId, ['抖音字幕'], 'pending', '', job.sourceUrl);
        newFile = asset.storageKey;
        asset.segments = job.cues.map(({ start, end, text }) => ({ start, end, text }));
      } else {
        const job = required(await get('dubbing_sources', source.id), '转写记录不存在');
        checkProject(job, projectId);
        if (job.status !== 'completed' || !job.segments.length) throw new ApiError('请等待视频文案提取完成', 409);
        const text = job.segments.map(segment => segment.text).join('\n');
        const name = job.name.replace(/\.[^.]+$/, '').slice(0, 170) + '.txt';
        asset = await saveUpload(new File([text], name), projectId, ['视频转写'], 'pending', '', job.name);
        newFile = asset.storageKey;
        asset.segments = job.segments;
        asset.transcriptSource = 'asr';
      }
      asset.toolSource = source;
      await put('assets', asset);
      await log(projectId, '保存项目素材「' + asset.name + '」');
      return asset;
    });
  } catch (error) {
    if (newFile) await unlink(join(uploadDir, newFile)).catch(() => {});
    throw error;
  }
}
