'use client';

import { Film, ArrowUpRight, LoaderCircle } from 'lucide-react';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { Badge } from './ui';
import type { Asset } from '@/shared/types';
import { MAX_CREATION_SOURCES, type CreationReferenceMode } from '@/shared/creation-sources';

function sourceDescription(asset: Asset) {
  if (asset.transcriptSource === 'demo' || !asset.storageKey) return '示例素材 · 使用前请补充门店资料';
  if (asset.segments.some(segment => segment.text.trim())) return asset.kind === 'document' ? '文稿内容可参考' : asset.transcriptSource === 'asr' ? '转写文字可参考' : '已有逐字稿可参考';
  if (asset.transcription && ['queued', 'processing', 'retrying'].includes(asset.transcription.status)) return '转写中 · 暂仅参考名称与标签';
  if (asset.kind === 'image') return '仅参考名称与标签 · 尚未分析画面';
  if (asset.transcription?.status === 'failed') return '转写失败 · 暂仅参考名称与标签';
  if (asset.hasAudio === false) return '无音轨 · 仅参考名称与标签';
  return '暂无逐字稿 · 仅参考名称与标签';
}
export function CreationSources({ eligible, mode, selectedIds, changeMode, select, excludedCount, busy, open }: {
  eligible: Asset[]; mode: CreationReferenceMode; selectedIds: string[];
  changeMode: (mode: CreationReferenceMode) => void; select: (ids: string[]) => void;
  excludedCount: number; busy: boolean; open: (id: string) => void;
}) {
  const selected = new Set(selectedIds), eligibleIds = new Set(eligible.map(asset => asset.id));
  const invalidCount = selectedIds.filter(id => !eligibleIds.has(id)).length;
  const references = mode === 'auto' ? eligible.slice(0, MAX_CREATION_SOURCES) : eligible.filter(asset => selected.has(asset.id));
  const choices = mode === 'auto' ? references : eligible;
  const pending = references.filter(asset => !asset.segments.some(segment => segment.text.trim()) && asset.transcription && ['queued', 'processing', 'retrying'].includes(asset.transcription.status)).length;
  return <section className="creation-sources" aria-label="本次创作参考素材">
    <div className="source-summary"><Film size={16} /><div><strong>{mode === 'manual' ? `已选择 ${selectedIds.length} / ${MAX_CREATION_SOURCES} 份素材` : `本次自动参考 ${references.length} 份素材`}</strong><small>仅当前项目 · 已授权且未过期</small></div><Badge tone="neutral">{mode === 'manual' ? '手动选择' : '自动参考'}</Badge></div>
    <RadioGroup value={mode} onValueChange={value => changeMode(value as CreationReferenceMode)} disabled={busy} className="creation-reference-mode" aria-label="参考素材方式"><label><RadioGroupItem value="manual" /><span>手动选择</span></label><label><RadioGroupItem value="auto" /><span>自动参考</span></label></RadioGroup>
    <p className="creation-source-note">{mode === 'manual' ? '只把勾选的素材发送给 AI，未勾选的素材不会参与本次生成。' : '按项目和授权自动带入最多 30 份素材，不会按内容目标提前筛选相关性。'}</p>
    {mode === 'manual' && <div className="creation-source-actions"><span>共 {eligible.length} 份可选</span><Button type="button" variant="ghost" size="sm" disabled={busy || !eligible.length} onClick={() => select(eligible.slice(0, MAX_CREATION_SOURCES).map(asset => asset.id))}>{eligible.length > MAX_CREATION_SOURCES ? '选择前 30 份' : '全选'}</Button><Button type="button" variant="ghost" size="sm" disabled={busy || !selectedIds.length} onClick={() => select([])}>清空选择</Button></div>}
    {mode === 'manual' && invalidCount > 0 && <div className="creation-source-invalid" role="alert"><p>{invalidCount} 份已选素材已失效，请移除后再生成。</p><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => select(selectedIds.filter(id => eligibleIds.has(id)))}>移除失效选择</Button></div>}
    {choices.length > 0 ? <ul className="creation-source-list" aria-label={mode === 'manual' ? '可选参考素材列表' : '本次参考素材列表'}>{choices.map(asset => <li key={asset.id} className={mode === 'manual' ? `creation-source-choice${selected.has(asset.id) ? ' selected' : ''}` : undefined}>{mode === 'manual' && <Checkbox aria-label={`选择参考素材：${asset.name}`} checked={selected.has(asset.id)} disabled={busy || !selected.has(asset.id) && selectedIds.length >= MAX_CREATION_SOURCES} onCheckedChange={checked => select(checked === true ? [...selectedIds, asset.id] : selectedIds.filter(id => id !== asset.id))} />}<Button type="button" variant="ghost" className="creation-source-item" onClick={() => open(asset.id)} aria-label={`查看参考素材：${asset.name}`}><div><strong>{asset.name}</strong><small>{sourceDescription(asset)}</small></div><ArrowUpRight size={14} /></Button></li>)}</ul> : <p className="creation-source-note">本项目暂无可参考素材，请先上传素材或确认授权。</p>}
    {mode === 'manual' && eligible.length > 0 && !selectedIds.length && <p className="creation-source-empty" role="status">请至少勾选 1 份素材后再生成。</p>}
    {mode === 'manual' && selectedIds.length >= MAX_CREATION_SOURCES && <p className="creation-source-note">每次最多选择 {MAX_CREATION_SOURCES} 份，可取消后换选其他素材。</p>}
    {mode === 'auto' && eligible.length > references.length && <p className="creation-source-note">共有 {eligible.length} 份可用素材，单次最多参考 {MAX_CREATION_SOURCES} 份；要指定其他文件，可切换为手动选择。</p>}
    {excludedCount > 0 && <p className="creation-source-note">另有 {excludedCount} 份待授权或已过期，暂不参与创作。</p>}
    {pending > 0 && <p className="creation-source-pending"><LoaderCircle size={13} className="spin" />{pending} 份参考素材仍在转写，完成后再生成，内容依据会更充分。</p>}
    <p className="creation-source-note">{mode === 'manual' ? '勾选划定允许参考的范围' : '上方名单是本次允许参考的范围'}，每条草稿会单独列出实际引用的素材。</p>
    <p className="creation-source-note">目前参考名称、标签与已有文字，画面内容尚未分析。最终成片在编辑草稿时单独关联。</p>
  </section>;
}
