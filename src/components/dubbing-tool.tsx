'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, Check, LoaderCircle, X } from 'lucide-react';
import { PersonalDubbing } from './personal-dubbing';
import { Button } from './ui/button';
import type { ProjectToolProps } from './tool-asset-button';
import type { Content, DubbingSnapshot } from '@/shared/types';

export default function DubbingTool({ projectId, assets, contents, saveAsset, workspaceBusy, onSessionExpired }: ProjectToolProps & { contents: Pick<Content, 'id' | 'title' | 'script'>[]; workspaceBusy: boolean; onSessionExpired: () => void }) {
  const [data, setData] = useState<DubbingSnapshot | null>(null), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null), [loadError, setLoadError] = useState('');
  const version = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++version.current, response = await fetch('/api/dubbing-workspace?projectId=' + encodeURIComponent(projectId), { cache: 'no-store' });
    if (response.status === 401) { onSessionExpired(); return; }
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '无法加载个人配音');
    if (current === version.current) { setData(result); setLoadError(''); }
  }, [projectId, onSessionExpired]);
  useEffect(() => { void refresh().catch(e => setLoadError(e.message)); }, [refresh]);
  const active = data && (data.voices.some(v => ['waiting_configuration', 'queued', 'processing', 'deleting'].includes(v.status)) || data.sources.some(s => ['waiting_configuration', 'queued', 'processing'].includes(s.status)) || data.dubbings.some(d => ['queued', 'processing'].includes(d.status)));
  useEffect(() => {
    let running = false;
    const update = () => { if (running || document.hidden) return; running = true; void refresh().catch(() => {}).finally(() => { running = false; }); };
    const timer = active ? setInterval(update, 2500) : undefined;
    window.addEventListener('focus', update); document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [active, refresh]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), notice.error ? 14000 : 6500); return () => clearTimeout(timer); }, [notice]);
  async function perform<T,>(work: () => Promise<T>, message: string): Promise<T | undefined> {
    setBusy(true);
    try { const result = await work(); await refresh(); setNotice({ text: message, error: false }); return result; }
    catch (error) { setNotice({ text: error instanceof Error ? error.message : '操作失败', error: true }); }
    finally { setBusy(false); }
  }
  if (!data) return <div className="section-card row-gap"><AudioLines size={30} /><p>{loadError || '正在准备个人配音…'}</p>{loadError && <Button variant="outline" onClick={() => { void refresh().catch(e => setLoadError(e.message)); }}>重新加载</Button>}</div>;
  return <><PersonalDubbing data={data} busy={busy || workspaceBusy} perform={perform} projectId={projectId} assets={assets} contents={contents} saveAsset={saveAsset} />{notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}><Check size={17} /><span>{notice.text}</span><button onClick={() => setNotice(null)} aria-label="关闭提示"><X size={16} /></button></div>}{busy && <div className="busy-indicator" role="status"><LoaderCircle size={15} className="spin" />正在保存，请稍候…</div>}</>;
}
