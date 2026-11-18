'use client';

import {useRef,useState} from 'react';
import {DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent} from '@dnd-kit/core';
import {SortableContext,useSortable,horizontalListSortingStrategy,arrayMove} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import {ArrowLeft, Download, Film, GripVertical, Plus, Redo2, Scissors, Trash2, Undo2, WandSparkles} from 'lucide-react';
import {clipCues,clipLength,editFps,editMaxFrames,frameLabel,frames,makeClip,removeInterval,timelineLength,type EditClip,type EditExport,type Timeline,type VideoEdit} from '@/shared/video-edit';
import type {Asset} from '@/shared/types';
import type {StudioMedia} from '@/shared/studio';
import {Dialog} from './ui';
import {EditPlayer,type PlayPosition} from './edit-player';
import './video-editor.css';

export async function editApi<T>(path:string,method:string,body:unknown):Promise<T> {
  const r=await fetch('/api/'+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const json=await r.json();if(!r.ok)throw new Error(json.error||'剪辑操作失败');return json;
}
export function editableVideo(a:Asset){return a.kind==='video'&&!!a.storageKey&&!!a.duration&&a.rights==='authorized'&&(!a.expiresAt||a.expiresAt>=new Date().toISOString().slice(0,10));}
export function VideoPicker({assets,close,choose,upload,busy,single=false}:{single?:boolean;assets:Asset[];close:()=>void;choose:(ids:string[])=>void;upload?:(files:File[])=>void;busy:boolean}){
  const [ids,setIds]=useState<string[]>([]);
  return <Dialog title="选择剪辑素材" subtitle={single?"选择一个视频替换当前镜头":"按选择顺序加入时间线"} close={()=>{if(!busy)close();}}><div className="cut-picker">
    {assets.filter(editableVideo).map(a=><button key={a.id} disabled={busy} aria-pressed={ids.includes(a.id)} onClick={()=>setIds(list=>list.includes(a.id)?list.filter(k=>k!==a.id):single?[a.id]:[...list,a.id])}>
      {a.thumbnailKey?<img alt="" src={'/api/files/'+a.id+'?thumb'}/>:<Film size={22}/>}<span>{a.name}<small>{a.duration?.toFixed(1)} 秒</small></span><b>{ids.includes(a.id)?ids.indexOf(a.id)+1:'＋'}</b></button>)}
    {!assets.some(editableVideo)&&<p>还没有已授权的视频素材。</p>}
    <footer>{upload&&<label className="cut-upload">上传自有视频<input type="file" multiple={!single} disabled={busy} accept=".mp4,.mov,.webm" onChange={e=>{if(e.target.files?.length)upload(Array.from(e.target.files));}}/></label>}
    <button className="cut-primary" disabled={!ids.length||busy} onClick={()=>choose(ids)}>{busy?'处理中…':single?'替换为所选镜头':'加入所选镜头'}</button></footer>
  </div></Dialog>;
}
function Shot({clip,asset,index,selected,disabled,select,trim,move}:{move:(delta:number)=>void;clip:EditClip;asset?:Asset;index:number;selected:boolean;disabled:boolean;select:()=>void;trim:(c:EditClip)=>void}){
  const sort=useSortable({id:clip.id,disabled});
  const [drag,setDrag]=useState<EditClip|null>(null);
  const dragRef=useRef<{side:'start'|'end';x:number;scale:number;value:EditClip}|null>(null);
  function edge(side:'start'|'end'){
    return <button className={'cut-edge '+side} aria-label={'拖动'+(side==='start'?'入点':'出点')} disabled={disabled}
      onPointerDown={e=>{select();e.currentTarget.setPointerCapture(e.pointerId);dragRef.current={side,x:e.clientX,scale:clipLength(clip)/Math.max(1,e.currentTarget.parentElement!.clientWidth),value:clip};}}
      onPointerMove={e=>{const d=dragRef.current;if(!d)return;const delta=Math.round((e.clientX-d.x)*d.scale);
        const value=side==='start'?Math.max(0,Math.min(clip.end-1,clip.start+delta)):Math.max(clip.start+1,Math.min(frames(asset?.duration||0),clip.end+delta));
        d.value={...clip,[side]:value};setDrag(d.value);}}
      onPointerCancel={()=>{dragRef.current=null;setDrag(null);}}
      onPointerUp={()=>{const d=dragRef.current;dragRef.current=null;setDrag(null);if(d&&d.value[side]!==clip[side])trim(d.value);}}/>;
  }
  return <div ref={sort.setNodeRef} style={{transform:CSS.Transform.toString(sort.transform),transition:sort.transition}} className={'cut-shot'+(selected?' selected':'')}>
    {edge('start')}<button className="cut-shot-main" onClick={select} aria-pressed={selected}>
    {asset?.thumbnailKey?<img src={'/api/files/'+asset.id+'?thumb'} alt=""/>:<Film size={25}/>}<strong>{index+1}. {asset?.name||'素材已移除'}</strong>
    <small>{drag?frameLabel(drag.start)+' – '+frameLabel(drag.end):frameLabel(clipLength(clip))}</small></button>
    <button ref={sort.setActivatorNodeRef} className="cut-grip" {...sort.attributes} {...sort.listeners} title="拖动或按左右方向键调整顺序" aria-description="按左右方向键调整顺序" onKeyDown={e=>{
      if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();move(e.key==='ArrowLeft'?-1:1);}
    }} aria-label={'拖排镜头 '+(index+1)} disabled={disabled}><GripVertical size={15}/></button>{edge('end')}
  </div>;
}

export function VideoEditor({edit,assets,media,jobs,refresh,back,openFile,upload}:{edit:VideoEdit;assets:Asset[];media:StudioMedia[];jobs:EditExport[];refresh:()=>Promise<unknown>;back:()=>void;openFile:(key:string)=>void;upload:(files:File[])=>Promise<Asset[]>}){
  const t=edit.timeline,total=timelineLength(t);
  const [selected,setSelected]=useState(''),[picker,setPicker]=useState<'add'|'replace'|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[prompt,setPrompt]=useState('');
  const lock=useRef(false),frame=useRef(0);
  const [seek,setSeek]=useState<PlayPosition>({frame:0,nonce:0}),[audition,setAudition]=useState<{timeline:Timeline;at:number;revision:number}|null>(null);
  const proposal=audition?.revision===edit.revision?audition:null;
  const sensors=useSensors(useSensor(PointerSensor,{activationConstraint:{distance:5}}));
  const clip=t.clips.find(c=>c.id===selected),asset=assets.find(a=>a.id===clip?.assetId);
  const offset=clip?t.clips.slice(0,t.clips.indexOf(clip)).reduce((n,c)=>n+clipLength(c),0):0;
  const latest=jobs.find(j=>j.editId===edit.id&&j.revision===edit.revision);
  const jump=(n:number,play=false)=>{frame.current=n;setSeek(s=>({frame:n,nonce:s.nonce+1,play}));};
  const select=(c:EditClip)=>{setAudition(null);setSelected(c.id);jump(t.clips.slice(0,t.clips.indexOf(c)).reduce((n,x)=>n+clipLength(x),0));};
  async function run(fn:()=>Promise<unknown>,done?:()=>void){
    if(lock.current)return;lock.current=true;setBusy(true);setMessage('');
    try{await fn();await refresh();done?.();}catch(e){setMessage(e instanceof Error?e.message:'操作失败');await refresh().catch(()=>{});}finally{lock.current=false;setBusy(false);}
  }
  const path='video-edits/'+edit.id;
  const save=(next:Timeline,done?:()=>void)=>run(()=>editApi(path,'PATCH',{action:'save',timeline:next,revision:edit.revision}),done);
  function patchClip(c:EditClip){void save({...t,clips:t.clips.map(x=>x.id===c.id?c:x)});}
  function move(from:number,to:number){
    if(from===to||from<0||to<0||to>=t.clips.length)return;
    void save({...t,clips:arrayMove(t.clips,from,to)});
  }
  function reorder({active,over}:DragEndEvent){
    if(over)move(t.clips.findIndex(c=>c.id===active.id),t.clips.findIndex(c=>c.id===over.id));
  }
  function auditionCut(from:number,to:number){
    if(!clip)return;const replacements=removeInterval(clip,frames(from),frames(to));
    const timeline={...t,clips:t.clips.flatMap(c=>c.id===clip.id?replacements:c)};
    const at=Math.max(0,Math.min(timelineLength(timeline),offset+Math.max(0,frames(from)-clip.start))-editFps);
    setAudition({timeline,at,revision:edit.revision});jump(at,true);
  }
  async function add(more:Asset[]){
    if(picker==='replace' && clip && more.length===1){
      const replacement={...clip,assetId:more[0].id,start:0,end:Math.min(clipLength(clip),frames(more[0].duration!))};
      await editApi(path,'PATCH',{action:'save',timeline:{...t,clips:t.clips.map(c=>c.id===clip.id?replacement:c)},revision:edit.revision});
      return;
    }
    const clips=[...t.clips];let room=editMaxFrames-total;
    for(const a of more){if(room<=0)throw new Error('时间线已达到 10 分钟，请先裁短镜头');const c=makeClip(a);c.end=Math.min(c.end,room);clips.push(c);room-=c.end;}
    await editApi(path,'PATCH',{action:'save',timeline:{...t,clips},revision:edit.revision});
  }
  function split(){if(!clip)return;const at=clip.start+frame.current-offset;
    if(at<=clip.start||at>=clip.end){setMessage('先将播放头移到所选镜头中间');return;}
    void save({...t,clips:t.clips.flatMap(c=>c.id===clip.id?[{...c,end:at},{...c,id:crypto.randomUUID(),start:at}]:c)});}
  const protectedUi=busy||!!proposal;
  return <section className="cut-editor">
    <header className="cut-heading"><button aria-label="返回我的资产" onClick={back}><ArrowLeft size={18}/></button><div><h1>{edit.title}</h1><small>{busy?'正在处理…':'已保存 · v'+edit.revision}</small></div>
      <div className="cut-actions"><button title="撤销" aria-label="撤销剪辑" disabled={!edit.canUndo||protectedUi} onClick={()=>void run(()=>editApi(path,'PATCH',{action:'undo',revision:edit.revision}))}><Undo2 size={16}/></button>
      <button title="重做" aria-label="重做剪辑" disabled={!edit.canRedo||protectedUi} onClick={()=>void run(()=>editApi(path,'PATCH',{action:'redo',revision:edit.revision}))}><Redo2 size={16}/></button>
      {latest?.status==='completed'&&latest.assetId?<button className="cut-primary" onClick={()=>openFile(latest.assetId!)}>查看成片</button>:<button className="cut-primary" disabled={protectedUi||!total||latest?.status==='queued'||latest?.status==='rendering'} onClick={()=>void run(()=>editApi(path+'/exports','POST',{revision:edit.revision}))}><Download size={15}/>{latest?.status==='failed'?'重试导出':latest?.status==='queued'||latest?.status==='rendering'?'正在导出…':'导出 MP4'}</button>}</div></header>
    {(message||latest?.error)&&<p role="alert" className="cut-notice">{message||latest?.error}</p>}
    <div className={'cut-layout'+(clip?' inspecting':'')}><EditPlayer timeline={proposal?.timeline||t} assets={assets} seek={seek} onFrame={n=>{frame.current=n;}}/>
    {clip&&asset&&<aside className="cut-inspector"><h2>镜头设置</h2><p>{asset.name}</p><fieldset disabled={protectedUi} key={clip.id+'-'+edit.revision}>
      {(['start','end'] as const).map(side=><label key={side}>{side==='start'?'入点（秒）':'出点（秒）'}<input type="number" step="0.01" min={0} max={asset.duration||0} defaultValue={Number((clip[side]/editFps).toFixed(2))}
      onBlur={e=>{const v=frames(e.target.valueAsNumber);if(!Number.isFinite(v)||v<0||v>frames(asset.duration!)||(side==='start'?v>=clip.end:v<=clip.start)){
        e.currentTarget.value=String(Number((clip[side]/editFps).toFixed(2)));setMessage('入点须早于出点，两个时间均须位于素材内');return;
      }if(v!==clip[side])patchClip({...clip,[side]:v});}} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}}/></label>)}
      <label>原声音量 <select value={clip.volume} onChange={e=>patchClip({...clip,volume:+e.target.value})}>{[...new Set([0,.25,.5,.75,1,clip.volume])].sort((a,b)=>a-b).map(v=><option key={v} value={v}>{Math.round(v*100)}%</option>)}</select></label>
      <div className="cut-buttons"><button onClick={split}><Scissors size={14}/>从播放头分割</button><button onClick={()=>setPicker('replace')}>替换镜头</button><button aria-label="移除镜头" onClick={()=>void save({...t,clips:t.clips.filter(c=>c.id!==clip.id)})}><Trash2 size={15}/></button></div>
    </fieldset><details className="cut-transcript"><summary>按逐字稿剪辑</summary>
      {!clipCues(asset,clip).length&&<p>这段镜头没有带时间码的台词。</p>}
      {!asset.segments.some(s=>s.start!==null && s.end!==null)&&<label className="cut-import"> {asset.segments.length?'用 SRT 替换原片逐字稿':'导入原片 SRT'}<input type="file" accept=".srt" disabled={protectedUi} onChange={e=>{
        const file=e.currentTarget.files?.[0];e.currentTarget.value='';if(!file)return;
        void run(async()=>{if(file.size>400000)throw new Error('字幕文件过大');const transcript=await file.text();
          if(!/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(transcript))throw new Error('请选择带有时间码的 SRT 字幕');
          await editApi('assets/'+asset.id,'PATCH',{transcript});});
      }}/></label>}
      {clipCues(asset,clip).map((s,i)=><div key={i}><small>{frameLabel(frames(s.start!))} – {frameLabel(frames(s.end!))}</small><p>{s.text}</p>
        <button disabled={protectedUi} onClick={()=>auditionCut(s.start!,s.end!)}>试听删去这句</button>
        {!!s.words?.length&&<details><summary>按词选择</summary>{s.words.map((w,j)=><button disabled={protectedUi} key={j} onClick={()=>auditionCut(w.start,w.end)}>{w.text}{w.punctuation}</button>)}</details>}</div>)}
    </details></aside>}</div>
    {proposal&&<div className="cut-audition">正在试听删减后的衔接 <button onClick={()=>void save(proposal.timeline,()=>{setAudition(null);jump(proposal.at);})} disabled={busy}>应用删减</button><button disabled={busy} onClick={()=>{setAudition(null);jump(offset);}}>取消试听</button></div>}
    <section className="cut-track"><header><h2>镜头时间线</h2><small>{t.clips.length} 个镜头 · {frameLabel(total)}</small><button disabled={protectedUi} onClick={()=>setPicker('add')}><Plus size={15}/>加入素材</button></header>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}><SortableContext items={t.clips.map(c=>c.id)} strategy={horizontalListSortingStrategy}>
        <div className="cut-strip">{t.clips.map((c,i)=><Shot key={c.id} clip={c} index={i} asset={assets.find(a=>a.id===c.assetId)} selected={c.id===selected} disabled={protectedUi} select={()=>select(c)} move={delta=>move(i,i+delta)} trim={patchClip}/>)}</div>
      </SortableContext></DndContext>
      <fieldset disabled={protectedUi} className="cut-options"><label>画幅<select value={t.aspect} onChange={e=>void save({...t,aspect:e.target.value as Timeline['aspect']})}><option value="landscape">横屏 16:9</option><option value="portrait">竖屏 9:16</option><option value="square">方形 1:1</option></select></label>
      <label>跨镜头配音<select value={t.voiceId} onChange={e=>void save({...t,voiceId:e.target.value})}><option value="">无</option>{media.filter(m=>m.kind==='配音').map(m=><option key={m.id} value={'m:'+m.id}>{m.title}</option>)}{assets.filter(a=>a.kind==='audio'&&a.rights==='authorized'&&a.storageKey).map(a=><option key={a.id} value={'a:'+a.id}>{a.name}</option>)}</select></label>
      <label><input type="checkbox" checked={t.captions} onChange={e=>void save({...t,captions:e.target.checked})}/>原片字幕</label></fieldset></section>
    <form className="cut-command" onSubmit={e=>{e.preventDefault();if(prompt.trim())void run(()=>editApi(path+'/plan','POST',{id:crypto.randomUUID(),revision:edit.revision,prompt}),()=>setPrompt(''));}}><WandSparkles size={16}/>
      <input aria-label="剪辑调整要求" placeholder="告诉我想怎么剪，例如「第二个镜头缩短两秒」" value={prompt} onChange={e=>setPrompt(e.target.value)}/><button disabled={protectedUi||!prompt.trim()||!total}>调整剪辑</button></form>
    {edit.messages.at(-1)&&<p className="cut-note">{edit.messages.at(-1)!.reply} {edit.messages.at(-1)!.gaps.join(' ')}</p>}
    {picker&&<VideoPicker single={picker==='replace'} assets={assets} busy={busy} close={()=>setPicker(null)} choose={ids=>void run(()=>add(ids.map(k=>assets.find(a=>a.id===k)!)),()=>setPicker(null))} upload={files=>void run(async()=>add(await upload(files)),()=>setPicker(null))}/>}
  </section>;
}
