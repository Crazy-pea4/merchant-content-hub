'use client';
import './narration.css';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AudioLines, Check, Clapperboard, Download, Headphones, LoaderCircle, Play, RefreshCw, Sparkles, Upload, X } from 'lucide-react';
import { Brand } from './brand';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Badge, Empty, Field, FormSelect, formatTime } from './ui';
import { narrationSegmentIdentity, narrationStyles, mergeNarrationSegments, splitNarrationSegment, type NarrationProject, type NarrationRender, type NarrationSegment, type NarrationSnapshot } from '@/shared/narration';
import { readNarrationDraft } from '@/shared/narration-draft';
import { validNarrationTimeline } from '@/shared/narration-draft';
import { currentNarrationTranslation, editableNarrationTranslation } from '@/shared/narration-captions';
import { dubbingEmotions, dubbingEmotionLabels, dubbingTones, dubbingToneLabels, supportsDubbingExpression } from '@/shared/dubbing-settings';

async function request(path: string, body?: unknown, method = 'POST') {
  const response = await fetch('/api/' + path, { method, headers: body instanceof FormData || body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '操作未完成，请稍后再试'); return data;
}
type Perform = <T>(work: () => Promise<T>, message: string) => Promise<T | undefined>;
export default function NarrationTool() {
  const [data, setData] = useState<NarrationSnapshot | null>(null), [auth, setAuth] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null), [selected, setSelected] = useState(''), [voiceId, setVoiceId] = useState('');
  const [language, setLanguage] = useState('zh'), [style, setStyle] = useState('natural'), [subtitleMode, setSubtitleMode] = useState('bilingual');
  const uploadId = useRef<string | null>(null), uploading = useRef(false), sequence = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++sequence.current, response = await fetch('/api/narration-workspace', { cache: 'no-store' });
    if (response.status === 401) { setAuth(true); return; }
    const value = await response.json(); if (!response.ok) throw new Error(value.error || '无法加载视频旁白');
    if (version === sequence.current) { setData(value); setAuth(false); setError(''); }
  }, []);
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [refresh]);
  useEffect(() => { if (data && !data.projects.some(p => p.id === selected)) setSelected(data.projects[0]?.id || ''); if (data && !data.voices.some(v => v.id === voiceId && v.status === 'ready')) setVoiceId(data.voices.find(v => v.status === 'ready')?.id || ''); }, [data, selected, voiceId]);
  const active = !!data && (data.projects.some(p => ['queued', 'analyzing'].includes(p.status) || p.status === 'ready' && p.autoRenderPending) || data.renders.some(r => ['queued', 'processing'].includes(r.status)));
  useEffect(() => {
    let pending = false;
    const update = () => { if (pending || document.hidden) return; pending = true; void refresh().catch(() => {}).finally(() => { pending = false; }); };
    const timer = active ? setInterval(update, 2000) : undefined;
    window.addEventListener('focus', update); return () => { clearInterval(timer); window.removeEventListener('focus', update); };
  }, [active, refresh]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), notice.error ? 15000 : 6000); return () => clearTimeout(timer); }, [notice]);
  const perform: Perform = async (work, message) => {
    setBusy(true); try { const result = await work(); await refresh(); setNotice({ text: message, error: false }); return result; }
    catch (e) { setNotice({ text: e instanceof Error ? e.message : '操作失败', error: true }); } finally { setBusy(false); }
  };
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (uploading.current) return; uploading.current = true;
    const element = event.currentTarget, form = new FormData(element);
    form.set('voiceId', voiceId); form.set('language', language); form.set('style', style); form.set('subtitleMode', subtitleMode); form.set('requestId', uploadId.current ||= crypto.randomUUID());
    try {
      const result = await perform<NarrationProject>(() => request('narrations', form), '视频已保存，系统将分析画面并自动制作第一版成片');
      if (result) { setSelected(result.id); uploadId.current = null; element.reset(); }
    } finally { uploading.current = false; }
  }
  if (auth) return <div className="auth-screen"><div className="auth-card"><Brand/><h1>视频旁白</h1><p>输入此站点的访问口令后继续。</p><form onSubmit={event => { event.preventDefault(); const token = String(new FormData(event.currentTarget).get('token')); void perform(() => request('session', { token }), '已进入视频旁白'); }}><Field label="访问口令"><Input type="password" name="token" required /></Field><Button type="submit" disabled={busy}>进入视频旁白</Button></form>{notice && <p role="alert">{notice.text}</p>}</div></div>;
  if (!data) return <div className="loading-screen"><Clapperboard size={30} /><p>{error || '正在准备视频旁白…'}</p>{error && <Button onClick={() => void refresh().catch(e => setError(e.message))}>重新加载</Button>}</div>;
  const project = data.projects.find(p => p.id === selected), readyVoices = data.voices.filter(v => v.status === 'ready');
  return <div className="narration-screen"><header className="narration-header"><a href="/" className="narration-brand" aria-label="返回个人创作室"><Brand/></a><a href="/?tab=dubbing"><AudioLines size={16} />我的音色与配音</a></header><main className="narration-main">
    <section className="narration-intro"><div><h1>视频旁白</h1><p>上传视频，自动理解画面、编写旁白并制作成片。文案和表达，都可以逐段调整。</p></div><div className="narration-steps"><span>01 上传视频</span><i>→</i><span>02 自动制作</span><i>→</i><span>03 预览导出</span></div></section>
    <section className="narration-upload-card" aria-label="上传旁白视频"><form onSubmit={upload} onChange={() => { uploadId.current = null; }}>
      <div className="narration-upload-file"><Upload size={25} /><Field label="选择视频" hint={`MP4 / MOV / WebM，最大 ${data.capabilities.maxUploadMB} MB，2 秒至 ${data.capabilities.maxSeconds / 60} 分钟。没有原声也可以。`}><Input name="file" type="file" accept=".mp4,.mov,.webm" required disabled={busy} /></Field></div>
      <div className="narration-upload-options"><Field label="旁白音色"><FormSelect value={voiceId} onValueChange={setVoiceId} disabled={busy}><option value="">请选择自己的音色</option>{readyVoices.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</FormSelect></Field><Field label="旁白语言"><FormSelect value={language} onValueChange={setLanguage} disabled={busy}><option value="zh">中文</option><option value="en">English</option></FormSelect></Field><Field label="讲述风格"><FormSelect value={style} onValueChange={setStyle} disabled={busy}>{Object.entries(narrationStyles).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</FormSelect></Field><Field label="字幕样式"><FormSelect value={subtitleMode} onValueChange={setSubtitleMode} disabled={busy}><option value="bilingual">中英双语 · 写入画面</option><option value="original">仅朗读原文字幕</option></FormSelect></Field></div>
      <div className="narration-upload-bottom"><p>画面将交给云端理解，使用你已保存的音色自动配音。首次制作会使用视频理解与语音服务额度。</p><Button className="primary" type="submit" disabled={busy || !voiceId || !data.capabilities.vision || !data.capabilities.tts || !data.capabilities.media}>{busy ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}自动制作视频旁白</Button></div>
    </form>{!readyVoices.length && <p className="narration-hint">还没有可用音色。<a href="/dubbing">先录制并保存自己的音色 →</a></p>}{(!data.capabilities.vision || !data.capabilities.tts || !data.capabilities.media) && <p role="status" className="narration-error">{!data.capabilities.vision ? '视频理解服务尚未连接。' : !data.capabilities.tts ? '语音服务尚未连接。' : '视频处理服务暂不可用。'}请联系管理员完成连接后制作。</p>}</section>
    {data.projects.length > 0 && <section className="narration-projects" aria-label="选择旁白视频">{data.projects.map(p => <button key={p.id} type="button" aria-pressed={p.id === selected} onClick={() => setSelected(p.id)}><Clapperboard size={16} /><span>{p.title}</span><small>{formatTime(p.duration)}</small>{['queued', 'analyzing'].includes(p.status) && <LoaderCircle size={14} className="spin" />}</button>)}</section>}
    {project ? project.status === 'ready' ? <NarrationEditor key={project.id} project={project} renders={data.renders.filter(r => r.projectId === project.id)} voices={readyVoices} busy={busy} perform={perform} /> : <section className="narration-pending"><video controls preload="metadata" src={`/api/narration-files/${project.id}?source`} /><div>{project.status === 'failed' ? <><h2>画面分析暂未完成</h2><p role="alert">{project.error}</p><Button variant="outline" disabled={busy} onClick={() => void perform(() => request(`narrations/${project.id}/retry`), '已重新提交画面分析')}><RefreshCw size={15} />重试分析</Button></> : <><LoaderCircle size={28} className="spin" /><h2>{project.stage}</h2><p>正在为画面安排旁白。关闭页面后任务仍会继续，完成后会保存分镜和成片。</p></>}</div></section> : <div className="narration-empty"><Empty title="从一段视频开始" text="风景、日常、旅途或一段创作，让画面成为故事的起点。" /></div>}
  </main>{notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}><Check size={17} /><span>{notice.text}</span><button aria-label="关闭提示" onClick={() => setNotice(null)}><X size={16} /></button></div>}</div>;
}

function NarrationEditor({ project, renders, voices, busy, perform }: { project: NarrationProject; renders: NarrationRender[]; voices: NarrationSnapshot['voices']; busy: boolean; perform: Perform }) {
  const [draft, setDraft] = useState({ revision: project.revision, title: project.title, shots: project.shots, segments: project.segments }), [selected, setSelected] = useState(project.segments[0]?.id || ''), [voiceId, setVoiceId] = useState(renders[0]?.voiceId || project.voiceId), [originalVolume, setOriginalVolume] = useState(renders[0]?.originalVolume ?? 0), [subtitleMode, setSubtitleMode] = useState<'original' | 'bilingual'>('bilingual');
  const editedTranslations = useRef(new Set<string>());
  const [restored, setRestored] = useState(false), [storageError, setStorageError] = useState(false), [previewId, setPreviewId] = useState(''), [showSource, setShowSource] = useState(true);
  const [audition, setAudition] = useState<{ signature: string; url?: string; loading?: boolean; error?: string } | null>(null);
  const video = useRef<HTMLVideoElement>(null), previewAbort = useRef<AbortController | null>(null), generation = useRef<{ signature: string; id: string } | null>(null), generating = useRef(false), auditionRequest = useRef<{ signature: string; id: string } | null>(null);
  const draftKey = `video-narration-draft:v1:${project.id}`;
  useEffect(() => {
    try { const saved = readNarrationDraft(localStorage.getItem(draftKey)); if (saved && saved.revision === project.revision && JSON.stringify(saved.shots.map(s => [s.id, s.start, s.end])) === JSON.stringify(project.shots.map(s => [s.id, s.start, s.end])) && validNarrationTimeline(saved.segments, project.duration)) { setDraft(saved); if (saved.subtitleMode) setSubtitleMode(saved.subtitleMode); if (saved.voiceId && voices.some(v => v.id === saved.voiceId)) setVoiceId(saved.voiceId); if (saved.originalVolume !== undefined) setOriginalVolume(saved.originalVolume); const selectedId = saved.selectedSegmentId ?? saved.selectedShotId; if (saved.segments.some(s => s.id === selectedId)) setSelected(selectedId!); for (const segment of saved.segments) if (segment.translation?.lines.some(line => line.text.trim()) && JSON.stringify(segment.translation) !== JSON.stringify(project.segments.find(s => s.id === segment.id)?.translation)) editedTranslations.current.add(segment.id); } }
    catch { setStorageError(true); }
    setRestored(true);
  }, [draftKey]);
  useEffect(() => { if (restored) try { localStorage.setItem(draftKey, JSON.stringify({ ...draft, voiceId: voiceId || undefined, originalVolume, subtitleMode, selectedSegmentId: selected })); } catch { setStorageError(true); } }, [draft, voiceId, originalVolume, subtitleMode, selected, restored, draftKey]);
  useEffect(() => {
    if (!restored) return;
    setDraft(d => {
      let changed = false;
      const segments = d.segments.map(segment => {
        const saved = project.segments.find(s => s.id === segment.id && s.text === segment.text);
        if (editedTranslations.current.has(segment.id) || currentNarrationTranslation(segment, project.language) || !saved || !currentNarrationTranslation(saved, project.language)) return segment;
        const translation = editableNarrationTranslation(segment, project.language);
        translation.lines = translation.lines.map(line => ({ ...line, text: line.text || saved.translation!.lines.find(v => v.source === line.source)?.text || '' }));
        if (JSON.stringify(segment.translation) === JSON.stringify(translation)) return segment;
        changed = true; return { ...segment, translation };
      });
      return changed ? { ...d, segments } : d;
    });
  }, [project.segments, project.language, restored]);
  const dirty = draft.title !== project.title || JSON.stringify(narrationSegmentIdentity(draft.segments)) !== JSON.stringify(narrationSegmentIdentity(project.segments));
  useEffect(() => { if (restored && !dirty && draft.revision !== project.revision) setDraft({ revision: project.revision, title: project.title, shots: project.shots, segments: project.segments }); }, [restored, dirty, draft.revision, project.revision, project.title, project.shots, project.segments]);
  const shot = draft.segments.find(s => s.id === selected) || draft.segments[0], index = draft.segments.indexOf(shot), selectedVoice = voices.find(v => v.id === voiceId);
  const coveredShots = shot ? project.shots.filter(s => s.end > shot.start && s.start < shot.end) : [];
  useEffect(() => { if (selectedVoice && !supportsDubbingExpression(selectedVoice.model)) setDraft(d => ({ ...d, segments: d.segments.map(s => ({ ...s, settings: { ...s.settings, tone: 'natural', emotion: 'neutral' } })) })); }, [selectedVoice?.id, selectedVoice?.model]);
  const signature = JSON.stringify([voiceId, shot?.id, shot?.text.trim(), shot?.settings]);
  const latestSignature = useRef(signature); latestSignature.current = signature;
  useEffect(() => { previewAbort.current?.abort(); setAudition(null); }, [signature]);
  useEffect(() => { const url = audition?.url; return () => { if (url) URL.revokeObjectURL(url); }; }, [audition?.url]);
  useEffect(() => () => previewAbort.current?.abort(), []);
  const completed = renders.filter(r => r.status === 'completed'), latest = completed[0];
  useEffect(() => { if (latest) { setPreviewId(latest.id); setShowSource(false); } }, [latest?.id]);
  const rendered = completed.find(r => r.id === previewId) || latest, running = renders.find(r => ['queued', 'processing'].includes(r.status));
  function edit(patch: Partial<NarrationSegment>) { setDraft(d => ({ ...d, segments: d.segments.map(s => s.id === shot.id ? { ...s, ...patch } : s) })); }
  async function save() {
    const saved = await request(`narrations/${project.id}`, { revision: draft.revision, title: draft.title, segments: draft.segments.map(s => ({ ...s, text: s.text.trim() })) }, 'PATCH') as NarrationProject;
    setDraft({ revision: saved.revision, title: saved.title, shots: saved.shots, segments: saved.segments }); return saved;
  }
  async function generate() {
    if (generating.current) return; generating.current = true;
    try {
      await perform(async () => {
        editedTranslations.current.clear();
        const saved = await save(), payload = { revision: saved.revision, voiceId, originalVolume, subtitleMode }, signature = JSON.stringify(payload);
        if (generation.current?.signature !== signature) generation.current = { signature, id: crypto.randomUUID() };
        return request(`narrations/${project.id}/renders`, { ...payload, requestId: generation.current.id });
      }, '旁白已保存，新版本成片正在制作');
    } finally { generating.current = false; }
  }
  async function listen() {
    if (!shot.text.trim() || !selectedVoice || audition?.loading) return;
    if (auditionRequest.current?.signature !== signature || audition?.error) auditionRequest.current = { signature, id: crypto.randomUUID() };
    const abort = new AbortController(); previewAbort.current?.abort(); previewAbort.current = abort; setAudition({ signature, loading: true });
    try {
      const text = shot.text.trim(), response = await fetch('/api/dubbings/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: auditionRequest.current.id, voiceId, text, ...shot.settings, parts: [{ id: shot.id, text, settings: shot.settings }], scope: 'sentence', partId: shot.id }), signal: abort.signal });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || '试听未完成'); }
      const blob = await response.blob(); if (!blob.size || !response.headers.get('content-type')?.startsWith('audio/')) throw new Error('试听音频无效');
      if (!abort.signal.aborted && latestSignature.current === signature) setAudition({ signature, url: URL.createObjectURL(blob) });
    } catch (e) { if (!abort.signal.aborted && latestSignature.current === signature) setAudition({ signature, error: e instanceof Error ? e.message : '试听未完成' }); }
  }
  if (!shot) return null;
  return <section className="narration-editor" aria-label="编辑视频旁白"><div className="narration-preview-column"><div className="narration-video-card"><div className="narration-card-heading"><h2>视频预览</h2><div><Button type="button" size="sm" variant={showSource ? 'default' : 'outline'} onClick={() => setShowSource(true)}>原视频</Button><Button type="button" size="sm" variant={!showSource ? 'default' : 'outline'} disabled={!rendered} onClick={() => setShowSource(false)}>旁白成片</Button></div></div><video key={showSource ? project.id : rendered?.id} ref={video} controls playsInline preload="metadata" aria-label="视频旁白预览" src={showSource || !rendered ? `/api/narration-files/${project.id}?source` : `/api/narration-files/${rendered.id}`}>
      {!showSource && rendered && !rendered.burnedCaptions && <track kind="captions" label={project.language === 'zh' ? '中文旁白' : 'English narration'} srcLang={project.language} src={`/api/narration-files/${rendered.id}?captions`} default />}
    </video><p className="narration-hint">{showSource ? '原视频未添加新旁白。选择分镜可以定位画面。' : `成片使用已保存的第 ${rendered?.revision} 版旁白。修改文案后需重新生成。`}</p>
      {rendered && <div className="narration-downloads"><Button variant="outline" asChild><a href={`/api/narration-files/${rendered.id}?download`} download><Download size={15} />下载 MP4</a></Button><Button variant="ghost" size="sm" asChild><a href={`/api/narration-files/${rendered.id}?captions&download`} download>下载旁白字幕</a></Button></div>}
      {rendered?.hasCleanVideo && <details className="narration-edit-downloads"><summary>字幕与剪辑文件</summary><p className="narration-hint">MP4里的字已写入画面；后期改字请使用无字幕成片和SRT。SRT保留文字与时间轴，字体和位置可在剪辑软件里设置。无字幕版本仅去掉本工具新增字幕，原视频自带文字仍保留。</p><div className="narration-downloads"><Button variant="outline" size="sm" asChild><a href={`/api/narration-files/${rendered.id}?clean&download`} download>下载无字幕成片</a></Button>{(['zh', 'en', 'bilingual'] as const).map(track => <Button key={track} variant="ghost" size="sm" asChild><a href={`/api/narration-files/${rendered.id}?captions&format=srt&track=${track}&download`} download>{track === 'zh' ? '中文 SRT' : track === 'en' ? '英文 SRT' : '双语 SRT'}</a></Button>)}</div></details>}
    </div><div className="narration-settings-card"><Field label="成片名称"><Input value={draft.title} maxLength={120} onChange={e => setDraft({ ...draft, title: e.target.value })} /></Field><Field label="成片字幕样式" hint="双语字幕会写入视频画面，中文在上、英文在下。"><FormSelect value={subtitleMode} onValueChange={v => setSubtitleMode(v as 'original' | 'bilingual')}><option value="bilingual">中英双语 · 白字黑描边</option><option value="original">仅朗读原文字幕</option></FormSelect></Field><Field label="成片使用的音色"><FormSelect value={voiceId} onValueChange={setVoiceId}><option value="">请选择可用音色</option>{voices.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</FormSelect></Field><Field label="原视频声音" hint="包含原有对话、音乐和环境声；0% 表示仅使用新旁白。"><FormSelect value={String(originalVolume)} onValueChange={v => setOriginalVolume(Number(v))}><option value="0">关闭 · 0%</option><option value="0.1">轻微保留 · 10%</option><option value="0.25">保留 · 25%</option><option value="0.5">保留 · 50%</option><option value="1">原始音量 · 100%</option></FormSelect></Field><Button className="primary full" disabled={busy || !!running || !selectedVoice || !draft.title.trim() || !draft.segments.some(s => s.text.trim()) || !!audition?.loading} onClick={() => void generate()}><Sparkles size={16} />{running ? '正在制作成片…' : '保存修改并生成成片'}</Button><p className="narration-hint">一句话可以跨多个镜头，留白最多2秒。按实际朗读时长安排节奏，可适度放慢或加快；文案过短或过长时会提示调整。已完成的声音片段可复用。</p></div>
      {(project.error || running) && <div className="narration-progress" role="status">{running ? <><LoaderCircle size={16} className="spin" /><span>{running.stage}</span><small>{running.completedShots} / {running.segments.length}</small></> : <p>{project.error}</p>}</div>}
      {renders.length > 0 && <details className="narration-versions" open><summary>成片版本 · {renders.length}</summary>{renders.map(r => <article key={r.id}><div><strong>{r.title}</strong><small>旁白第 {r.revision} 版 · {r.voiceName} · {r.stage}</small></div>{r.status === 'completed' ? <Button size="sm" variant="outline" onClick={() => { setPreviewId(r.id); setShowSource(false); }}>预览此版</Button> : r.status === 'failed' ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform(() => request(`narration-renders/${r.id}/retry`), '已重新排队，继续未完成部分')}>继续生成</Button> : <LoaderCircle size={16} className="spin" />}{r.error && <p role="alert" className="narration-error">{r.error}</p>}</article>)}</details>}
    </div><div className="narration-script-column"><div className="narration-card-heading"><div><h2>旁白文案 <span>{draft.segments.length} 段</span></h2><p>{storageError ? '本机草稿保存不可用，请及时保存旁白' : dirty ? '修改已保存在本机，尚未应用到成片' : '旁白已保存'} · 第 {draft.revision} 版</p></div><Button size="sm" variant="outline" disabled={busy || !dirty} onClick={() => void perform(save, '旁白已保存，已有成片保持原版本')}><Check size={14} />保存旁白</Button></div>
      {project.summary && <p className="narration-summary">{project.summary}</p>}
      {project.revision !== draft.revision && dirty && <p className="narration-error" role="alert">其他页面已更新旁白。<Button variant="link" size="sm" onClick={() => setDraft({ revision: project.revision, title: project.title, shots: project.shots, segments: project.segments })}>加载最新旁白</Button></p>}
      <p className="narration-hint">按完整意思组织旁白，一段可以覆盖多个镜头。参考时间用于安排节奏，生成时会按实际声音长度衔接。</p>
      <div className="narration-shot-list narration-segment-list" aria-label="旁白段落列表">{draft.segments.map((s, i) => {
        const scenes = project.shots.filter(scene => scene.end > s.start && scene.start < s.end);
        return <button key={s.id} type="button" aria-label={`选择旁白${i + 1}`} aria-pressed={s.id === shot.id} onClick={() => { setSelected(s.id); if (video.current) video.current.currentTime = s.start; }}>{scenes[0] && <img loading="lazy" src={`/api/narration-files/${project.id}?frame=${scenes[0].id}`} alt={`旁白 ${i + 1} 对应的画面`} />}<div><span>第 {i + 1} 段 <time>{s.start.toFixed(1)} – {s.end.toFixed(1)} 秒</time></span><p>{s.text || '留白 · 不添加旁白'}</p><small>覆盖 {scenes.length} 个镜头</small></div><Play size={13} /></button>;
      })}</div>
      <section className="narration-shot-editor" aria-label="旁白文案编辑"><div className="narration-card-heading"><h3>第 {index + 1} 段旁白</h3><Badge>覆盖 {coveredShots.length} 个镜头</Badge></div>
        <div className="narration-segment-actions"><Button size="sm" variant="outline" disabled={!mergeNarrationSegments(draft.segments, index)} onClick={() => { const segments = mergeNarrationSegments(draft.segments, index); if (segments) setDraft({ ...draft, segments }); }}>合并下一段</Button><Button size="sm" variant="outline" disabled={shot.text.trim().length < 2 || shot.end - shot.start < 0.2 || draft.segments.length >= 60} onClick={() => { const segments = splitNarrationSegment(draft.segments, index, crypto.randomUUID()); if (segments) setDraft({ ...draft, segments }); }}>拆为两段</Button><Button size="sm" variant="ghost" disabled={draft.segments.length <= 1} onClick={() => { const segments = draft.segments.filter(s => s.id !== shot.id); setSelected(segments[Math.min(index, segments.length - 1)].id); setDraft({ ...draft, segments }); }}>删除本段</Button></div>
        <div className="narration-segment-times"><Field label="参考开始时间（秒）"><Input type="number" step="0.1" min={draft.segments[index - 1]?.end ?? 0} max={shot.end - 0.05} value={shot.start} onChange={e => { if (Number.isFinite(e.target.valueAsNumber)) edit({ start: Number(Math.max(draft.segments[index - 1]?.end ?? 0, Math.min(shot.end - 0.05, e.target.valueAsNumber)).toFixed(3)) }); }} /></Field><Field label="参考结束时间（秒）"><Input type="number" step="0.1" min={shot.start + 0.05} max={draft.segments[index + 1]?.start ?? project.duration} value={shot.end} onChange={e => { if (Number.isFinite(e.target.valueAsNumber)) edit({ end: Number(Math.min(draft.segments[index + 1]?.start ?? project.duration, Math.max(shot.start + 0.05, e.target.valueAsNumber)).toFixed(3)) }); }} /></Field></div>
        <Field label="旁白文案" hint="可以连续讲述多个镜头，不受单个镜头字数限制。每段最多500字符，留空则不生成本段声音。"><Textarea rows={4} maxLength={500} value={shot.text} onChange={e => edit({ text: e.target.value })} /></Field>
        {subtitleMode === 'bilingual' && shot.text.trim() && <section className="narration-translation" aria-label="字幕译文"><h3>{project.language === 'zh' ? '英文译文' : '中文字幕译文'}</h3><p className="narration-hint">按短句对应。未填写的译文会在生成成片时自动翻译；修改译文可复用配音。{shot.translation && shot.translation.sourceText !== shot.text.trim() ? ' 原文已修改，请核对保留的译文。' : ''}</p>{editableNarrationTranslation(shot, project.language).lines.map((line, lineIndex) => <Field key={`${shot.id}:${lineIndex}`} label={`第 ${lineIndex + 1} 句${project.language === 'zh' ? '英文' : '中文'}译文`} hint={line.source}><Textarea rows={2} maxLength={1200} value={line.text} placeholder="生成时自动翻译，也可以直接填写" onChange={event => { const translation = editableNarrationTranslation(shot, project.language); translation.lines[lineIndex] = { ...translation.lines[lineIndex], text: event.target.value }; editedTranslations.current.add(shot.id); edit({ translation }); }} /></Field>)}</section>}
        <div className="narration-expression"><Field label="本段语调"><FormSelect value={shot.settings.tone} disabled={!selectedVoice || !supportsDubbingExpression(selectedVoice.model)} onValueChange={tone => edit({ settings: { ...shot.settings, tone: tone as NarrationSegment['settings']['tone'] } })}>{dubbingTones.map(v => <option key={v} value={v}>{dubbingToneLabels[v]}</option>)}</FormSelect></Field><Field label="本段情感"><FormSelect value={shot.settings.emotion} disabled={!selectedVoice || !supportsDubbingExpression(selectedVoice.model)} onValueChange={emotion => edit({ settings: { ...shot.settings, emotion: emotion as NarrationSegment['settings']['emotion'] } })}>{dubbingEmotions.map(v => <option key={v} value={v}>{dubbingEmotionLabels[v]}</option>)}</FormSelect></Field><Field label="本段语速"><FormSelect value={String(shot.settings.rate)} onValueChange={rate => edit({ settings: { ...shot.settings, rate: Number(rate) } })}>{[...new Set([0.75, 1, 1.25, 1.5, shot.settings.rate])].sort().map(v => <option key={v} value={String(v)}>{v} 倍</option>)}</FormSelect></Field></div>
        <Button variant="outline" disabled={!shot.text.trim() || !selectedVoice || !!audition?.loading || busy} onClick={() => void listen()}>{audition?.loading ? <LoaderCircle size={15} className="spin" /> : <Headphones size={15} />}试听本段旁白</Button><p className="narration-hint">试听使用当前文案和表达，会使用语音额度；成片会适度调整节奏，将片头、段间与片尾留白控制在2秒内。</p>{audition?.url && <audio aria-label="旁白试听" controls autoPlay src={audition.url} />}{audition?.error && <p className="narration-error" role="alert">{audition.error}</p>}
        <details className="narration-scene-reference"><summary>本段画面参考 · {coveredShots.length} 个镜头</summary><div className="narration-shot-list">{coveredShots.map(s => <button key={s.id} type="button" onClick={() => { if (video.current) video.current.currentTime = s.start; }}><img loading="lazy" src={`/api/narration-files/${project.id}?frame=${s.id}`} alt="画面参考" /><div><span>{s.start.toFixed(1)} – {s.end.toFixed(1)} 秒</span><p>{s.description}</p></div><Play size={13} /></button>)}</div></details>
      </section>
    </div></section>;
}
