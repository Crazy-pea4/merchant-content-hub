'use client';

import {useEffect,useRef,useState} from 'react';
import {DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent} from '@dnd-kit/core';
import {SortableContext,useSortable,horizontalListSortingStrategy,arrayMove} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import { Captions, Check, ChevronDown, Ellipsis, FileVideo, Film, FolderOpen, GripVertical, ListVideo, Menu,
  Mic, Plus, RectangleHorizontal, Redo2, Replace, Scissors, Trash2, Undo2, Upload, Volume2, WandSparkles } from 'lucide-react';
import {DropdownMenu} from 'radix-ui';
import {clipCues,clipLength,editFps,editMaxFrames,editTimecode,frameLabel,frames,makeClip,removeInterval,timelineLength,type EditClip,type EditExport,type Timeline,type VideoEdit} from '@/shared/video-edit';
import type {Asset} from '@/shared/types';
import type {StudioMedia} from '@/shared/studio';
import {Dialog, formatSize} from './ui';
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
const aspectNames = {landscape:'16:9',portrait:'9:16',square:'1:1'} as const;
const machineFilename = /^(?:[a-f\d-]{20,}|\d{14,})(?:\.\w+)?$/i;
function shotName(asset:Asset|undefined,clip:EditClip,index:number) {
  if(!asset)return '素材已移除';
  if(!machineFilename.test(asset.name))return asset.name.replace(/\.[^.]+$/,'');
  const cue=clipCues(asset,clip)[0]?.text || asset.segments.find(s=>s.text)?.text;
  return cue?.split(/[，。！？；]/).find(Boolean)?.slice(0,24) || '镜头 '+String(index+1).padStart(2,'0');
}
function editName(edit:VideoEdit,sessionTitle:string,assets:Asset[]) {
  const name=edit.title.replace(/^视频剪辑\s*·\s*/,'');
  if(!machineFilename.test(name))return name;
  if(sessionTitle && !['视频剪辑','新创作'].includes(sessionTitle))return sessionTitle;
  const first=edit.timeline.clips[0];
  return first?shotName(assets.find(a=>a.id===first.assetId),first,0):'剪辑草稿';
}

function SourceInfo({asset}:{asset:Asset}){
  const [dimensions,setDimensions]=useState('');
  useEffect(()=>{
    const controller=new AbortController();
    fetch('/api/edit-previews/'+asset.id+'/metadata',{signal:controller.signal})
      .then(async r=>r.ok?await r.json():null).then(d=>{
        if(d?.width && d?.height && !controller.signal.aborted)setDimensions(d.width+' × '+d.height);
      }).catch(()=>{});
    return ()=>controller.abort();
  },[asset.id]);
  const filename=machineFilename.test(asset.name)?asset.name.slice(0,8)+'…'+asset.name.slice(-8):asset.name;
  return <div className="cut-source">
    <span className="cut-source-thumb">{asset.thumbnailKey?<img src={'/api/files/'+asset.id+'?thumb'} alt=""/>:<FileVideo size={26}/>}</span>
    <div><strong title={asset.name}>{filename}</strong><p><span>时长 {editTimecode(frames(asset.duration||0))}</span><i/>{dimensions||formatSize(asset.size)}</p></div>
  </div>;
}
function TrimPoint({label,frame,accept}:{label:string;frame:number;accept:(v:number)=>boolean}){
  const display=editTimecode(frame);
  function commit(input:HTMLInputElement) {
    const match=/^(?:(\d+):)?(\d+(?:[.]\d+)?)$/.exec(input.value.trim());
    const value=match?frames(Number(match[1]||0)*60+Number(match[2])):NaN;
    input.value=Number.isFinite(value)&&accept(value)?editTimecode(value):display;
  }
  return <label className="cut-time-field"><span>源文件{label}</span>
    <input aria-label={label+'（秒）'} type="text" inputMode="decimal" defaultValue={display} title="分钟:秒.百分秒，或直接输入秒数"
      onBlur={e=>commit(e.currentTarget)} onKeyDown={e=>{
        if(e.key==='Enter')e.currentTarget.blur();
        else if(e.key==='Escape'){e.currentTarget.value=display;e.currentTarget.blur();}
        else if(e.key==='ArrowUp'||e.key==='ArrowDown'){
          e.preventDefault();const value=frame+(e.key==='ArrowUp'?1:-1);if(accept(value))e.currentTarget.value=editTimecode(value);
        }
      }}/>
  </label>;
}
function Gain({clip,change}:{clip:EditClip;change:(gain:number)=>Promise<unknown>}){
  const [draft,setDraft]=useState<number|null>(null);
  const value=draft??Math.round(clip.volume*100);
  const pending=useRef(false);
  async function commit(input:HTMLInputElement){
    if(pending.current)return;
    const gain=Number(input.value)/100;
    if(gain===clip.volume){setDraft(null);return;}
    pending.current=true;
    try{await change(gain);}finally{pending.current=false;setDraft(null);}
  }
  return <label className="cut-gain"><span>原始音量</span><Volume2 size={18}/>
    <input type="range" aria-label="原声音量" className="cut-range" min={0} max={100} value={value}
      aria-valuetext={value+'%'} style={{backgroundSize:value+'% 100%'}} onChange={e=>setDraft(+e.target.value)}
      onPointerUp={e=>void commit(e.currentTarget)} onKeyUp={e=>void commit(e.currentTarget)} onBlur={e=>void commit(e.currentTarget)}/>
    <output>{value}%</output>
  </label>;
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
    {asset?.thumbnailKey?<img src={'/api/files/'+asset.id+'?thumb'} alt=""/>:<Film size={25}/>}<span className="cut-shot-caption"><b>{String(index+1).padStart(2,'0')}</b><strong title={asset?.name}>{shotName(asset,clip,index)}</strong>
    <time>{drag?editTimecode(drag[dragRef.current?.side||'end']):editTimecode(clipLength(clip))}</time></span></button>
    <button ref={sort.setActivatorNodeRef} className="cut-grip" {...sort.attributes} {...sort.listeners} title="拖动或按左右方向键调整顺序" aria-description="按左右方向键调整顺序" onKeyDown={e=>{
      if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();move(e.key==='ArrowLeft'?-1:1);}
    }} aria-label={'拖排镜头 '+(index+1)} disabled={disabled}><GripVertical size={15}/></button>{edge('end')}
  </div>;
}

export function VideoEditor({edit,sessionTitle,siblings,openEdit,openNavigation,assets,media,jobs,refresh,back,openFile,upload}:{sessionTitle:string;siblings:VideoEdit[];openEdit:(id:string)=>void;openNavigation:()=>void;edit:VideoEdit;assets:Asset[];media:StudioMedia[];jobs:EditExport[];refresh:()=>Promise<unknown>;back:()=>void;openFile:(key:string)=>void;upload:(files:File[])=>Promise<Asset[]>}){
  const t=edit.timeline,total=timelineLength(t);
  const [selected,setSelected]=useState(''),[picker,setPicker]=useState<'add'|'replace'|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[prompt,setPrompt]=useState('');
  const lock=useRef(false),frame=useRef(0);
  const [seek,setSeek]=useState<PlayPosition>({frame:0,nonce:0}),[audition,setAudition]=useState<{timeline:Timeline;at:number;revision:number}|null>(null);
  const proposal=audition?.revision===edit.revision?audition:null;
  const sensors=useSensors(useSensor(PointerSensor,{activationConstraint:{distance:5}}));
  const clip=t.clips.find(c=>c.id===selected)??t.clips[0],asset=assets.find(a=>a.id===clip?.assetId);
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
  function patchClip(c:EditClip){return save({...t,clips:t.clips.map(x=>x.id===c.id?c:x)});}
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
    <header className="cut-heading">
      <button className="cut-mobile-nav" aria-label="打开导航" onClick={openNavigation}><Menu size={20}/></button>
      <div className="cut-location"><h1>视频剪辑</h1><i>/</i>
        <DropdownMenu.Root><DropdownMenu.Trigger className="cut-draft-name" title={edit.title}>
          <span>{editName(edit,sessionTitle,assets)}</span><ChevronDown size={15}/>
        </DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content align="start" sideOffset={8} className="cut-menu">
          {siblings.map(other=><DropdownMenu.Item key={other.id} onSelect={()=>openEdit(other.id)}><FileVideo size={15}/>
            <span>{editName(other,sessionTitle,assets)}</span>{other.id===edit.id&&<Check size={14}/>}
          </DropdownMenu.Item>)}<DropdownMenu.Separator/><DropdownMenu.Item onSelect={back}><FolderOpen size={15}/>返回我的资产</DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
      </div>
      <div className="cut-actions" role="group" aria-label="剪辑工具">
        <div className="cut-tool-group"><button title="撤销" aria-label="撤销剪辑" disabled={!edit.canUndo||protectedUi} onClick={()=>void run(()=>editApi(path,'PATCH',{action:'undo',revision:edit.revision}))}><Undo2/></button>
          <button title="重做" aria-label="重做剪辑" disabled={!edit.canRedo||protectedUi} onClick={()=>void run(()=>editApi(path,'PATCH',{action:'redo',revision:edit.revision}))}><Redo2/></button></div>
        <button title="从播放头分割" aria-label="从播放头分割" disabled={!clip||protectedUi} onClick={split}><Scissors/><span>分割</span></button>
        <label className="cut-tool-select" title="选择成片画幅"><RectangleHorizontal/><span>画幅</span> {aspectNames[t.aspect]}<ChevronDown className="cut-chevron"/>
          <select aria-label="画幅" disabled={protectedUi} value={t.aspect} onChange={e=>void save({...t,aspect:e.target.value as Timeline['aspect']})}>
            <option value="landscape">横屏 16:9</option><option value="portrait">竖屏 9:16</option><option value="square">方形 1:1</option></select>
        </label>
        <label className={'cut-tool-select'+(t.voiceId?' active':'')} title="跨镜头配音"><Mic/><span>配音</span>
          <select aria-label="跨镜头配音" disabled={protectedUi} value={t.voiceId} onChange={e=>void save({...t,voiceId:e.target.value})}>
            <option value="">无配音</option>{media.filter(m=>m.kind==='配音').map(m=><option key={m.id} value={'m:'+m.id}>{m.title}</option>)}
            {assets.filter(a=>a.kind==='audio'&&a.rights==='authorized'&&a.storageKey).map(a=><option key={a.id} value={'a:'+a.id}>{a.name}</option>)}
          </select></label>
        <label className={'cut-tool-select'+(t.captions?' active':'')} title="烧录原片字幕"><Captions/><span>字幕</span>
          <input type="checkbox" aria-label="原片字幕" disabled={protectedUi} checked={t.captions} onChange={e=>void save({...t,captions:e.target.checked})}/></label>
        {latest?.status==='completed'&&latest.assetId?<button className="cut-primary" onClick={()=>openFile(latest.assetId!)}>查看成片</button>:<button className="cut-primary" disabled={protectedUi||!total||latest?.status==='queued'||latest?.status==='rendering'} onClick={()=>void run(()=>editApi(path+'/exports','POST',{revision:edit.revision}))}><Upload/>{latest?.status==='failed'?'重试导出':latest?.status==='queued'||latest?.status==='rendering'?'正在导出…':'导出 MP4'}</button>}
      </div>
    </header>
    <div className="cut-workspace">
    {(message||latest?.error)&&<p role="alert" className="cut-notice">{message||latest?.error}</p>}
    <div className="cut-layout"><EditPlayer timeline={proposal?.timeline||t} assets={assets} seek={seek} onFrame={n=>{frame.current=n;}}/>
    <aside className="cut-inspector"><div className="cut-inspector-body">
      <header><h2>镜头设置</h2>{clip&&<DropdownMenu.Root><DropdownMenu.Trigger className="cut-more" aria-label="更多镜头操作" disabled={protectedUi}><Ellipsis size={18}/></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content className="cut-menu" align="end" sideOffset={5}>
          <DropdownMenu.Item onSelect={()=>setPicker('replace')}><Replace size={15}/>替换镜头</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={()=>void save({...t,clips:t.clips.filter(c=>c.id!==clip.id)})}><Trash2 size={15}/>移除镜头</DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}</header>
      {clip&&asset?<><SourceInfo key={asset.id} asset={asset}/>
      <fieldset disabled={protectedUi} key={clip.id+'-'+edit.revision} className="cut-fields"><div className="cut-times">
        {(['start','end'] as const).map(side=><TrimPoint key={side} label={side==='start'?'入点':'出点'} frame={clip[side]} accept={v=>{
          if(v<0||v>frames(asset.duration!)||(side==='start'?v>=clip.end:v<=clip.start)){setMessage('入点须早于出点，两个时间均须位于素材内');return false;}
          if(v!==clip[side])void patchClip({...clip,[side]:v});return true;
        }}/>)}</div>
        <Gain clip={clip} change={volume=>patchClip({...clip,volume})}/>
      </fieldset><details className="cut-transcript"><summary><span>逐字稿</span><ChevronDown size={16}/></summary>
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
    </details></>:<p className="cut-no-source">{clip?'原片已移除，可替换这个镜头。':'加入视频即可设置镜头。'}</p>}
    </div></aside></div>
    {proposal&&<div className="cut-audition">正在试听删减后的衔接 <button onClick={()=>void save(proposal.timeline,()=>{setAudition(null);jump(proposal.at);})} disabled={busy}>应用删减</button><button disabled={busy} onClick={()=>{setAudition(null);jump(offset);}}>取消试听</button></div>}
    <section className="cut-track" aria-label="镜头时间线">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}><SortableContext items={t.clips.map(c=>c.id)} strategy={horizontalListSortingStrategy}>
        <div className="cut-strip">{t.clips.map((c,i)=><Shot key={c.id} clip={c} index={i} asset={assets.find(a=>a.id===c.assetId)} selected={c.id===clip?.id} disabled={protectedUi} select={()=>select(c)} move={delta=>move(i,i+delta)} trim={patchClip}/>)}
          <button className="cut-add" disabled={protectedUi} onClick={()=>setPicker('add')}><Plus size={20}/>加入素材</button></div>
      </SortableContext></DndContext>
      <footer><span><ListVideo size={15}/> {t.clips.length} 个镜头</span><i/> <time>{editTimecode(total)}</time>
      <small className="cut-save" role="status">{busy?'正在处理…':'已保存 · v'+edit.revision}</small></footer>
    </section>
    <details className="cut-assistant"><summary><WandSparkles size={16}/><span>AI 调整剪辑</span><ChevronDown size={15}/></summary>
      <form className="cut-command" onSubmit={e=>{e.preventDefault();if(prompt.trim())void run(()=>editApi(path+'/plan','POST',{id:crypto.randomUUID(),revision:edit.revision,prompt}),()=>setPrompt(''));}}>
        <input aria-label="剪辑调整要求" placeholder="例如，把第二个镜头缩短两秒" value={prompt} onChange={e=>setPrompt(e.target.value)}/>
        <button disabled={protectedUi||!prompt.trim()||!total}>调整剪辑</button></form>
    </details>
    {edit.messages.at(-1)&&<p className="cut-note">{edit.messages.at(-1)!.reply} {edit.messages.at(-1)!.gaps.join(' ')}</p>}
    </div>
    {picker&&<VideoPicker single={picker==='replace'} assets={assets} busy={busy} close={()=>setPicker(null)} choose={ids=>void run(()=>add(ids.map(k=>assets.find(a=>a.id===k)!)),()=>setPicker(null))} upload={files=>void run(async()=>add(await upload(files)),()=>setPicker(null))}/>}
  </section>;
}
