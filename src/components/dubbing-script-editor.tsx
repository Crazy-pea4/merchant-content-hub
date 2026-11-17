'use client';
import { useRef, useState } from 'react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { Field, FormSelect } from './ui';
import { MAX_DUBBING_PARTS, MAX_DUBBING_PART_TEXT, effectivePartSettings, type DubbingPart } from '@/shared/dubbing-script';
import { dubbingTones, dubbingToneLabels, dubbingEmotions, dubbingEmotionLabels, dubbingSettingsLabel, type DubbingSettings } from '@/shared/dubbing-settings';

export function DubbingScriptEditor({ parts, selectedId, onSelect, onChange, settings, expressionSupported, disabled }: { parts: DubbingPart[]; selectedId: string; onSelect: (id: string) => void; onChange: (parts: DubbingPart[]) => void; settings: DubbingSettings; expressionSupported: boolean; disabled: boolean }) {
  const index = Math.max(0, parts.findIndex(part => part.id === selectedId)), part = parts[index];
  const editor = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(0), [notice, setNotice] = useState('');
  if (!part) return null;
  function update(patch: Partial<DubbingPart>) { onChange(parts.map((value, i) => i === index ? { ...value, ...patch } : value)); }
  function override(key: keyof DubbingSettings, value: string) {
    const next = { ...part.settings };
    if (value === 'inherit') delete next[key];
    else Object.assign(next, { [key]: key === 'rate' || key === 'pitch' ? Number(value) : value });
    update({ settings: next });
  }
  function split() {
    const cut = editor.current?.selectionStart ?? cursor, left = part.text.slice(0, cut).trim(), right = part.text.slice(cut).trim();
    if (!left || !right || parts.length >= MAX_DUBBING_PARTS) return;
    const second = { ...part, id: crypto.randomUUID(), text: right };
    const next = [...parts]; next.splice(index, 1, { ...part, text: left, pauseAfterMs: 0 }, second); onChange(next); onSelect(second.id); setCursor(0); setNotice('已从光标处分成两句，两句沿用原表达。');
  }
  function merge() {
    const next = parts[index + 1]; if (!next || part.text.length + next.text.length + 1 > MAX_DUBBING_PART_TEXT) return;
    const merged = [...parts]; merged.splice(index, 2, { ...part, text: part.text.trim() + ' ' + next.text.trim(), pauseAfterMs: next.pauseAfterMs }); onChange(merged); setNotice('已与下一句合并，表达沿用当前句，句后停顿沿用原下一句。');
  }
  const rateValue = part.settings?.rate ?? settings.rate;
  return <section className="dubbing-sentence-editor" aria-label="逐句表达编辑器">
    <div className="dubbing-sentence-list" role="group" aria-label="选择配音句子">{parts.map((value, i) => <button type="button" disabled={disabled} aria-pressed={i === index} aria-label={`选择第${i + 1}句`} key={value.id} onClick={() => { onSelect(value.id); setCursor(0); setNotice(''); }}><span>{String(i + 1).padStart(2, '0')}</span><div><p>{value.text || '请输入本句文案'}</p><small>{Object.keys(value.settings || {}).length || value.pauseAfterMs ? `${dubbingSettingsLabel(effectivePartSettings(settings, value))}${value.pauseAfterMs ? ` · 额外停顿 ${value.pauseAfterMs / 1000} 秒` : ''}` : '跟随全篇设置'}</small></div></button>)}</div>
    <div className="dubbing-sentence-settings">
      <strong>第 {index + 1} 句的表达</strong>
      <Field label="本句文案"><Textarea ref={editor} key={part.id} value={part.text} maxLength={MAX_DUBBING_PART_TEXT} rows={3} disabled={disabled} onSelect={event => setCursor(event.currentTarget.selectionStart)} onChange={event => update({ text: event.target.value })} /></Field>
      <div className="button-row"><Button type="button" size="sm" variant="outline" disabled={disabled || cursor <= 0 || cursor >= part.text.length || parts.length >= MAX_DUBBING_PARTS} onClick={split}>从光标处拆分</Button><Button type="button" size="sm" variant="outline" disabled={disabled || index === parts.length - 1 || part.text.length + parts[index + 1]?.text.length + 1 > MAX_DUBBING_PART_TEXT} onClick={merge}>与下一句合并</Button></div>
      <Field label="本句语调"><FormSelect value={part.settings?.tone ?? 'inherit'} onValueChange={value => override('tone', value)} disabled={disabled || !expressionSupported}><option value="inherit">跟随全篇 · {dubbingToneLabels[settings.tone]}</option>{dubbingTones.map(value => <option key={value} value={value}>{dubbingToneLabels[value]}</option>)}</FormSelect></Field>
      <Field label="本句情感"><FormSelect value={part.settings?.emotion ?? 'inherit'} onValueChange={value => override('emotion', value)} disabled={disabled || !expressionSupported}><option value="inherit">跟随全篇 · {dubbingEmotionLabels[settings.emotion]}</option>{dubbingEmotions.map(value => <option key={value} value={value}>{dubbingEmotionLabels[value]}</option>)}</FormSelect></Field>
      <label className="dubbing-sentence-range"><span>本句语速 <output>{rateValue.toFixed(2)} 倍{part.settings?.rate === undefined ? ' · 跟随全篇' : ''}</output></span><input type="range" aria-label="本句语速" min="0.5" max="2" step="0.05" value={rateValue} disabled={disabled} onChange={event => override('rate', event.target.value)} /></label>
      <Field label="本句音高"><FormSelect value={String(part.settings?.pitch ?? 'inherit')} onValueChange={value => override('pitch', value)} disabled={disabled}><option value="inherit">跟随全篇 · {settings.pitch} 倍</option><option value="0.9">稍低 · 0.9 倍</option><option value="1">原始 · 1 倍</option><option value="1.1">稍高 · 1.1 倍</option></FormSelect></Field>
      <Field label="句后增加停顿"><FormSelect value={String(part.pauseAfterMs ?? 0)} onValueChange={value => update({ pauseAfterMs: Number(value) })} disabled={disabled}>{[[0, '自然停顿'], [200, '额外 0.2 秒'], [500, '额外 0.5 秒'], [1000, '额外 1 秒'], [2000, '额外 2 秒'], [3000, '额外 3 秒']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</FormSelect></Field>
      <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => { update({ settings: {}, pauseAfterMs: 0 }); setNotice('本句已恢复跟随全篇设置。'); }}>移除本句标记</Button>
      <p className="form-note">点击句子设置表达；在本句文案中放置光标可以拆分。停顿会在原有自然停顿之后增加。</p>
      <p className="form-note" role="status">{notice}</p>
    </div>
  </section>;
}
