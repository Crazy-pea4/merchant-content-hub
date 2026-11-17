'use client';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Cable, FileText, Focus, Minus, Plus, Unlink, Video, X } from 'lucide-react';
import { type BoardChange, type BoardLink, type BoardPoint, type StudioSession } from '@/shared/studio';

export interface BoardCard { id: string; name: string; kind: string; description: string; thumb?: string }
const width = 192, height = 104;
export default function StudioBoard({ session, cards, sources, save, open, add }: {
  session: StudioSession; cards: BoardCard[]; sources: BoardLink[];
  save: (change: BoardChange) => Promise<boolean>; open: (id: string) => void; add: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 45, y: 65 }), [scale, setScale] = useState(1);
  const [preview, setPreview] = useState<Record<string, BoardPoint>>({}), [connecting, setConnecting] = useState(''), [selected, setSelected] = useState<BoardLink | null>(null);
  const dragging = useRef<{ id: string; pointer: number; at: BoardPoint; initial: BoardPoint; moved: boolean } | null>(null);
  // Place sources before their derived works. Manual links do not change this layout.
  const parents = new Map<string, string[]>();
  for (const { from, to } of sources) parents.set(to, [...(parents.get(to) || []), from]);
  const columns = new Map<string, number>();
  function column(id: string): number {
    const cached = columns.get(id);
    if (cached !== undefined) return cached;
    columns.set(id, 0);
    const level = Math.max(0, ...(parents.get(id) || []).map(source => column(source) + 1));
    columns.set(id, level);
    return level;
  }
  const nextRow = new Map<number, number>();
  const positions: Record<string, BoardPoint> = {};
  for (const card of cards) {
    const level = column(card.id), row = nextRow.get(level) || 0;
    nextRow.set(level, row + 1);
    positions[card.id] = preview[card.id] || session.positions[card.id] || { x: level * 296, y: row * 144 };
  }
  function fit() {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect || !cards.length) { setScale(1); setPan({x:40,y:48}); return; }
    const ps = Object.values(positions), left = Math.min(...ps.map(p => p.x)), top = Math.min(...ps.map(p => p.y));
    const w = Math.max(...ps.map(p => p.x + width)) - left, h = Math.max(...ps.map(p => p.y + height)) - top;
    const k = Math.min(1, Math.max(.18, Math.min((rect.width - 64) / w, (rect.height - 96) / h)));
    setScale(k); setPan({ x: (rect.width - w * k) / 2 - left * k, y: (rect.height - h * k) / 2 - top * k });
  }
  useEffect(() => { fit(); }, [session.id, cards.length]);
  function zoom(factor: number, x: number, y: number) {
    const k = Math.max(.18, Math.min(2.5, scale * factor));
    setPan(p => ({ x: x - (x - p.x) * k / scale, y: y - (y - p.y) * k / scale })); setScale(k);
  }
  function start(e: ReactPointerEvent, id = '') {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, path')) return;
    e.preventDefault(); e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = { id, pointer: e.pointerId, at: {x:e.clientX,y:e.clientY}, initial: id ? positions[id] : pan, moved:false };
  }
  function move(e: ReactPointerEvent) {
    const d = dragging.current; if (!d || d.pointer !== e.pointerId) return;
    const dx = e.clientX - d.at.x, dy = e.clientY - d.at.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (!d.moved) return;
    if (d.id) setPreview(p => ({ ...p, [d.id]: {x:d.initial.x+dx/scale, y:d.initial.y+dy/scale} }));
    else setPan({x:d.initial.x+dx, y:d.initial.y+dy});
  }
  async function end(e: ReactPointerEvent) {
    const d = dragging.current; if (!d || d.pointer !== e.pointerId) return;
    dragging.current = null;
    if (d.id && d.moved) {
      const point = {x:Math.round(d.initial.x+(e.clientX-d.at.x)/scale),y:Math.round(d.initial.y+(e.clientY-d.at.y)/scale)};
      await save({action:'move',node:d.id,...point});
      setPreview(current => { const next = { ...current }; delete next[d.id]; return next; });
    }
  }
  const manual = session.links.filter(l => !sources.some(s => s.from === l.from && s.to === l.to));
  async function port(id: string) {
    if (!connecting) { setConnecting(id); setSelected(null); return; }
    if (connecting !== id && !sources.some(l => l.from === connecting && l.to === id)) await save({action:'connect',from:connecting,to:id});
    setConnecting('');
  }
  return <div className="studio-board" ref={viewport} onPointerDown={e => start(e)} onPointerMove={move} onPointerUp={end}
    onPointerCancel={() => { dragging.current = null; setPreview({}); }}
    onWheel={e => { if (!viewport.current) return; const rect = viewport.current.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.08 : .925, e.clientX-rect.left, e.clientY-rect.top); }}>
    <div className="board-tools"><button onClick={add}><Plus size={16}/>加入素材</button>{connecting && <button onClick={() => setConnecting('')}>选择另一张卡片的连接点 <X size={14}/></button>}
    {selected && <button onClick={async () => { if(await save({action:'disconnect',...selected})) setSelected(null); }}><Unlink size={14}/>移除关系</button>}</div>
    {!cards.length && <div className="board-empty"><Cable size={32}/><h3>把素材放上画布</h3><p>剧本生成后，引用的素材会自动连到作品上。</p><button onClick={add}>选择素材</button></div>}
    <div className="board-world" style={{transform:`translate(${pan.x}px,${pan.y}px) scale(${scale})`}}>
      <svg className="board-lines" aria-label="素材与作品的关联">{[...sources,...manual].map((link,i) => {
        const a=positions[link.from], b=positions[link.to]; if(!a || !b) return null;
        const x=a.x+width, y=a.y+height/2, x2=b.x, y2=b.y+height/2, d=`M ${x} ${y} C ${x+76} ${y}, ${x2-76} ${y2}, ${x2} ${y2}`;
        return <g key={link.from+'>'+link.to}><path d={d} className={i<sources.length?'automatic':'manual'}/>{i>=sources.length && <path className="line-hit" d={d} onClick={() => setSelected(link)}/>}</g>;
      })}</svg>
      {cards.map(c => <div className={'board-node '+(c.id.startsWith('w:')?'work ':'')+(connecting===c.id?'linking':'')} key={c.id} style={{left:positions[c.id].x,top:positions[c.id].y}} onPointerDown={e=>start(e,c.id)}>
        <button className="board-inlet" aria-label={'连接到 '+c.name} onClick={()=>void port(c.id)}/>
        <div className="board-type">{c.id.startsWith('w:')?<FileText size={13}/>:<Video size={13}/>} {c.kind}</div>
        {c.thumb && <img className="board-thumb" src={c.thumb} alt="" draggable={false}/>}
        <button className="board-node-title" onClick={()=>open(c.id)}>{c.name}</button><small>{c.description}</small>
        <button className="board-port" title="连接卡片" aria-label={'从 '+c.name+' 连线'} onClick={()=>void port(c.id)}><Plus size={10}/></button>
      </div>)}
    </div>
    <div className="board-zoom"><button aria-label="缩小" onClick={()=>zoom(.8,(viewport.current?.clientWidth||0)/2,(viewport.current?.clientHeight||0)/2)}><Minus size={15}/></button><span>{Math.round(scale*100)}%</span><button aria-label="放大" onClick={()=>zoom(1.25,(viewport.current?.clientWidth||0)/2,(viewport.current?.clientHeight||0)/2)}><Plus size={15}/></button><button aria-label="适应画布" onClick={fit}><Focus size={15}/></button></div>
  </div>;
}
