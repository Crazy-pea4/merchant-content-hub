'use client';
import { useEffect, useRef, useState } from 'react';
import { Headphones, LoaderCircle, Play, X } from 'lucide-react';
import { Button } from './ui/button';
import { DUBBING_PREVIEW_SECONDS } from '@/shared/dubbing-preview';
import { dubbingSettingsLabel, resolveDubbingSettings, type DubbingSettings } from '@/shared/dubbing-settings';
import { previewSpeechPlan, type DubbingPart, type DubbingPreviewScope } from '@/shared/dubbing-script';

type Preview = { signature: string; status: 'loading' | 'ready' | 'error'; url?: string; error?: string };
export function DubbingPreview({ voiceId, text, parts, selectedPartId, settings: inputSettings, disabled, onBusyChange }: { voiceId: string; text: string; parts?: DubbingPart[]; selectedPartId?: string; settings: DubbingSettings; disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const settings = resolveDubbingSettings(inputSettings);
  const [scope, setScope] = useState<DubbingPreviewScope>('opening');
  const signatureFor = (value: DubbingPreviewScope) => JSON.stringify([voiceId, value, parts ? previewSpeechPlan(parts, settings, value, selectedPartId) : [text.trim(), settings]]);
  const signature = signatureFor(scope);
  const latestSignature = useRef(signature); latestSignature.current = signature;
  const [preview, setPreview] = useState<Preview | null>(null);
  const current = preview?.signature === signature ? preview : null;
  const audio = useRef<HTMLAudioElement | null>(null), controller = useRef<{ signature: string; abort: AbortController } | null>(null), version = useRef(0);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const loading = current?.status === 'loading', url = current?.url;
  useEffect(() => { setPreview(value => value?.signature === signature ? value : null); return () => { if (controller.current?.signature === signature) { version.current++; controller.current.abort.abort(); } }; }, [signature]);
  useEffect(() => { onBusyChange(loading); return () => onBusyChange(false); }, [loading, onBusyChange]);
  useEffect(() => {
    if (!url) return;
    const player = audio.current; void player?.play().catch(() => {});
    return () => { player?.pause(); URL.revokeObjectURL(url); };
  }, [url]);
  function cancel() { version.current++; controller.current?.abort.abort(); audio.current?.pause(); setPreview(null); }
  async function listen(nextScope: DubbingPreviewScope = scope) {
    if (disabled || loading) return;
    const nextSignature = signatureFor(nextScope);
    if (preview?.signature === nextSignature && preview.status === 'ready' && audio.current) { audio.current.currentTime = 0; void audio.current.play().catch(() => {}); return; }
    setScope(nextScope); latestSignature.current = nextSignature;
    if (request.current?.signature !== nextSignature || preview?.status === 'error') request.current = { signature: nextSignature, id: crypto.randomUUID() };
    const epoch = ++version.current;
    controller.current?.abort.abort(); const abort = new AbortController(); controller.current = { signature: nextSignature, abort };
    setPreview({ signature: nextSignature, status: 'loading' });
    try {
      const response = await fetch('/api/dubbings/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: request.current.id, voiceId, text: text.trim(), ...settings, ...(parts ? { parts, scope: nextScope, partId: selectedPartId } : {}) }), signal: abort.signal });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || '试听准备失败，请稍后重试'); }
      if (!response.headers.get('content-type')?.startsWith('audio/')) throw new Error('试听没有返回有效音频');
      const blob = await response.blob(); if (!blob.size) throw new Error('试听没有返回有效音频');
      if (epoch !== version.current || latestSignature.current !== nextSignature) return;
      setPreview({ signature: nextSignature, status: 'ready', url: URL.createObjectURL(blob) });
    } catch (failure) {
      if (epoch === version.current) setPreview({ signature: nextSignature, status: 'error', error: failure instanceof Error ? failure.message : '试听准备失败，请稍后重试' });
    }
  }
  return <section className="dubbing-audition" aria-label="生成前试听">
    <div className="dubbing-audition-actions">{(['opening', ...(parts ? ['sentence', 'context'] : [])] as DubbingPreviewScope[]).map(value => <Button key={value} type="button" variant="outline" className="dubbing-preview-button" disabled={disabled || loading || value !== 'opening' && !selectedPartId} onClick={() => void listen(value)}>{loading && scope === value ? <LoaderCircle size={16} className="spin" /> : current?.status === 'ready' && scope === value ? <Play size={16} /> : <Headphones size={16} />}{loading && scope === value ? '正在准备试听…' : current?.status === 'ready' && scope === value ? '再听一次' : value === 'sentence' ? '试听本句' : value === 'context' ? '连听前后句' : `试听前${DUBBING_PREVIEW_SECONDS}秒`}</Button>)}{loading && <Button type="button" variant="ghost" size="sm" onClick={cancel}><X size={14} />取消试听</Button>}</div>
    <p className="form-note">{parts ? '开头试听约 5 秒；本句和前后句试听会读完所选句子。' : `先听开头约 ${DUBBING_PREVIEW_SECONDS} 秒，合适后再生成完整配音。`}试听不加入配音记录，也会使用语音额度。</p>
    {current?.status === 'ready' && current.url && <div className="dubbing-audition-player"><span><Headphones size={13} />{scope === 'opening' ? '当前文案 · 开头试听' : scope === 'sentence' ? `第 ${(parts?.findIndex(part => part.id === selectedPartId) ?? 0) + 1} 句试听` : '当前句与前后句试听'}</span><audio key={signature} ref={audio} aria-label={scope === 'opening' ? '当前文案前5秒试听' : '逐句配音试听'} controls preload="auto" src={current.url} /><small>{parts ? '逐句表达与完整配音共用，未变化的句子可复用试听结果。' : dubbingSettingsLabel(settings)}</small><small>修改本次试听涉及的文案、音色或设置后，可以重新试听。</small></div>}
    {current?.status === 'error' && <p className="dubbing-error" role="alert">{current.error}</p>}
  </section>;
}
