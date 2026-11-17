'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Background, BackgroundVariant, Handle, Panel, Position, ReactFlow,
  useNodesInitialized, useNodesState, useReactFlow, useViewport,
  type Edge, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Cable, FileText, Focus, Minus, Plus, Unlink, Video } from 'lucide-react';
import type { BoardChange, BoardLink, BoardPoint, StudioSession } from '@/shared/studio';

export interface BoardCard { id: string; name: string; kind: string; description: string; thumb?: string }
type CardNode = Node<{ card: BoardCard; open: (id: string) => void }, 'card'>;
const fitOptions = { minZoom: 0.18, maxZoom: 1, padding: 0.18 };
const ariaLabels = {
  'node.a11yDescription.default': '按回车选择卡片，使用方向键移动，按 Escape 取消选择。',
  'edge.a11yDescription.default': '按回车选择手动连线，可使用「移除关系」按钮删除。',
};
const nodeExtent: [[number, number], [number, number]] = [[-100000, -100000], [100192, 100104]];

function activateHandle(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.click();
  }
}

function Card({ data: { card, open } }: NodeProps<CardNode>) {
  const work = card.id.startsWith('w:');
  return <article className={'board-node' + (work ? ' work' : '')}>
    <Handle type="target" position={Position.Left} className="board-inlet" role="button"
      aria-label={'连接到 ' + card.name} tabIndex={0} onKeyDown={activateHandle}/>
    <div className="board-type">{work ? <FileText size={13}/> : <Video size={13}/>} {card.kind}</div>
    {card.thumb && <img className="board-thumb" src={card.thumb} alt="" draggable={false}/>}
    <button className="board-node-title nodrag nopan" onClick={() => open(card.id)}>{card.name}</button>
    <small>{card.description}</small>
    <Handle type="source" position={Position.Right} className="board-port" role="button" title="连接卡片"
      aria-label={'从 ' + card.name + ' 连线'} tabIndex={0} onKeyDown={activateHandle}><Plus size={10}/></Handle>
  </article>;
}
const nodeTypes = { card: Card };

function layout(cards: BoardCard[], sources: BoardLink[], saved: StudioSession['positions']) {
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
  return cards.map(card => {
    const level = column(card.id), row = nextRow.get(level) || 0;
    nextRow.set(level, row + 1);
    return saved[card.id] || { x: level * 296, y: row * 144 };
  });
}

function ZoomControls({ count }: { count: number }) {
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const { zoom } = useViewport();
  const ready = useNodesInitialized();
  useEffect(() => {
    if (ready && count) void fitView(fitOptions);
  }, [ready, count, fitView]);
  return <Panel position="bottom-right" className="board-zoom">
    <button aria-label="缩小" onClick={() => void zoomOut()}><Minus size={15}/></button>
    <span>{Math.round(zoom * 100)}%</span>
    <button aria-label="放大" onClick={() => void zoomIn()}><Plus size={15}/></button>
    <button aria-label="适应画布" onClick={() => void fitView(fitOptions)}><Focus size={15}/></button>
  </Panel>;
}

export default function StudioBoard({ session, cards, sources, save, open, add }: {
  session: StudioSession; cards: BoardCard[]; sources: BoardLink[];
  save: (change: BoardChange) => Promise<boolean>; open: (id: string) => void; add: () => void;
}) {
  const moving = useRef(new Map<string, BoardPoint>());
  const [selectedEdge, setSelectedEdge] = useState('');
  const [connecting, setConnecting] = useState(false);
  const writes = useRef(Promise.resolve());
  const baseNodes = useMemo(() => {
    const positions = layout(cards, sources, session.positions);
    return cards.map((card, i): CardNode => ({
      id: card.id, type: 'card', data: { card, open }, position: positions[i],
      width: 192, height: 104, deletable: false, ariaLabel: card.name,
    }));
  }, [cards, sources, session.positions, open]);
  const [nodes, setNodes, applyNodeChanges] = useNodesState(baseNodes);
  const persistedNodes = useRef(baseNodes);
  useEffect(() => {
    persistedNodes.current = baseNodes;
    setNodes(current => {
      const previous = new Map(current.map(node => [node.id, node]));
      return baseNodes.map(node => ({
        ...previous.get(node.id), ...node, position: moving.current.get(node.id) || node.position,
      }));
    });
  }, [baseNodes, setNodes]);

  const edges = useMemo(() => {
    const ids = new Set(cards.map(card => card.id));
    const result = new Map<string, Edge>();
    function addEdge({ from, to }: BoardLink, manual: boolean) {
      const id = JSON.stringify([from, to]);
      if (!ids.has(from) || !ids.has(to) || result.has(id)) return;
      result.set(id, { id, source: from, target: to, className: manual ? 'manual' : 'automatic',
        selectable: manual, focusable: manual, selected: manual && selectedEdge === id, deletable: false });
    }
    sources.forEach(link => addEdge(link, false));
    session.links.forEach(link => addEdge(link, true));
    return Array.from(result.values());
  }, [cards, sources, session.links, selectedEdge]);
  const selected = edges.find(edge => edge.selected);

  function moveNodes(changes: NodeChange<CardNode>[]) {
    applyNodeChanges(changes);
    for (const change of changes) {
      if (change.type !== 'position' || !change.position) continue;
      const { id, position } = change;
      moving.current.set(id, position);
      if (change.dragging) continue;
      // Serialize completed moves so a slow save cannot undo a newer drag.
      writes.current = writes.current.then(async () => {
        const saved = await save({ action: 'move', node: id, x: Math.round(position.x), y: Math.round(position.y) });
        if (moving.current.get(id) !== position) return;
        moving.current.delete(id);
        if (!saved) {
          const original = persistedNodes.current.find(node => node.id === id);
          if (original) setNodes(current => current.map(node => node.id === id ? { ...node, position: original.position } : node));
        }
      });
    }
  }

  return <div className="studio-board">
    <ReactFlow<CardNode> aria-label="素材关系画布" nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      fitView fitViewOptions={fitOptions} ariaLabelConfig={ariaLabels}
      minZoom={0.18} maxZoom={2.5} nodeExtent={nodeExtent} attributionPosition="bottom-left"
      deleteKeyCode={null} multiSelectionKeyCode={null} selectionKeyCode={null} edgesReconnectable={false}
      onNodesChange={moveNodes}
      onEdgesChange={changes => {
        for (const c of changes) if (c.type === 'select') {
          setSelectedEdge(current => c.selected ? c.id : current === c.id ? '' : current);
        }
      }}
      isValidConnection={({ source, target }) => source !== target && !edges.some(e => e.source === source && e.target === target)}
      onConnect={({ source, target }) => { void save({ action: 'connect', from: source, to: target }); }}
      onClickConnectStart={() => setConnecting(true)} onClickConnectEnd={() => setConnecting(false)}>
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#bcbdb0"/>
      <Panel position="top-left" className="board-tools">
        <button onClick={add}><Plus size={16}/>加入素材</button>
        {connecting && <span role="status">选择另一张卡片的连接点，或点击空白处取消</span>}
        {selected && <button onClick={async () => {
          if (await save({ action: 'disconnect', from: selected.source, to: selected.target })) setSelectedEdge('');
        }}><Unlink size={14}/>移除关系</button>}
      </Panel>
      <ZoomControls count={nodes.length}/>
    </ReactFlow>
    {!cards.length && <div className="board-empty"><Cable size={32}/><h3>把素材放上画布</h3>
      <p>剧本生成后，引用的素材会自动连到作品上。</p><button onClick={add}>选择素材</button>
    </div>}
  </div>;
}
