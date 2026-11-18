import { z } from 'zod';
import { get, id, now, put, transaction } from './db';
import { ApiError, required } from './errors';
import { isUsable } from './search';
import { emptyStudioSession } from '../shared/studio';
import { editMaxFrames, frames, maxEditClips, timelineCues, timelineLength, type EditExport, type Timeline, type VideoEdit } from '../shared/video-edit';
import type { Asset, Segment } from '../shared/types';
import { proposeTimeline } from './video-edit-plan';
import { dubbingFile } from './dubbing';

export interface StoredEdit extends VideoEdit {
  past: Timeline[]; future: Timeline[]; pending?: { id: string; at: number };
}
export interface StoredExport extends EditExport {
  timeline: Timeline; projectId: string; title: string; lease: number; owner?: string; cues?: Segment[];
}
const key = z.string().min(1).max(200);
const version = z.number().int().positive();
const clip = z.object({ id: z.string().uuid(), assetId: key, start: z.number().int().nonnegative(), end: z.number().int().positive(), volume: z.number().min(0).max(1) });
const timelineSchema = z.object({ clips: z.array(clip).max(maxEditClips), aspect: z.enum(['landscape','portrait','square']), voiceId: z.string().max(200), captions: z.boolean() });
export function publicEdit({past, future, pending, ...edit}: StoredEdit): VideoEdit {
  return { ...edit, canUndo: !!past.length, canRedo: !!future.length };
}
export function publicExport(job: StoredExport): EditExport {
  const {id,editId,revision,status,error,assetId} = job;
  return {id,editId,revision,status,error,assetId};
}
export async function editSource(key: string, kind: 'video'|'audio' = 'video') {
  const a = required(await get('assets',key), '来源素材已移除');
  if (!isUsable(a) || a.kind !== kind || !a.storageKey || !a.duration) throw new ApiError('需要已授权且有实际文件的' + (kind==='video'?'视频':'音频') + '：' + a.name,409);
  return a;
}
export async function voiceFile(ref: string) {
  if (ref.startsWith('a:')) return editSource(ref.slice(2),'audio');
  if (ref.startsWith('m:')) return dubbingFile(ref.slice(2),false,false);
  throw new ApiError('配音来源无效');
}
export async function validateTimeline(t: Timeline) {
  timelineSchema.parse(t);
  if (timelineLength(t) > editMaxFrames) throw new ApiError('每份草稿最多 10 分钟');
  if (new Set(t.clips.map(c=>c.id)).size !== t.clips.length) throw new ApiError('镜头编号重复');
  const sources = new Map<string,Asset>();
  for (const c of t.clips) {
    const asset = sources.get(c.assetId) || await editSource(c.assetId);
    if (c.end <= c.start || c.end > frames(asset.duration!)) throw new ApiError('裁切区间超出「'+asset.name+'」');
    sources.set(asset.id,asset);
  }
  if (t.voiceId) await voiceFile(t.voiceId);
  return [...sources.values()];
}
async function attach(edit: StoredEdit) {
  const project = required(await get('projects',edit.projectId));
  const s = await get('studio_sessions',project.id) || emptyStudioSession(project.id,project.name,project.createdAt);
  const refs = edit.timeline.clips.map(c=>c.assetId);
  if (edit.timeline.voiceId.startsWith('a:')) refs.push(edit.timeline.voiceId.slice(2));
  await put('studio_sessions',{ ...s, attached:[...new Set([...s.attached,...refs])], updatedAt:edit.updatedAt });
}
export async function createEdit(input: unknown) {
  const data=z.object({ id:z.string().uuid(), projectId:key, title:z.string().trim().min(1).max(160), assetIds:z.array(key).max(24), scriptId:key.optional() }).parse(input);
  return transaction(async()=>{
    const existing=await get('video_edits',data.id);
    if(existing){if(existing.projectId!==data.projectId)throw new ApiError('草稿编号已使用',409);return publicEdit(existing);}
    required(await get('projects',data.projectId));
    if(data.scriptId){
      const s=await get('studio_sessions',data.projectId), content=await get('contents',data.scriptId);
      if(!s?.turns.some(t=>t.id===data.scriptId && t.status==='done') && content?.projectId!==data.projectId)throw new ApiError('脚本不属于本次创作');
    }
    const sources=await Promise.all([...new Set(data.assetIds)].map(key=>editSource(key)));
    const sourceFrames=sources.map(a=>frames(a.duration!));
    if(sourceFrames.some(n=>n<1))throw new ApiError('素材不足一帧');
    const ratio=Math.min(1,editMaxFrames/sourceFrames.reduce((sum,n)=>sum+n,0));
    let remaining=editMaxFrames;
    const clips=sources.map((a,i)=>{
      const end=Math.min(Math.max(1,Math.floor(sourceFrames[i]*ratio)),remaining-(sources.length-i-1));
      remaining-=end;
      return {id:id(),assetId:a.id,start:0,end,volume:1};
    });
    const edit:StoredEdit={id:data.id,title:data.title,projectId:data.projectId,scriptId:data.scriptId,revision:1,updatedAt:now(),
      timeline:{clips,voiceId:'',captions:false,aspect:'landscape'},past:[],future:[],messages:[],canUndo:false,canRedo:false};
    await attach(edit);return publicEdit(await put('video_edits',edit));
  });
}
function checkVersion(edit: StoredEdit, rev: number) {
  if(edit.revision!==rev)throw new ApiError('草稿已更新，请重新载入后再修改',409);
}
function advance(edit:StoredEdit,timeline:Timeline): StoredEdit {
  return {...edit,timeline,past:[...edit.past.slice(-29),edit.timeline],future:[],revision:edit.revision+1,updatedAt:now()};
}
export async function updateEdit(editId:string,input:unknown) {
  const data=z.discriminatedUnion('action',[
    z.object({action:z.literal('save'),revision:version,timeline:timelineSchema}),
    z.object({action:z.literal('undo'),revision:version}),z.object({action:z.literal('redo'),revision:version})
  ]).parse(input);
  return transaction(async()=>{
    const e=required(await get('video_edits',editId));checkVersion(e,data.revision);
    const next=data.action==='save'?data.timeline:(data.action==='undo'?e.past:e.future).at(-1);
    if(!next)throw new ApiError('没有可以恢复的操作',409);
    await validateTimeline(next);
    const updated=advance(e,next);
    if(data.action==='undo'){updated.past=e.past.slice(0,-1);updated.future=[...e.future,e.timeline];}
    if(data.action==='redo')updated.future=e.future.slice(0,-1);
    await attach(updated);return publicEdit(await put('video_edits',updated));
  });
}
export async function planEdit(editId:string,input:unknown) {
  const d=z.object({id:z.string().uuid(),revision:version,prompt:z.string().trim().min(1).max(8000),assetIds:z.array(key).max(24).default([])}).parse(input);
  const edit=await transaction(async()=>{
    const e=required(await get('video_edits',editId));
    if(e.messages.some(m=>m.id===d.id))return e;
    checkVersion(e,d.revision);
    if(e.pending && Date.now()-e.pending.at<130000)throw new ApiError('剪辑建议正在生成',409);
    return put('video_edits',{...e,pending:{id:d.id,at:Date.now()}});
  });
  if(edit.messages.some(m=>m.id===d.id))return publicEdit(edit);
  try{
    const ids=[...new Set([...edit.timeline.clips.map(c=>c.assetId),...d.assetIds])];
    if(!ids.length)throw new ApiError('请先选择用来剪辑的视频');
    const assets=await Promise.all(ids.map(k=>editSource(k)));
    const script=edit.scriptId && ((await get('studio_sessions',edit.projectId))?.turns.find(t=>t.id===edit.scriptId)?.body || (await get('contents',edit.scriptId))?.script);
    const plan=await proposeTimeline(edit,d.prompt,assets,script||'');
    return await transaction(async()=>{
      const e=required(await get('video_edits',editId));checkVersion(e,d.revision);
      if(e.pending?.id!==d.id)throw new ApiError('生成请求已过期',409);
      await validateTimeline(plan.timeline);
      const updated=advance(e,plan.timeline);delete updated.pending;
      updated.messages=[...e.messages,{id:d.id,prompt:d.prompt,reply:plan.summary,gaps:plan.gaps,at:now()}];
      await attach(updated);return publicEdit(await put('video_edits',updated));
    });
  }catch(error){
    await transaction(async()=>{const e=await get('video_edits',editId);if(e?.pending?.id===d.id){delete e.pending;await put('video_edits',e);}});
    throw error;
  }
}
export async function enqueueEditExport(editId:string,input:unknown){
  const d=z.object({revision:version}).parse(input);
  return transaction(async()=>{
    const e=required(await get('video_edits',editId));checkVersion(e,d.revision);
    if(!e.timeline.clips.length)throw new ApiError('请先添加镜头');
    const assets=await validateTimeline(e.timeline);
    const key=editId+'-'+d.revision, existing=await get('edit_exports',key);
    if(existing&&existing.status!=='failed' && (existing.status!=='completed'||existing.assetId&&await get('assets',existing.assetId)))return publicExport(existing);
    return publicExport(await put('edit_exports',{id:key,editId,projectId:e.projectId,title:e.title,revision:e.revision,timeline:e.timeline,cues:timelineCues(e.timeline,assets),status:'queued',lease:0}));
  });
}
