'use client';
import {useState} from 'react';
import {Film, Play} from 'lucide-react';
import type {VideoEdit} from '@/shared/video-edit';
import {frameLabel,timelineLength} from '@/shared/video-edit';
import type {Asset} from '@/shared/types';
import {EditPlayer} from './edit-player';
export function EditCard({edit,assets,open}:{edit:VideoEdit;assets:Asset[];open:()=>void}){
  const [preview,setPreview]=useState(false);
  return <article className="studio-document"><div className="doc-kicker"><span><Film size={15}/>剪辑草稿</span><span>已存入资产 · v{edit.revision}</span></div>
    <h3>{edit.title}</h3><p>{edit.timeline.clips.length} 个镜头 · {frameLabel(timelineLength(edit.timeline))}</p>
    {preview&&<EditPlayer assets={assets} timeline={edit.timeline} seek={{frame:0,nonce:0,play:true}}/>}
    <div className="doc-actions"><button onClick={open}>打开剪辑器</button>{!!edit.timeline.clips.length&&<button onClick={()=>setPreview(!preview)}><Play size={14}/>{preview?'收起预览':'播放粗剪'}</button>}</div></article>;
}
