'use client';

import { AudioLines, ChevronRight, FileText, Film, Image as ImageIcon, LoaderCircle } from 'lucide-react';
import { Button } from './ui/button';
import { Badge, Empty, formatTime } from './ui';
import type { Asset, SearchHit } from '@/shared/types';

const kindLabels = { video: '视频', audio: '音频', image: '图片', document: '文稿' };
const icons = { video: Film, audio: AudioLines, image: ImageIcon, document: FileText };
const sourceLabels = { none: '名称 / 标签', manual: '人工逐字稿', asr: '语音转写', demo: '示例逐字稿' };
export function AssetSearchResults({ hits, query, searching, kind, open }: {
  hits: SearchHit[]; query: string; searching: boolean; kind: string;
  open: (id: string, start?: number | null) => void;
}) {
  const groups = new Map<string, { asset: Asset; hits: SearchHit[] }>();
  for (const hit of hits) {
    if (kind !== 'all' && hit.asset.kind !== kind) continue;
    const group = groups.get(hit.asset.id);
    if (group) group.hits.push(hit); else groups.set(hit.asset.id, { asset: hit.asset, hits: [hit] });
  }
  return <section className="search-results" aria-label="素材搜索结果" aria-busy={searching}>
    <div className="search-results-heading"><h2>搜索结果 <span>「{query}」</span></h2><p>按素材分组，片段按时间排列。点击带时间码的片段可定位原片；最多显示 30 个匹配项。</p></div>
    {searching ? <div className="search-loading" role="status"><LoaderCircle size={20} className="spin" />正在查找素材…</div> : [...groups.values()].map(({ asset, hits: matches }) => {
      const Icon = icons[asset.kind];
      const ordered = matches.toSorted((a, b) => (a.segment?.start ?? Infinity) - (b.segment?.start ?? Infinity));
      return <section className="search-asset-group" key={asset.id} data-asset-id={asset.id} aria-label={`搜索命中素材：${asset.name}`}>
        <div className="search-asset-header"><span className={`search-asset-thumbnail ${asset.kind}`}>{asset.thumbnailKey ? <img src={`/api/files/${asset.id}?thumb=1`} alt="" /> : <Icon size={27} />}</span><div className="search-asset-info"><h3>{asset.name}</h3><div className="search-asset-meta"><span>{kindLabels[asset.kind]}{asset.duration !== null && ` · ${formatTime(asset.duration)}`}</span>{asset.transcriptSource !== 'asr' && <Badge tone="neutral">{sourceLabels[asset.transcriptSource]}</Badge>}<span>{matches.length} 个匹配项</span></div></div><Button type="button" variant="outline" size="sm" onClick={() => open(asset.id)} aria-label={`查看素材：${asset.name}`}>查看素材 <ChevronRight size={14} /></Button></div>
        <ol className="search-segments" aria-label={`${asset.name}的匹配片段`}>{ordered.map((hit, index) => {
          const start = hit.segment?.start ?? null, end = hit.segment?.end ?? null;
          const canLocate = start !== null && !!asset.storageKey && ['video', 'audio'].includes(asset.kind);
          return <li key={index}><Button type="button" variant="ghost" className="search-segment" onClick={() => open(asset.id, start)} aria-label={`${canLocate ? '定位片段' : '查看匹配内容'}：${asset.name} · ${formatTime(start)}`}><span className={`search-segment-time${start === null ? ' untimed' : ''}`}>{start === null ? hit.segment ? '无时间码' : '素材信息匹配' : `${formatTime(start)}${end !== null ? ` – ${formatTime(end)}` : ''}`}</span><span className="search-segment-copy"><span>{hit.segment?.text || asset.tags.join(' · ') || asset.name}</span><small>匹配：{hit.reason}</small></span><span className="search-segment-action">{canLocate ? '定位原片' : '查看内容'}<ChevronRight size={14} /></span></Button></li>;
        })}</ol>
      </section>;
    })}
    {!searching && !groups.size && <Empty title="暂时没有找到匹配内容" text={hits.length ? '当前素材类型没有匹配项，可以切换其他类型，或点击“返回素材列表”。' : '试着换一个说法，或点击“返回素材列表”浏览原有素材。'} />}
  </section>;
}
