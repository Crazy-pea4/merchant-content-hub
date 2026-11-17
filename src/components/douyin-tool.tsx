'use client';
import './douyin.css';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, Copy, Download, FileText, Link2, LoaderCircle, Pencil, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';
import { ToolAssetButton, type ProjectToolProps } from './tool-asset-button';
import { Textarea } from './ui/textarea';
import { Field, FormSelect, formatTime } from './ui';
import { douyinStages, type DouyinExtraction, type DouyinSnapshot } from '@/shared/douyin';

async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch('/api/' + path, { method, cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.status === 401) throw new Error('AUTH_REQUIRED');
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '操作失败'); return result;
}
export default function DouyinTool({ projectId, assets, saveAsset, workspaceBusy, onSessionExpired }: ProjectToolProps & { workspaceBusy: boolean; onSessionExpired: () => void }) {
  const [data, setData] = useState<DouyinSnapshot | null>(null), [busy, setBusy] = useState(false);
  const [shareText, setShareText] = useState(''), [position, setPosition] = useState<DouyinExtraction['position']>('bottom');
  const [selected, setSelected] = useState(''), [notice, setNotice] = useState(''), [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(false), [texts, setTexts] = useState<string[]>([]);
  const submission = useRef<{ signature: string; id: string } | null>(null), version = useRef(0), submitting = useRef(false);
  const refresh = useCallback(async () => {
    const current = ++version.current;
    try { const next: DouyinSnapshot = await request('douyin-workspace?projectId=' + encodeURIComponent(projectId)); if (current !== version.current) return; setData(next); setLoadError(''); setSelected(value => next.jobs.some(j => j.id === value) ? value : next.jobs[0]?.id || ''); }
    catch (error) { if ((error as Error).message === 'AUTH_REQUIRED') onSessionExpired(); else throw error; }
  }, [projectId, onSessionExpired]);
  useEffect(() => { void refresh().catch(e => setLoadError(e.message)); }, [refresh]);
  const active = data?.jobs.some(job => job.status === 'queued' || job.status === 'processing');
  useEffect(() => {
    let pending = false;
    const update = () => { if (pending || document.hidden) return; pending = true; void refresh().catch(e => setLoadError(e.message)).finally(() => { pending = false; }); };
    const timer = active ? setInterval(update, 2000) : undefined;
    window.addEventListener('focus', update); document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [active, refresh]);
  async function perform(work: () => Promise<unknown>, success: string) {
    if (submitting.current) return; submitting.current = true; setBusy(true); setNotice('');
    try { const result = await work(); await refresh(); setNotice(success); return result; }
    catch (error) { if ((error as Error).message === 'AUTH_REQUIRED') onSessionExpired(); else setNotice((error as Error).message); }
    finally { setBusy(false); submitting.current = false; }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); const signature = JSON.stringify({ shareText, position });
    if (submission.current?.signature !== signature) submission.current = { signature, id: crypto.randomUUID() };
    const result = await perform(() => request('douyin-extractions', { requestId: submission.current!.id, projectId: projectId || undefined, shareText, position }), '已加入提取队列，可在下方查看进度') as DouyinExtraction | undefined;
    if (result) { setSelected(result.id); setEditing(false); submission.current = null; }
  }
  const job = data?.jobs.find(job => job.id === selected);
  return <>
    {!data ? <div className="section-card douyin-loading" role="status">{loadError || '正在准备文案提取…'}{loadError && <Button variant="outline" onClick={() => void refresh().catch(e => setLoadError(e.message))}>重新加载</Button>}</div> : <>
      <form className="section-card douyin-input" onSubmit={submit}><div className="section-heading"><h2><Link2 size={18} />从一个链接开始</h2><span className="subtle">支持 5 分钟以内的公开视频</span></div><Field label="抖音分享链接或完整分享文字"><Textarea aria-label="抖音分享链接或完整分享文字" value={shareText} onChange={e => setShareText(e.target.value)} required maxLength={3000} rows={3} placeholder="https://v.douyin.com/… 也可以直接粘贴整段分享文字" /></Field><div className="douyin-submit"><Field label="字幕位置"><FormSelect value={position} onValueChange={value => setPosition(value as DouyinExtraction['position'])}><option value="bottom">画面下方</option><option value="middle">画面中部</option><option value="full">整幅画面</option></FormSelect></Field><Button type="submit" className="primary" disabled={busy || !data.available || !shareText.trim()}>{busy ? <LoaderCircle size={16} className="spin" /> : <FileText size={16} />}提取中文字幕</Button></div><p className="form-note">提取画面上已有的文字。英语配音搭配中文字幕的视频，也会保留原中文字幕。</p>{!data.available && <p className="error-text" role="alert">文案提取服务暂不可用，请联系管理员。</p>}</form>
      {notice && <p className="douyin-notice" role="status">{notice}</p>}{loadError && <p className="error-text" role="alert">{loadError}</p>}
      <div className="douyin-results"><aside className="section-card douyin-history"><div className="section-heading"><h2>提取记录</h2><span className="subtle">{data.jobs.length}</span></div>{!data.jobs.length ? <p className="subtle">第一段文案，从上面的链接开始。</p> : data.jobs.map(item => <button key={item.id} disabled={editing} aria-pressed={item.id === selected} className={item.id === selected ? 'douyin-history-item selected' : 'douyin-history-item'} onClick={() => { setSelected(item.id); setEditing(false); }}><strong>{item.title}</strong><span>{projectId && !item.projectId && '未归属项目 · '}{douyinStages[item.stage] || '等待提取'} · {new Date(item.createdAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' })}</span></button>)}</aside>
      <section className="section-card douyin-result" aria-label="提取文案">{!job ? <div className="douyin-empty"><FileText size={32} /><h2>文案会保存在这里</h2><p>完成后可以校对、复制或下载字幕。</p></div> : <><div className="douyin-result-header"><div><span className="overline">{job.status === 'completed' ? job.reviewStatus === 'reviewed' ? '已校对' : '识别草稿 · 待校对' : douyinStages[job.stage]}</span><h2>{job.title}</h2></div><a href={job.sourceUrl} target="_blank" rel="noopener noreferrer">原视频 <ArrowUpRight size={14} /></a></div>
        {job.status === 'processing' || job.status === 'queued' ? <div className="douyin-progress" role="status"><LoaderCircle className="spin" size={26} /><h3>{douyinStages[job.stage]}</h3><p>任务在后台继续，离开页面后也可以回来查看。</p></div> : job.status === 'failed' ? <div className="douyin-progress"><p className="error-text" role="alert">{job.error}</p><Button variant="outline" disabled={busy || !data.available} onClick={() => void perform(() => request(`douyin-extractions/${job.id}/retry`, {}), '已重新加入队列')}><RefreshCw size={15} />重新提取</Button></div> : <>
          <div className="douyin-result-meta"><span>{formatTime(job.duration)} 视频</span><span>{job.cues.length} 条字幕</span>{job.timings.total !== undefined && <span>提取用时 {job.timings.total.toFixed(1)} 秒</span>}</div>
          {editing ? <form className="douyin-edit" onSubmit={async e => { e.preventDefault(); const result = await perform(() => request(`douyin-extractions/${job.id}`, { revision: job.revision, texts }, 'PATCH'), '校对已保存，下载文件已同步更新'); if (result) setEditing(false); }}>{job.cues.map((cue, index) => <Field key={cue.id} label={`${index + 1}. ${formatTime(cue.start)} — ${formatTime(cue.end)}`}><Textarea aria-label={`第${index + 1}条字幕`} value={texts[index] || ''} onChange={e => setTexts(current => current.map((text, at) => at === index ? e.target.value : text))} maxLength={2000} required rows={2} /></Field>)}<div className="button-row"><Button type="submit" disabled={busy}><Check size={15} />保存校对</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(false)}>取消</Button></div></form> : <><Textarea aria-label="提取的中文字幕" readOnly value={job.text} rows={12} className="douyin-transcript" /><div className="douyin-actions"><ToolAssetButton projectId={projectId} assets={assets} saveAsset={saveAsset} source={{ type: 'douyin', id: job.id, revision: job.revision }} busy={busy || workspaceBusy} /><Button variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(job.text); setNotice('文案已复制'); } catch { setNotice('复制未完成，请在文本框中选择并复制'); } }}><Copy size={15} />复制全文</Button><Button variant="outline" onClick={() => { setTexts(job.cues.map(cue => cue.text)); setEditing(true); }}><Pencil size={15} />校对文案</Button><Button variant="outline" asChild><a href={`/api/douyin-extractions/${job.id}/download?format=txt`} download><Download size={15} />TXT</a></Button><Button variant="outline" asChild><a href={`/api/douyin-extractions/${job.id}/download?format=srt`} download><Download size={15} />SRT</a></Button></div><p className="form-note">识别可能存在错字，建议核对后使用。时间轴精度约为三分之一秒。</p></>}
        </>}
      </>}</section></div>
    </>}
  </>;
}
