import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { get, id, now, put, query, transaction, dataDir } from './db';
import { inspect, uploadDir } from './media';
import { editSource, validateTimeline, voiceFile, type StoredExport } from './video-edits';
import { editFps, editSizes, timelineCues, timelineLength } from '../shared/video-edit';
import { narrationAss } from '../shared/narration-captions';
import type { Asset } from '../shared/types';
import { ApiError } from './errors';

const exec=promisify(execFile);
const cached=new Map<string,Promise<void>>();
function mediaPath(key:string){if(!key || basename(key)!==key)throw new ApiError('媒体文件无效');return join(uploadDir,key);}
async function ffmpeg(args:string[],cwd:string,signal?:AbortSignal){
  await exec('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-y',...args],{cwd,signal,timeout:600000,maxBuffer:512000});
}
export async function editSourceMetadata(key: string) {
  const source = await editSource(key);
  const {width, height} = await inspect(mediaPath(source.storageKey));
  return {width, height};
}
export async function editPreviewResponse(key:string,req:Request){
  const a=await editSource(key),dir=join(dataDir,'edit-previews');
  const cacheKey=createHash('sha256').update(a.storageKey).digest('hex');
  const output=join(dir,cacheKey+'.mp4');
  if(!await stat(output).catch(()=>null)){
    if(!cached.has(cacheKey)){
      if(cached.size>=3)throw new ApiError('其他镜头正在准备预览，请稍后重试',503);
      const work=async()=>{
        await mkdir(dir,{recursive:true});
        const temp=join(dir,id()+'.mp4');
        try{await ffmpeg(['-i',mediaPath(a.storageKey),'-map','0:v:0','-map','0:a:0?','-vf','fps=30,scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1','-c:v','libx264','-threads','2','-preset','ultrafast','-crf','27','-pix_fmt','yuv420p','-g','30','-c:a','aac','-movflags','+faststart',temp],dir);await rename(temp,output);}
        finally{await rm(temp,{force:true});}
      };
      cached.set(cacheKey,work().finally(()=>cached.delete(cacheKey)));
    }
    try{await cached.get(cacheKey);}catch{throw new ApiError('无法准备视频预览，请检查视频编码后重试',422);}
  }
  await editSource(key);
  const size=(await stat(output)).size,range=req.headers.get('range');
  let start=0,end=size-1;
  const headers=new Headers({'Content-Type':'video/mp4','Accept-Ranges':'bytes','Cache-Control':'private, no-store'});
  if(range){
    const m=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(m){start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2]));end=m[1]&&m[2]?Math.min(end,Number(m[2])):end;}
    if(!m||(!m[1]&&!m[2])||!Number.isSafeInteger(start)||start>end)return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+size}});
    headers.set('Content-Range',`bytes ${start}-${end}/${size}`);
  }
  headers.set('Content-Length',String(end-start+1));
  return new Response(Readable.toWeb(createReadStream(output,{start,end,signal:req.signal})) as ReadableStream<Uint8Array>,{status:range?206:200,headers});
}

async function render(job:StoredExport,signal:AbortSignal) {
  const t=job.timeline,assets=await validateTimeline(t),[w,h]=editSizes[t.aspect];
  await mkdir(uploadDir,{recursive:true});
  const dir=await mkdtemp(join(uploadDir,'edit-')),assetId=id(),storageKey=assetId+'.mp4',thumbnailKey=assetId+'.jpg';
  let retained=false;
  try{
    const files:string[]=[];
    for(const [i,c] of t.clips.entries()){
      const source=assets.find(a=>a.id===c.assetId)!,file=i+'.mkv';
      const frameCount=c.end-c.start,seconds=frameCount/editFps,samples=frameCount*(48000/editFps);
      const audio=source.hasAudio ?? (await inspect(mediaPath(source.storageKey))).audio;
      const inputs=['-i',mediaPath(source.storageKey)];
      if(!audio)inputs.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');
      const videoFilter=`fps=30,trim=start_frame=${c.start}:end_frame=${c.end},setpts=PTS-STARTPTS,scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${frameCount}`;
      const audioFilter=(audio?`atrim=start=${c.start/editFps}:end=${c.end/editFps},`:'')+`asetpts=PTS-STARTPTS,aresample=48000,volume=${c.volume},apad,atrim=end_sample=${samples},asetpts=N/SR/TB`;
      await ffmpeg([...inputs,'-map','0:v:0','-map',audio?'0:a:0':'1:a:0','-vf',videoFilter,'-af',audioFilter,'-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-preset','veryfast','-crf','20','-c:a','pcm_s16le','-ar','48000','-ac','2',file],dir,signal);
      files.push("file '"+file+"'\nduration "+seconds.toFixed(9));
    }
    await writeFile(join(dir,'clips.txt'),files.join('\n'));
    const args=['-f','concat','-safe','1','-i','clips.txt'];
    const outputSeconds=timelineLength(t)/editFps;
    const outputSamples=timelineLength(t)*(48000/editFps);
    const continuousAudio='aresample=48000:async=1:first_pts=0,apad,atrim=end_sample='+outputSamples+',asetpts=N/SR/TB';
    if(t.voiceId){
      const voice=await voiceFile(t.voiceId);
      args.push('-i',mediaPath(voice.storageKey),'-filter_complex','[0:a]'+continuousAudio+'[base];[base][1:a]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:latency=1[a]','-map','0:v:0','-map','[a]');
    }else args.push('-map','0:v:0','-map','0:a:0','-af',continuousAudio);
    const cues=job.cues??timelineCues(t,assets);
    if(t.captions&&cues.length){
      await writeFile(join(dir,'captions.ass'),narrationAss(cues.map(s=>({start:s.start!,end:s.end!,zh:s.text,en:''})),w,h,false,'zh'));
      args.push('-vf','ass=captions.ass','-c:v','libx264','-threads','2','-preset','veryfast','-crf','20');
    }else args.push('-c:v','copy');
    await ffmpeg([...args,'-c:a','aac','-ar','48000','-t',String(outputSeconds),'-movflags','+faststart',mediaPath(storageKey)],dir,signal);
    await ffmpeg(['-i',mediaPath(storageKey),'-frames:v','1','-vf','scale=320:-2',mediaPath(thumbnailKey)],dir,signal);
    const info=await inspect(mediaPath(storageKey));
    const durations=[info.videoDuration,info.audioDuration,info.duration];
    if(durations.some(d=>d===null||Math.abs(d-outputSeconds)>0.06))throw new ApiError('成片画面或音轨的时长与时间线不一致');
    const size=(await stat(mediaPath(storageKey))).size;
    await transaction(async()=>{
      const latest=await get('edit_exports',job.id);if(!latest||latest.owner!==job.owner)throw new ApiError('导出任务已被接管',409);
      const current=await validateTimeline(t);
      if(t.voiceId.startsWith('a:'))current.push(await editSource(t.voiceId.slice(2),'audio'));
      const asset:Asset={id:assetId,projectId:job.projectId,name:job.title+' · v'+job.revision+'.mp4',kind:'video',mime:'video/mp4',size,storageKey,thumbnailKey,
        duration:info.duration,hasAudio:true,tags:['剪辑成片'],segments:cues,transcriptSource:cues.length?'manual':'none',rights:'authorized',expiresAt:current.map(a=>a.expiresAt).filter(Boolean).sort()[0]||'',
        note:'剪辑草稿 '+job.editId+' · 第 '+job.revision+' 版',error:null,createdAt:now()};
      await put('assets',asset);await put('edit_exports',{...latest,status:'completed',assetId,owner:undefined,lease:0});
    });retained=true;
  }finally{await rm(dir,{recursive:true,force:true});if(!retained)await Promise.all([storageKey,thumbnailKey].map(k=>rm(mediaPath(k),{force:true})));}
}
export async function processEditExport(signal:AbortSignal) {
  const due=await query<{id:string}>("SELECT id FROM edit_exports WHERE data->>'status'='queued' OR (data->>'status'='rendering' AND CAST(data->>'lease' AS BIGINT)<$1) ORDER BY id LIMIT 1",[Date.now()]);
  if(!due.rows.length)return;
  const job=await transaction(async()=>{
    const j=await get('edit_exports',due.rows[0].id);
    if(!j||!(j.status==='queued'||j.status==='rendering'&&j.lease<Date.now()))return;
    return put('edit_exports',{...j,status:'rendering',owner:id(),lease:Date.now()+45000});
  });
  if(!job)return;
  const control=new AbortController();
  const heartbeat=setInterval(()=>{void transaction(async()=>{const j=await get('edit_exports',job.id);
    if(!j||j.owner!==job.owner){control.abort();return;}await put('edit_exports',{...j,lease:Date.now()+45000});}).catch(()=>control.abort());},12000);
  try{await render(job,AbortSignal.any([signal,control.signal]));}
  catch(e){await transaction(async()=>{const j=await get('edit_exports',job.id);if(j&&j.owner===job.owner)await put('edit_exports',{...j,status:signal.aborted?'queued':'failed',owner:undefined,lease:0,error:e instanceof ApiError?e.message:'视频导出失败，请检查素材或重试'});});}
  finally{clearInterval(heartbeat);}
}
