'use client';
import './creator-studio.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Aperture, Archive, ArrowLeft, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, Clapperboard, Film, FolderOpen, Grid2X2, Layers3, LoaderCircle, Menu, MessageSquare, Mic2, NotebookPen, Paperclip, Plus, ScanLine, Sparkles, SquarePen, Video, X } from 'lucide-react';
import type { Asset } from '@/shared/types';
import { emptyStudioSession, studioModes, type BoardChange, type BoardLink, type StudioMode, type StudioState, type StudioTurn } from '@/shared/studio';
import { KindIcon, Library, MediaReader, shelfItems, StudioDocument, type ShelfItem } from './studio-library';
import type { ToolSource } from './tool-asset-button';
const StudioBoard = dynamic(() => import('./studio-board'));

const DubbingTool = dynamic(() => import('./dubbing-tool'));
const DouyinTool = dynamic(() => import('./douyin-tool'));
type View = 'chat' | 'board' | 'assets' | 'dubbing' | 'douyin';
type Route = { view: View; session: string; item: string };
const home: Route = { view: 'chat', session: '', item: '' };
const names: Record<View,string> = { chat:'创作对话', board:'素材画布', assets:'我的资产', dubbing:'声音克隆与配音', douyin:'抖音文案提取' };
function readRoute(): Route {
  const params = new URLSearchParams(location.search), tab = params.get('tab') || 'chat';
  return { view: Object.hasOwn(names,tab) ? tab as View : 'chat', session: params.get('s') || '', item: params.get('item') || '' };
}
class StudioError extends Error { constructor(message:string, readonly status:number){super(message);} }
async function api<T>(path:string, method='GET', body?:unknown): Promise<T> {
  const multipart=body instanceof FormData;
  const res=await fetch('/api/'+path,{method, cache:'no-store', headers:body&&!multipart?{'Content-Type':'application/json'}:undefined,body:multipart?body:body?JSON.stringify(body):undefined});
  const json=await res.json(); if(!res.ok)throw new StudioError(json.error||'操作失败，请重试',res.status); return json;
}
const emptyDraft = () => ({text:'', mode:'script' as StudioMode, ids:[] as string[], files:[] as File[], base:''});
type Draft = ReturnType<typeof emptyDraft>;
const starters: {mode:StudioMode; title:string; sub:string; prompt:string}[] = [
  {mode:'script',title:'写一个短剧',sub:'从人物和冲突开始',prompt:'帮我写一个一分钟短剧。故事发生在'},
  {mode:'shots',title:'把视频变成分镜',sub:'从已有的镜头开始',prompt:'请根据我附上的视频，整理成一份可拍摄的分镜脚本。'},
  {mode:'copy',title:'写一段口播',sub:'让文案适合说出口',prompt:'帮我写一段自然的口播文案，主题是'},
];
function usable(a:Asset){return a.rights==='authorized' && (!a.expiresAt||a.expiresAt>=new Date().toISOString().slice(0,10));}
function Brand(){return <span className="studio-brand"><i><Aperture size={22} strokeWidth={2.2}/></i><b>片场</b><small>Fieldwork</small></span>;}
function StarterArt({mode}:{mode:StudioMode}){return <span className={'starter-art art-'+mode} aria-hidden="true">{mode==='script'?<i className="art-slate"><u/><b/><em/></i>:mode==='shots'?<i className="art-frames"><b/><em/></i>:<i className="art-disc"><b/><em/><u/></i>}</span>;}

export default function CreatorStudio(){
  const [data,setData]=useState<StudioState|null>(null), [route,setRoute]=useState<Route>(home);
  const [auth,setAuth]=useState(false),[initialError,setInitialError]=useState(''),[notice,setNotice]=useState('');
  const [drawer,setDrawer]=useState(false),[picker,setPicker]=useState(false),[toolsOpen,setToolsOpen]=useState(false);
  const [drafts,setDrafts]=useState<Record<string,Draft>>({}),[sending,setSending]=useState(''),[stage,setStage]=useState('');
  const [toolBusy,setToolBusy]=useState(false),[dragOver,setDragOver]=useState(false);
  const seq=useRef(0), lock=useRef(false), fileInput=useRef<HTMLInputElement>(null), input=useRef<HTMLTextAreaElement>(null), bottom=useRef<HTMLDivElement>(null);
  const report=useCallback((e:unknown)=>{if(e instanceof StudioError && e.status===401)setAuth(true);setNotice(e instanceof Error?e.message:'操作失败，请重试');},[]);
  const refresh=useCallback(async()=>{
    const n=++seq.current;
    try {const next=await api<StudioState>('studio'); if(n===seq.current){setData(next);setAuth(false);setInitialError('');}return next;}
    catch(e){if(n===seq.current){if(e instanceof StudioError&&e.status===401)setAuth(true);else setInitialError(e instanceof Error?e.message:'加载失败');}throw e;}
  },[]);
  useEffect(()=>{const restore=()=>{const restored=readRoute();setRoute(restored);setToolsOpen(['dubbing','douyin'].includes(restored.view));setPicker(false);setDrawer(false);};restore();window.addEventListener('popstate',restore);void refresh().catch(()=>{});return()=>window.removeEventListener('popstate',restore);},[refresh]);
  useEffect(()=>{if(!notice)return;const t=setTimeout(()=>setNotice(''),6500);return()=>clearTimeout(t);},[notice]);
  const awaiting=data?.sessions.some(s=>s.turns.some(t=>t.status==='writing'));
  useEffect(()=>{const tick=()=>{if(!document.hidden)void refresh().catch(()=>{});};window.addEventListener('focus',tick);const timer=sending||awaiting?setInterval(tick,2000):undefined;return()=>{clearInterval(timer);window.removeEventListener('focus',tick);};},[refresh,sending,awaiting]);
  function go(view:View,session=route.session,item=''){
    const newRoute={view,session,item}, url=new URL('/',location.origin);
    if(view!=='chat')url.searchParams.set('tab',view);if(session)url.searchParams.set('s',session);if(item)url.searchParams.set('item',item);
    if(location.pathname+location.search!==url.pathname+url.search)history.pushState(null,'',url);
    setRoute(newRoute);if(view==='dubbing'||view==='douyin')setToolsOpen(true);setDrawer(false);setPicker(false);if(view==='assets'||view==='board')void refresh().catch(report);
  }
  const allItems=useMemo(()=>data?shelfItems(data):[],[data]),item=allItems.find(i=>i.id===route.item);
  const projects=data?.projects||[], project=projects.find(p=>p.id===route.session);
  const session=data?.sessions.find(s=>s.id===route.session)||emptyStudioSession(route.session,project?.name||'新创作',project?.createdAt||'');
  const draftKey=route.session||'new',draft=drafts[draftKey]||emptyDraft();
  const legacy=allItems.filter(i=>i.content&&i.projectId===route.session);
  const hasStory=session.turns.length>0||legacy.length>0, writing=!!sending||session.turns.some(t=>t.status==='writing');
  const scopeItems=allItems.filter(i=>i.projectId===session.id||i.asset&&session.attached.includes(i.asset.id));
  function updateDraft(patch:Partial<Draft>,key=draftKey){setDrafts(d=>({...d,[key]:{...(d[key]||emptyDraft()),...patch}}));}
  useEffect(()=>{if(route.view==='chat'&&hasStory)bottom.current?.scrollIntoView({block:'nearest'});},[route.session,route.view,session.turns.length,session.turns.at(-1)?.status]);
  async function ensureSession(title:string){
    if(route.session)return route.session;
    const id=crypto.randomUUID();await api('studio-sessions','POST',{id,title:title.slice(0,48)||'新创作'});
    setDrafts(d=>({...d,new:emptyDraft(),[id]:d.new||emptyDraft()}));
    go(route.view,id);await refresh();return id;
  }
  async function send(retry?:StudioTurn){
    if(lock.current)return;
    const prompt=retry?.prompt||draft.text.trim()||(draft.files.length||draft.ids.length?'根据这些素材写一份可拍摄的'+studioModes[draft.mode]+'。':'');
    if(!prompt)return;lock.current=true;setSending(route.session||'new');setStage('正在准备创作');
    let id=route.session;
    try {
      id=await ensureSession(prompt);setSending(id);
      const ids=[...(retry?.assetIds||draft.ids)], files=retry?[]:[...draft.files];
      while(files.length){
        setStage('正在上传 '+files[0].name);
        const form=new FormData();form.set('file',files[0]);form.set('rights','authorized');form.set('projectId',id);
        const asset=await api<Asset>('assets','POST',form);ids.push(asset.id);files.shift();
        updateDraft({ids:[...ids],files:[...files]},id);
      }
      setStage('正在创作'+studioModes[retry?.mode||draft.mode]);
      await api('studio-sessions/'+id+'/turns','POST',{id:retry?.id||crypto.randomUUID(),prompt,mode:retry?.mode||draft.mode,assetIds:ids,baseId:retry?.previousId||draft.base||undefined});
      if(!retry || draft.text.trim()===retry.prompt)updateDraft({...emptyDraft(),mode:draft.mode},id);
    }catch(e){report(e);}finally{await refresh().catch(()=>{});lock.current=false;setSending('');setStage('');}
  }
  async function boardChange(change:BoardChange){try{const id=await ensureSession('素材创作');await api('studio-sessions/'+id+'/board','PATCH',change);await refresh();return true;}catch(e){report(e);return false;}}
  function addFiles(files:File[]){
    const remaining=8-draft.ids.length-draft.files.length;if(files.length>remaining){setNotice('每次最多附上 8 份素材');return;}
    updateDraft({files:[...draft.files,...files]});
  }
  async function pickAsset(a:Asset){
    if(route.view==='board'){if(await boardChange({action:'attach',assetId:a.id}))setPicker(false);return;}
    if(draft.ids.includes(a.id))updateDraft({ids:draft.ids.filter(id=>id!==a.id)});
    else if(draft.ids.length+draft.files.length<8)updateDraft({ids:[...draft.ids,a.id]});
    else setNotice('每次最多附上 8 份素材');
  }
  async function editWork(i:ShelfItem,title:string,body:string,version:number){
    try {if(i.turn)await api('studio-sessions/'+i.projectId+'/turns','PATCH',{id:i.turn.id,title,body,version});
      else if(i.content)await api('contents/'+i.content.id,'PATCH',{...i.content,version,title,script:body});
      await refresh();setNotice('修改已保存');return true;
    }catch(e){report(e);return false;}
  }
  function resume(i:ShelfItem){const key=i.projectId||'';updateDraft({base:i.id.slice(2),mode:i.turn?.mode||'script'},key||'new');go('chat',key);requestAnimationFrame(()=>input.current?.focus());}
  function documentFor(i:ShelfItem){return <StudioDocument key={i.id} item={i} save={(t,b,v)=>editWork(i,t,b,v)} notify={setNotice} continueWork={()=>resume(i)}/>;}
  async function saveToolAsset(source:ToolSource){setToolBusy(true);try{await api('projects/'+route.session+'/tool-assets','POST',source);await refresh();setNotice('已存入资产');}catch(e){report(e);}finally{setToolBusy(false);}}
  const expired=useCallback(()=>setAuth(true),[]);
  if(auth)return <div className="studio-login"><div><Brand/><h1>进入个人创作室</h1><form onSubmit={async e=>{e.preventDefault();const token=new FormData(e.currentTarget).get('token');try{await api('session','POST',{token});await refresh();setNotice('');}catch(err){report(err);}}}><label>访问口令<input name="token" type="password" required autoFocus/></label><button className="studio-solid">进入创作室</button></form>{notice&&<p role="alert">{notice}</p>}</div></div>;
  if(!data)return <div className="studio-login"><div><Brand/><p>{initialError||'正在打开创作室…'}</p>{initialError&&<button onClick={()=>void refresh().catch(report)}>重新加载</button>}</div></div>;
  const openItem=(id:string)=>go('assets',route.session,id);
  const recents=projects.map(p=>({id:p.id,title:p.name,at:data.sessions.find(s=>s.id===p.id)?.updatedAt||p.createdAt})).sort((a,b)=>b.at.localeCompare(a.at));
  const boardItems=scopeItems.filter(i=>i.asset||i.content||i.turn);
  const links:BoardLink[]=boardItems.flatMap(i=>{
    const refs=i.turn?.assetIds||i.content?.sourceAssetIds||[];const edges=refs.map(a=>({from:'a:'+a,to:i.id}));
    if(i.turn?.previousId)edges.push({from:'w:'+i.turn.previousId,to:i.id});return edges;
  });
  const composer=<div className={'studio-composer'+(dragOver?' dragging':'')} onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)} onDrop={e=>{e.preventDefault();setDragOver(false);if(!writing)addFiles(Array.from(e.dataTransfer.files));}}>
    {(draft.base||draft.ids.length>0||draft.files.length>0)&&<div className="draft-chips">
      {draft.base&&<button onClick={()=>updateDraft({base:''})}>续写 · {allItems.find(i=>i.id==='w:'+draft.base)?.title||'作品'} <X size={12}/></button>}
      {draft.ids.map(id=><button key={id} disabled={writing} onClick={()=>updateDraft({ids:draft.ids.filter(x=>x!==id)})}><Film size={13}/>{data.assets.find(a=>a.id===id)?.name||'已选素材'}<X size={12}/></button>)}
      {draft.files.map((f,n)=><button key={n} disabled={writing} onClick={()=>updateDraft({files:draft.files.filter((_,i)=>i!==n)})}><Paperclip size={13}/>{f.name}<X size={12}/></button>)}
    </div>}
    <textarea ref={input} aria-label="创作要求" placeholder={hasStory?'继续修改，或告诉我下一个想法…':'写下你的想法，或拖入视频一起创作…'} value={draft.text} maxLength={8000} disabled={writing} onChange={e=>updateDraft({text:e.target.value})} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.nativeEvent.keyCode!==229){e.preventDefault();void send();}}}/>
    <div className="composer-bar"><input ref={fileInput} className="studio-file" type="file" multiple accept=".mp4,.mov,.webm,.mp3,.wav,.m4a,.ogg,.flac,.jpg,.jpeg,.png,.webp,.srt,.txt,.md" onChange={e=>{addFiles(Array.from(e.target.files||[]));e.target.value='';}}/>
    <button className="composer-attach" title="上传自有素材" aria-label="上传自有素材" disabled={writing} onClick={()=>fileInput.current?.click()}><Paperclip size={17}/></button>
    <button title="从资产中引用" aria-label="从资产中引用" disabled={writing} onClick={()=>setPicker(true)}><FolderOpen size={17}/></button><i className="bar-break"/>
    <label className="mode-select"><Sparkles size={14}/><select aria-label="创作类型" value={draft.mode} disabled={writing} onChange={e=>updateDraft({mode:e.target.value as StudioMode})}>{Object.entries(studioModes).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select><ChevronDown size={12}/></label>
    <button className="send-prompt" aria-label="发送创作要求" disabled={writing||(!draft.text.trim()&&!draft.files.length&&!draft.ids.length)} onClick={()=>void send()}>{writing?<LoaderCircle size={18} className="spin"/>:<ArrowUp size={20}/>}</button></div>
    {draft.files.length>0&&<small className="upload-note">发送即确认有权使用所选文件，画面与逐字稿可用于模型创作。</small>}
  </div>;
  return <div className="creator-shell">
    {drawer&&<button className="rail-mask" aria-label="关闭导航" onClick={()=>setDrawer(false)}/>}
    <aside className={'creator-rail'+(drawer?' open':'')}><button className="brand-home" aria-label="片场首页" onClick={()=>go('chat','')}><Brand/></button>
      <button className="start-chat" onClick={()=>{go('chat','');requestAnimationFrame(()=>input.current?.focus());}}><SquarePen size={17}/>新创作<Plus size={14}/></button>
      <nav aria-label="个人创作导航"><button className={route.view==='assets'?'current':''} onClick={()=>go('assets')}><Layers3/>我的资产</button><button className={route.view==='board'?'current':''} onClick={()=>go('board')}><Grid2X2/>素材画布</button>
        <button aria-expanded={toolsOpen} onClick={()=>setToolsOpen(!toolsOpen)}><Clapperboard/>创作工具<ChevronDown className="rail-more"/></button>
        {toolsOpen&&<div className="rail-sub"><button onClick={()=>go('dubbing')}><Mic2/>声音克隆与配音</button><button onClick={()=>go('douyin')}><ScanLine/>抖音文案提取</button><a href="/narration"><Video/>视频旁白</a></div>}
      </nav><div className="recent-title">最近创作</div><div className="recent-list">{recents.map(s=><button key={s.id} className={s.id===route.session?'current':''} onClick={()=>go('chat',s.id)}><MessageSquare size={14}/><span>{s.title}</span></button>)}{!recents.length&&<small>你的创作对话会出现在这里</small>}</div>
      <div className="rail-footer"><i><NotebookPen size={16}/></i><span>个人创作室</span><a href="/archive" title="历史项目管理" aria-label="历史项目管理"><Archive size={15}/></a></div>
    </aside>
    <div className="creator-main"><header className="studio-header"><button className="rail-toggle" aria-label="打开导航" onClick={()=>setDrawer(true)}><Menu size={20}/></button><span>片场</span><ChevronRight size={13}/><b>{names[route.view]}</b><div className="studio-status"><i className={data.ai?'online':''}/>{data.ai?'AI 已配置':'本地示例模式'}</div></header>
    {route.view==='chat'?<div className={'chat-area'+(hasStory||sending?' active':'')}>
      {!hasStory&&!sending?<div className="studio-welcome"><div className="welcome-logo" aria-hidden="true"><Aperture size={27}/></div><h1>今天，想创作什么<span>？</span></h1><p>从一个想法或几段镜头开始，写下你的下一部作品。</p>{composer}
        <div className="starter-grid">{starters.map(s=><button key={s.mode} onClick={()=>{updateDraft({mode:s.mode,text:s.prompt});input.current?.focus();}}><StarterArt mode={s.mode}/><span><b>{s.title}</b><small>{s.sub}</small></span><ArrowUpRight size={13}/></button>)}</div></div>:
      <><section className="conversation-log"><div className="transcript-inner"><div className="conversation-title"><h1>{session.title}</h1><button onClick={()=>go('board')}><Grid2X2 size={14}/>画布</button></div>
        {legacy.map(documentFor)}{session.turns.map(t=><div key={t.id} className="turn"><div className="user-bubble">{t.prompt}</div>{t.assetIds.length>0&&<div className="turn-sources">{t.assetIds.map(id=><button key={id} onClick={()=>openItem('a:'+id)}><Paperclip size={12}/>{data.assets.find(a=>a.id===id)?.name||'素材'}</button>)}</div>}
          {t.status==='done'?documentFor(allItems.find(i=>i.id==='w:'+t.id)!):t.status==='failed'?<div className="turn-status" role="alert">{t.error}<button disabled={writing} onClick={()=>void send(t)}>重新生成</button></div>:<div className="turn-status"><LoaderCircle className="spin" size={16}/>正在创作{studioModes[t.mode]}…</div>}</div>)}
        {sending&&(sending===route.session||sending==='new')&&!session.turns.some(t=>t.status==='writing')&&<div className="turn-status" role="status"><LoaderCircle className="spin" size={16}/>{stage}…</div>}<div ref={bottom}/></div></section>
        <div className="conversation-compose">{composer}</div></>}
    </div>:route.view==='board'?<><div className="board-heading"><h1>素材画布</h1><select aria-label="选择创作画布" value={route.session} onChange={e=>go('board',e.target.value)}><option value="">新创作</option>{recents.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select></div><StudioBoard key={route.session} session={session} cards={boardItems.map(i=>({id:i.id,name:i.title,kind:i.kind,description:i.body.slice(0,60)||i.kind,thumb:i.asset?.thumbnailKey?i.url+'?thumb=1':undefined}))} sources={links} save={boardChange} open={openItem} add={()=>setPicker(true)}/></>:
    route.view==='assets'?<div className="studio-scroll">{route.item&&item?<div className="asset-reader"><button className="reader-back" onClick={()=>go('assets')}><ArrowLeft size={15}/>我的资产</button>
      {item.turn||item.content?documentFor(item):<MediaReader item={item} onAuthorize={async()=>{try{await api('assets/'+item.asset!.id,'PATCH',{rights:'authorized'});await refresh();}catch(e){report(e);}}} use={item.asset&&usable(item.asset)?()=>{const key=route.session||item.projectId||'';updateDraft({ids:[item.asset!.id]},key||'new');go('chat',key);}:undefined}/>}</div>:<Library items={allItems} onOpen={openItem}/>}</div>:
    <div className="studio-scroll"><section className="studio-tool"><h1>{names[route.view]}</h1><label className="tool-scope">创作归属 <select aria-label="切换项目" value={route.session} onChange={e=>go(route.view,e.target.value)}><option value="">个人资产</option>{projects.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
      {route.view==='dubbing'?<DubbingTool key={route.session} projectId={route.session} assets={data.assets.filter(a=>a.projectId===route.session)} contents={(route.session?scopeItems:allItems).filter(i=>i.turn||i.content).map(i=>({id:i.id,title:i.title,script:i.body}))} saveAsset={saveToolAsset} workspaceBusy={toolBusy} onSessionExpired={expired}/>:<DouyinTool key={route.session} projectId={route.session} assets={data.assets.filter(a=>a.projectId===route.session)} saveAsset={saveToolAsset} workspaceBusy={toolBusy} onSessionExpired={expired}/>}</section></div>}
    </div>
    {picker&&<div className="asset-pick-mask" onClick={()=>setPicker(false)}><section className="asset-pick" role="dialog" aria-modal="true" aria-label="选择参考素材" onClick={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==='Escape')setPicker(false);}}><header><h2>选择参考素材</h2><button autoFocus aria-label="关闭" onClick={()=>setPicker(false)}><X size={18}/></button></header><div>{data.assets.filter(usable).map(a=><button key={a.id} onClick={()=>void pickAsset(a)}><Film size={17}/><span>{a.name}</span>{draft.ids.includes(a.id)||route.view==='board'&&boardItems.some(i=>i.id==='a:'+a.id)?<Check size={15}/>:<Plus size={15}/>}</button>)}{!data.assets.some(usable)&&<p>暂无已授权素材。可在对话框上传自己的文件。</p>}</div><footer><button className="studio-solid" onClick={()=>setPicker(false)}>完成</button></footer></section></div>}
    {notice&&<div className="studio-toast" role="status">{notice}<button aria-label="关闭提示" onClick={()=>setNotice('')}><X size={14}/></button></div>}
  </div>;
}
