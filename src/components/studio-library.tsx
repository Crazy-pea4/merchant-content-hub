'use client';
import { useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, AudioLines, Check, Copy, FileText, Film, FolderOpen, Image as ImageIcon, LayoutList, Pencil, Search, X } from 'lucide-react';
import { studioModes, type StudioState, type StudioTurn } from '@/shared/studio';
import type { Asset, Content } from '@/shared/types';

export interface ShelfItem {
  id: string; projectId?: string; title: string; body: string; kind: string; date: string;
  url?: string; asset?: Asset; turn?: StudioTurn; content?: Content;
}
export function shelfItems(state: StudioState): ShelfItem[] {
  const labels = {video:'视频',audio:'音频',image:'图片',document:'文稿'};
  return [
    ...state.sessions.flatMap(s => s.turns.filter(t => t.status === 'done').map(t => ({id:'w:'+t.id,projectId:s.id,title:t.title,body:t.body,kind:studioModes[t.mode],date:t.updatedAt,turn:t}))),
    ...state.contents.map(c => ({id:'w:'+c.id,projectId:c.projectId,title:c.title,body:c.script,kind:'剧本',date:c.createdAt,content:c})),
    ...state.assets.map(a => ({id:'a:'+a.id,projectId:a.projectId,title:a.name,body:a.segments.map(s=>s.text).join('\n'),kind:labels[a.kind],date:a.createdAt,asset:a,url:a.storageKey?'/api/files/'+a.id:undefined})),
    ...state.media.map(m => ({id:'m:'+m.id,projectId:m.projectId,title:m.title,body:m.text,kind:m.kind,date:m.createdAt,url:m.url})),
  ].sort((a,b)=>b.date.localeCompare(a.date));
}
export function KindIcon({kind,size=16}:{kind:string;size?:number}) {
  const Icon=kind==='视频'||kind==='成片'?Film:kind==='配音'||kind==='音频'?AudioLines:kind==='图片'?ImageIcon:kind==='分镜'?LayoutList:FileText;
  return <Icon size={size}/>;
}
function mediaDuration(seconds: number) {
  const value = Math.floor(seconds);
  return Math.floor(value / 60).toString().padStart(2, '0') + ':' + (value % 60).toString().padStart(2, '0');
}
export function Library({items,onOpen}:{items:ShelfItem[];onOpen:(id:string)=>void}) {
  const [filter,setFilter]=useState('全部'),[query,setQuery]=useState(''),[kind,setKind]=useState('');
  const group = items.filter(i=>filter==='全部'||(filter==='作品'?!!(i.turn||i.content||i.id.startsWith('m:')):!!i.asset));
  const kinds = [...new Set(group.map(i=>i.kind))];
  const shown=group.filter(i=>(!kind||i.kind===kind)&&(i.title+' '+i.body).toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="studio-library">
    <header className="library-heading"><h1>我的资产</h1>
      <label className="shelf-search"><Search size={15}/><input placeholder="搜索资产" aria-label="搜索资产" value={query} onChange={e=>setQuery(e.target.value)}/></label></header>
    <div className="library-bar"><div className="studio-tabs">{['全部','作品','素材'].map(f=><button aria-pressed={f===filter} className={f===filter?'selected':''} onClick={()=>{setFilter(f);setKind('');}} key={f}>{f}</button>)}</div>
      {kinds.length>1&&<select className="library-kind" aria-label="资产类型" value={kind} onChange={e=>setKind(e.target.value)}><option value="">全部类型</option>{kinds.map(k=><option key={k}>{k}</option>)}</select>}</div>
    {shown.length?<div className="shelf-grid">{shown.map(i=>{
      const thumb = i.asset?.thumbnailKey ? i.url+'?thumb=1' : i.kind==='图片' ? i.url : undefined;
      return <button className="shelf-card" key={i.id} onClick={()=>onOpen(i.id)}>
        <span className={'shelf-preview '+(i.turn||i.content?'is-work':i.kind==='配音'||i.kind==='音频'?'is-audio':'is-file')}>
          {thumb?<img className="shelf-thumb" src={thumb} alt="" loading="lazy"/>:<KindIcon kind={i.kind} size={34}/>}
          <small>{i.asset?.duration ? mediaDuration(i.asset.duration) : i.kind}</small>
        </span>
        <span className="shelf-caption"><strong>{i.title}</strong><span><small>{i.kind}</small><time>{new Date(i.date).toLocaleDateString('zh-CN')}</time></span></span>
      </button>;
    })}</div>:<div className="studio-empty"><FolderOpen/><h2>{query?'没有匹配的资产':'这里会收好你的作品'}</h2><p>{query?'试试更短的关键词。':'上传的素材和生成的作品会自动出现在这里。'}</p></div>}
  </section>;
}
function Prose({text}:{text:string}) {
  return <div className="studio-prose">{text.split(/\r?\n/).map((line,i)=>{
    const flat=line.replace(/\*\*([^*]+)\*\*/g,'$1');
    if(!flat.trim()) return null;
    if(/^#{1,6}\s/.test(flat)) return <h4 key={i}>{flat.replace(/^#{1,6}\s*/, '')}</h4>;
    return <p key={i}>{flat.replace(/^[-*]\s/,'• ')}</p>;
  })}</div>;
}
export function StudioDocument({item,save,continueWork,notify}:{item:ShelfItem;save:(title:string,body:string,version:number)=>Promise<boolean>;continueWork?:()=>void;notify:(s:string)=>void}) {
  const [editing,setEditing]=useState(false),[title,setTitle]=useState(''),[body,setBody]=useState(''),[version,setVersion]=useState(0),[busy,setBusy]=useState(false);
  const [preview,setPreview]=useState(false);
  const example=item.turn?.provider==='demo'?' · 本地示例':'';
  if(editing) return <article className="studio-document editing">
    <form onSubmit={async event=>{
      event.preventDefault();
      setBusy(true);
      try { if(await save(title,body,version))setEditing(false); } finally { setBusy(false); }
    }}>
      <header className="editing-toolbar">
        <div className="editor-kind"><Pencil size={14}/>{preview?'预览':'编辑中'}</div>
        <div className="editor-kind"><KindIcon kind={item.kind} size={14}/>{item.kind}</div>
        <div className="editor-buttons">
          <button type="button" aria-pressed={preview} onClick={()=>setPreview(!preview)}>{preview?'返回编辑':'预览'}</button>
          <button type="button" onClick={()=>setEditing(false)} disabled={busy}>取消</button>
          <button className="studio-solid" disabled={busy||!title.trim()||!body.trim()}>保存修改</button>
        </div>
      </header>
      <div className="writing-sheet">{preview?<><h3>{title}</h3><Prose text={body}/></>:<>
        <input className="doc-title-input" value={title} maxLength={160} required aria-label="作品标题" onChange={e=>setTitle(e.target.value)}/>
        <textarea className="doc-body-input" value={body} maxLength={item.content?12000:30000} aria-label="作品正文" required onChange={e=>setBody(e.target.value)} autoFocus/>
      </>}</div>
      <div className="writing-meta"><span>第 {version} 版{example}</span><span>{Array.from(body).length.toLocaleString('zh-CN')} 字符</span></div>
      {item.content && <p className="quiet">保存将建立新的业务草稿版本，原审核链接随之失效。</p>}
    </form>
  </article>;
  return <article className="studio-document">
    <div className="doc-kicker"><span><KindIcon kind={item.kind} size={14}/>{item.kind}{example}</span><span>已存入资产 <Check size={12}/></span></div>
    <h3>{item.title}</h3><Prose text={item.body}/><div className="doc-actions">
      <button onClick={()=>{setTitle(item.title);setBody(item.body);setVersion(item.turn?.version||item.content?.version||1);setPreview(false);setEditing(true);}}><Pencil size={14}/>直接编辑</button>
      <button onClick={async()=>{try{await navigator.clipboard.writeText(item.title+'\n\n'+item.body);notify('正文已复制');}catch{notify('请选中正文复制');}}}><Copy size={14}/>复制</button>
      {continueWork&&<button onClick={continueWork}>继续创作<ArrowUpRight size={14}/></button>}</div>
  </article>;
}
export function MediaReader({item,sessionTitle,onAuthorize,use}:{item:ShelfItem;sessionTitle?:string;onAuthorize:()=>void;use?:()=>void}){
  const audio=['音频','配音'].includes(item.kind),video=['视频','成片'].includes(item.kind);
  const asset=item.asset;
  return <div className="media-inspector">
    <article className="studio-document"><div className="doc-kicker"><span><KindIcon kind={item.kind}/>{item.kind}</span></div><h3>{item.title}</h3>
      {item.url&&(audio?<audio src={item.url} controls/>:video?<video src={item.url} controls playsInline/>:item.kind==='图片'?<img src={item.url} alt={item.title}/>:null)}
      {item.body&&<section className="media-transcript"><h4>{video||audio?'逐字稿':'正文'}</h4><Prose text={item.body}/></section>}
      <div className="doc-actions">
        {item.url&&<a href={item.url+(item.url.includes('?')?'&':'?')+'download=1'} download><ArrowDownToLine size={14}/>下载</a>}
        {asset&&asset.rights!=='authorized'&&<button onClick={onAuthorize}>确认素材使用授权</button>}
        {use&&<button onClick={use}>用于创作<ArrowUpRight size={14}/></button>}
      </div>
    </article>
    <aside className="media-facts"><h2>素材信息</h2><dl>
      <dt>类型</dt><dd>{item.kind}</dd>
      {sessionTitle&&<><dt>创作</dt><dd>{sessionTitle}</dd></>}
      <dt>创建日期</dt><dd>{new Date(item.date).toLocaleDateString('zh-CN')}</dd>
      {asset && <><dt>使用授权</dt><dd>{asset.rights==='expired'||asset.expiresAt&&asset.expiresAt<new Date().toISOString().slice(0,10)?'已过期':asset.rights==='authorized'?'已授权':'待确认'}</dd></>}
      {!!asset?.duration&&<><dt>时长</dt><dd>{mediaDuration(asset.duration)}</dd></>}
      {!!asset?.size&&<><dt>文件大小</dt><dd>{asset.size>=1048576?(asset.size/1048576).toFixed(1)+' MB':Math.ceil(asset.size/1024)+' KB'}</dd></>}
    </dl></aside>
  </div>;
}
