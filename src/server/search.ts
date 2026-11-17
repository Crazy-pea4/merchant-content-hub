import type { Asset, SearchHit, Segment } from '../shared/types';

export function isUsable(asset: Asset) {
  return asset.rights === 'authorized' && (!asset.expiresAt || asset.expiresAt >= new Date().toISOString().slice(0, 10));
}
const concepts = [
  ['老板', '主理人', '店主', '创始人', '访谈', '采访', '口述'],
  ['环境', '空间', '门店', '窗边', '氛围', '空镜'],
  ['制作', '手艺', '过程', '手冲', '操作', '工艺'],
  ['产品', '商品', '菜品', '特写', '出品'],
  ['故事', '创业', '开店', '初衷', '品牌'],
  ['顾客', '客人', '客户', '体验', '评价'],
  ['牛肉', '鲜切', '食材', '火锅'],
  ['理发', '发型', '剪发', '造型'],
];
export function searchAssets(assets: Asset[], query: string): SearchHit[] {
  const q = query.toLowerCase().replace(/[，。！？、的了和与我想找有关镜头视频片段\s]/g, '');
  if (!q) return [];
  const terms = new Set<string>();
  for (const group of concepts) if (group.some(x => q.includes(x))) group.forEach(x => terms.add(x));
  for (const word of query.toLowerCase().split(/[\s，。！？、]+/)) if (word.length >= 2) terms.add(word);
  const grams = [...new Set(Array.from({ length: Math.max(0, q.length - 1) }, (_, i) => q.slice(i, i + 2)))];
  const hits: SearchHit[] = [];
  for (const asset of assets.filter(isUsable)) {
    const base = [asset.name, ...asset.tags, asset.note].join(' ').toLowerCase();
    const candidates: (Segment | null)[] = asset.segments.length ? asset.segments : [null];
    for (const segment of candidates) {
      const text = base + ' ' + (segment?.text || '').toLowerCase();
      const matched = [...terms].filter(t => text.includes(t));
      const score = (text.includes(q) ? 20 : 0) + matched.length * 4 + grams.filter(t => text.includes(t)).length;
      if (score > 0) hits.push({ asset, segment, score, reason: matched.slice(0, 4).join(' · ') || '文字匹配' });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 30);
}

export function parseTranscript(input: string): Segment[] {
  const text = input.trim();
  if (!text) return [];
  const toSec = (s: string) => { const [h, m, sec] = s.replace(',', '.').split(':').map(Number); return h * 3600 + m * 60 + sec; };
  const pattern = /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|$)/g;
  const matches = [...text.matchAll(pattern)];
  if (matches.length) return matches.map(m => ({ start: toSec(m[1]), end: toSec(m[2]), text: m[3].replace(/\n/g, ' ').trim() })).filter(s => s.end! > s.start! && s.text);
  return text.split(/\n+/).map(t => ({ start: null, end: null, text: t.trim() })).filter(s => s.text);
}
export function indexTags(segments: Segment[], existing: string[] = []) {
  const text = segments.map(s => s.text).join('');
  const words = concepts.flat().filter(t => text.includes(t));
  return [...new Set([...existing, ...words])].slice(0, 24);
}
