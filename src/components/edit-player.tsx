'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, RefreshCw, Maximize, Minimize, Volume2, VolumeX } from 'lucide-react';
import { clipLength, editFps, editSizes, editTimecode, timelineLength, timelineCues, type Timeline } from '@/shared/video-edit';
import type { Asset } from '@/shared/types';

export interface PlayPosition { frame:number; nonce:number; play?:boolean }
export function EditPlayer({timeline,assets,seek,onFrame}:{timeline:Timeline;assets:Asset[];seek?:PlayPosition;onFrame?:(n:number)=>void}){
  const player=useRef<HTMLDivElement>(null);
  const [muted,setMuted]=useState(false),[fullscreen,setFullscreen]=useState(false);
  useEffect(()=>{
    const onChange=()=>setFullscreen(document.fullscreenElement===player.current);
    document.addEventListener('fullscreenchange',onChange);
    return ()=>document.removeEventListener('fullscreenchange',onChange);
  },[]);
  async function toggleFullscreen(){
    try{
      if(document.fullscreenElement===player.current)await document.exitFullscreen();
      else if(player.current?.requestFullscreen)await player.current.requestFullscreen();
      else (video.current as (HTMLVideoElement & {webkitEnterFullscreen?:()=>void})|null)?.webkitEnterFullscreen?.();
    }catch{ setError('暂时无法进入全屏'); }
  }
  const total=timelineLength(timeline);
  const transportKey=useMemo(()=>JSON.stringify(timeline),[timeline]);
  const cues=useMemo(()=>timeline.captions?timelineCues(timeline,assets):[],[timeline,assets]);
  const [position,setPosition]=useState(0),[playing,setPlaying]=useState(false),[serial,setSerial]=useState(0),[error,setError]=useState('');
  const video=useRef<HTMLVideoElement>(null), voice=useRef<HTMLAudioElement>(null),destination=useRef(0),wantsPlay=useRef(false);
  const frame=Math.max(0,Math.min(total,position));
  let offset=0,index=0;
  while(index<timeline.clips.length-1&&frame>=offset+clipLength(timeline.clips[index])){offset+=clipLength(timeline.clips[index]);index++;}
  const clip=timeline.clips[index];
  const [width,height]=editSizes[timeline.aspect];
  const source=assets.find(a=>a.id===clip?.assetId);
  function jump(target:number,play=wantsPlay.current){
    const bounded=Math.max(0,Math.min(target,total));destination.current=bounded;
    video.current?.pause();voice.current?.pause();wantsPlay.current=play&&bounded<total;
    setPosition(bounded);setPlaying(wantsPlay.current);setSerial(n=>n+1);onFrame?.(bounded);
  }
  useEffect(()=>{jump(seek?.frame||0,!!seek?.play);},[transportKey,seek?.nonce]); // A new document or explicit seek replaces the transport position.
  useEffect(()=>{
    const el=video.current;
    if(!el||!clip)return;
    let cancelled=false,raf=0;
    const audio=voice.current;
    const fail=()=>{if(cancelled)return;wantsPlay.current=false;setPlaying(false);el.pause();audio?.pause();setError('预览暂不可用');};
    const pauseAudio=()=>audio?.pause();
    function syncAudio(){
      if(!audio||!el||!clip||!wantsPlay.current||el.paused||el.seeking||el.readyState<3)return;
      const time=(offset-clip.start)/editFps+el.currentTime;
      if(audio.readyState<1||time>=audio.duration)return;
      if(Math.abs(audio.currentTime-time)>.12)audio.currentTime=Math.max(0,time);
      if(audio.paused)void audio.play().catch(fail);
    }
    function tick(){
      if(cancelled||!el||!clip)return;
      if(!el.seeking&&!el.paused&&wantsPlay.current){
        const local=Math.round(el.currentTime*editFps);
        if(local>=clip.end){advance();return;}
        const n=offset+Math.max(0,local-clip.start);setPosition(n);onFrame?.(n);syncAudio();
      }
      raf=requestAnimationFrame(tick);
    }
    function advance(){if(!cancelled&&wantsPlay.current&&clip)jump(offset+clipLength(clip));}
    const ready=()=>{
      if(cancelled)return;setError('');
      const at=Math.max(clip.start,Math.min(clip.end-1,clip.start+destination.current-offset))/editFps;
      el.currentTime=at;el.volume=clip.volume;
      if(wantsPlay.current)void el.play().catch(e=>{if(e.name!=='AbortError')fail();});
    };
    el.addEventListener('loadedmetadata',ready);el.addEventListener('ended',advance);el.addEventListener('error',fail);
    el.addEventListener('waiting',pauseAudio);el.addEventListener('playing',syncAudio);
    if(el.readyState>=1)ready();else if(el.error)el.load();
    raf=requestAnimationFrame(tick);
    return()=>{cancelled=true;cancelAnimationFrame(raf);el.pause();audio?.pause();el.removeEventListener('loadedmetadata',ready);el.removeEventListener('ended',advance);el.removeEventListener('error',fail);el.removeEventListener('waiting',pauseAudio);el.removeEventListener('playing',syncAudio);};
  },[clip?.id,clip?.assetId,offset,serial]);
  const caption=cues.find(s=>s.start!<=frame/editFps&&s.end!>frame/editFps);
  const voiceUrl=timeline.voiceId.startsWith('m:')?'/api/dubbing-files/'+timeline.voiceId.slice(2):timeline.voiceId?'/api/files/'+timeline.voiceId.slice(2):undefined;
  return <div ref={player} className="cut-player">
    <div className="cut-screen"><div className={'cut-picture '+timeline.aspect} style={{aspectRatio:width+'/'+height}}>
      {clip?<video muted={muted} key={clip.assetId} ref={video} playsInline preload="auto" src={'/api/edit-previews/'+clip.assetId} poster={source?.thumbnailKey?'/api/files/'+source.id+'?thumb':undefined}/>:<span>选择视频开始剪辑</span>}
      {caption&&<span className="cut-caption">{caption.text}</span>}
    </div>{error&&<button className="cut-retry" onClick={()=>jump(frame,true)}><RefreshCw size={15}/>{error} · 重试</button>}</div>
    {voiceUrl&&<audio muted={muted} ref={voice} src={voiceUrl} preload="auto" onError={()=>{setError('配音加载失败');wantsPlay.current=false;setPlaying(false);video.current?.pause();}}/>}
    <div className="cut-transport"><button disabled={!clip} aria-label={playing?'暂停剪辑预览':'播放剪辑预览'} onClick={()=>jump(frame>=total?0:frame,!playing)}>{playing?<Pause size={17}/>:<Play size={17}/>}</button>
      <time>{editTimecode(frame)} <span>/ {editTimecode(total)}</span></time><input className="cut-range" style={{backgroundSize:(total?frame*100/total:0)+'% 100%'}} type="range" aria-label="成片播放位置" min={0} max={total||1} value={frame} disabled={!total} onChange={e=>jump(+e.target.value,false)}/>
      <button aria-label={muted?'取消预览静音':'预览静音'} aria-pressed={muted} onClick={()=>setMuted(v=>!v)}>{muted?<VolumeX size={18}/>:<Volume2 size={18}/>}</button>
      <button aria-label={fullscreen?'退出全屏':'全屏预览'} onClick={()=>void toggleFullscreen()}>{fullscreen?<Minimize size={17}/>:<Maximize size={17}/>}</button></div>
  </div>;
}
