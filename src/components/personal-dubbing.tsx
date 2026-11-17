'use client';
import './personal-dubbing.css';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, FileText, LoaderCircle, Plus, RefreshCw, Trash2, Upload, Video, WandSparkles } from 'lucide-react';
import { Button } from './ui/button';
import { VoiceSamplePicker } from './voice-sample-picker';
import { DubbingPreview } from './dubbing-preview';
import { DubbingScriptEditor } from './dubbing-script-editor';
import { ToolAssetButton, type ProjectToolProps } from './tool-asset-button';
import { useDubbingDraft } from './use-dubbing-draft';
import { dubbingScriptText, splitDubbingText, reconcileDubbingParts, MAX_DUBBING_PARTS, MAX_DUBBING_PART_TEXT, effectivePartSettings, type DubbingPart } from '@/shared/dubbing-script';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { Badge, Dialog, Empty, Field, FormSelect, formatTime } from './ui';
import { dubbingStatusLabels, MAX_DUBBING_TEXT, dubbingSourceLabels, voiceStatusLabels, type Content, type DubbingSource, type DubbingSnapshot, type VoiceProfile } from '@/shared/types';
import { dubbingEmotions, dubbingEmotionLabels, dubbingTones, dubbingToneLabels, dubbingSettingsLabel, supportsDubbingExpression, type DubbingTone, type DubbingEmotion, type DubbingSettings } from '@/shared/dubbing-settings';

async function request(path: string, body?: unknown, method = 'POST') {
  const response = await fetch('/api/' + path, { method, headers: body instanceof FormData || body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error + (result.details ? '：' + result.details.join('；') : ''));
  return result;
}
type Perform = <T>(work: () => Promise<T>, message: string) => Promise<T | undefined>;
export function PersonalDubbing({ data, busy, perform, projectId, assets, contents, saveAsset }: ProjectToolProps & { data: DubbingSnapshot; busy: boolean; perform: Perform; contents: Pick<Content, 'id' | 'title' | 'script'>[] }) {
  const voices = data.voices;
  const dubbings = data.dubbings;
  const [mode, setMode] = useState('text'), [text, setText] = useState(''), [title, setTitle] = useState('');
  const [voiceId, setVoiceId] = useState(''), [sourceId, setSourceId] = useState(''), [usedSourceId, setUsedSourceId] = useState<string | null>(null), [rate, setRate] = useState('1');
  const [tone, setTone] = useState<DubbingTone>('natural'), [emotion, setEmotion] = useState<DubbingEmotion>('neutral'), [pitch, setPitch] = useState('1');
  const [voiceDialog, setVoiceDialog] = useState(false), [consent, setConsent] = useState(false), [videoConsent, setVideoConsent] = useState(false);
  const [voiceFile, setVoiceFile] = useState<File | null>(null), [voiceSampleBusy, setVoiceSampleBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [parts, setParts] = useState<DubbingPart[] | undefined>(), [scriptView, setScriptView] = useState('whole'), [selectedPartId, setSelectedPartId] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<VoiceProfile | null>(null);
  const submitting = useRef(false);
  const voiceRequest = useRef<string | null>(null), sourceRequest = useRef<string | null>(null);
  const generationRequest = useRef<{ signature: string; id: string } | null>(null);
  const sources = data.sources;
  const draft = useDubbingDraft(projectId, { version: 1, mode: mode as 'text' | 'video', scriptView: scriptView as 'whole' | 'sentences', text, title, voiceId, sourceId, usedSourceId, rate: rate as '0.75' | '1' | '1.25' | '1.5', pitch: pitch as '0.9' | '1' | '1.1', tone, emotion, parts, selectedPartId }, saved => {
    setMode(saved.mode); setScriptView(saved.scriptView); setText(saved.text); setTitle(saved.title); setVoiceId(saved.voiceId); setSourceId(saved.sourceId); setUsedSourceId(saved.usedSourceId); setRate(saved.rate); setPitch(saved.pitch); setTone(saved.tone); setEmotion(saved.emotion); setParts(saved.parts); setSelectedPartId(saved.selectedPartId);
  });
  useEffect(() => {
    if (!draft.ready) return;
    if (voiceId && !voices.some(voice => voice.id === voiceId && !['deleting', 'delete_failed'].includes(voice.status))) setVoiceId('');
    if (sourceId && !sources.some(source => source.id === sourceId)) setSourceId('');
    if (usedSourceId && !sources.some(source => source.id === usedSourceId)) setUsedSourceId(null);
  }, [draft.ready, voiceId, voices, sourceId, usedSourceId, sources]);
  const source = sources.find(s => s.id === sourceId);
  const selectedVoice = voices.find(v => v.id === voiceId);
  const expressionSupported = supportsDubbingExpression(selectedVoice?.model || data.capabilities.ttsModel || 'cosyvoice-v3-flash');
  const settings: DubbingSettings = { rate: Number(rate), pitch: Number(pitch), tone, emotion };
  useEffect(() => { if (selectedVoice && !supportsDubbingExpression(selectedVoice.model)) { setTone('natural'); setEmotion('neutral'); setParts(value => value?.map(part => ({ ...part, settings: { ...part.settings, tone: 'natural', emotion: 'neutral' } }))); } }, [selectedVoice?.id, selectedVoice?.model]);
  const activePartId = parts?.find(part => part.id === selectedPartId)?.id || parts?.[0]?.id;
  const spokenText = parts ? dubbingScriptText(parts) : text.trim();
  const scriptInvalid = !spokenText || spokenText.length > MAX_DUBBING_TEXT || !!parts && (!parts.length || parts.length > MAX_DUBBING_PARTS || parts.some(part => !part.text.trim() || part.text.length > MAX_DUBBING_PART_TEXT));
  function changeText(value: string) {
    if (parts) setParts(reconcileDubbingParts(parts, value));
    setText(value);
  }
  function changeParts(value: DubbingPart[]) { setParts(value); setText(dubbingScriptText(value)); }
  function changeScriptView(value: string) {
    if (value === 'sentences' && !parts) changeParts(splitDubbingText(text).map(sentence => ({ id: crypto.randomUUID(), text: sentence })));
    setScriptView(value);
  }
  const sourceReady = source?.status === 'completed' && source.segments.length > 0;
  const sourceText = sourceReady ? source.segments.map(s => s.text).join('\n') : '';
  const projectTexts = [
    ...contents.filter(c => c.script.trim()).map(c => ({ id: 'content:' + c.id, name: c.title + ' · 脚本', text: c.script })),
    ...assets.filter(a => a.rights === 'authorized' && (!a.expiresAt || a.expiresAt >= new Date().toISOString().slice(0, 10)) && a.segments.length)
      .map(a => ({ id: 'asset:' + a.id, name: a.name + ' · 逐字稿', text: a.segments.map(segment => segment.text).join('\n') })),
  ];
  const mediaReady = data.capabilities.ffmpeg && data.capabilities.ffprobe;
  async function removeVoice(voice: VoiceProfile) {
    if (submitting.current) return; submitting.current = true;
    try {
      const result = await perform(() => request(`voices/${voice.id}`, undefined, 'DELETE'), '音色删除已提交，已生成的配音会保留');
      if (result) { if (voiceId === voice.id) setVoiceId(''); setDeleteTarget(null); }
    } finally { submitting.current = false; }
  }
  async function addVoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (submitting.current || !voiceFile || voiceSampleBusy) return; submitting.current = true;
    const formElement = event.currentTarget, form = new FormData(formElement);
    form.set('file', voiceFile); form.set('consent', String(consent)); form.set('requestId', voiceRequest.current ||= crypto.randomUUID());
    try {
      const result = await perform<VoiceProfile>(() => request('voices', form), '声音样本已保存，音色将在后台创建');
      if (result) { setVoiceId(result.id); setVoiceDialog(false); setConsent(false); voiceRequest.current = null; }
    } finally { submitting.current = false; }
  }
  async function uploadVideo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (submitting.current) return; submitting.current = true;
    const element = event.currentTarget, form = new FormData(element);
    if (projectId) form.set('projectId', projectId);
    form.set('consent', String(videoConsent)); form.set('requestId', sourceRequest.current ||= crypto.randomUUID());
    try {
      const result = await perform<DubbingSource>(() => request('dubbing-sources', form), '视频已保存，正在后台提取文案');
      if (result) { setSourceId(result.id); setVideoConsent(false); sourceRequest.current = null; element.reset(); }
    } finally { submitting.current = false; }
  }
  async function generate(event: FormEvent) {
    event.preventDefault(); if (submitting.current || previewBusy) return; submitting.current = true;
    if (scriptInvalid) { submitting.current = false; return; }
    const payload = { projectId: projectId || undefined, voiceId, text: spokenText, title: title.trim() || '个人配音', ...settings, sourceId: usedSourceId, ...(parts ? { parts } : {}) };
    const signature = JSON.stringify(payload);
    if (generationRequest.current?.signature !== signature) generationRequest.current = { signature, id: crypto.randomUUID() };
    const requestId = generationRequest.current.id;
    try {
      const result = await perform(() => request('dubbings', { ...payload, requestId }), '配音任务已提交，完成后可在下方试听和下载');
      if (result) generationRequest.current = null;
    } finally { submitting.current = false; }
  }
  return <div className="dubbing-workspace">

    {!data.capabilities.tts && <div className="info-box" role="status"><strong>可以先保存声音样本</strong><p>语音服务配置完成后，系统会继续创建音色。生成配音前请联系工作空间管理员完成连接。</p></div>}
    <div className="dubbing-layout">
      <section className="section-card dubbing-composer"><div className="section-heading"><h2>制作一段配音</h2><span className="subtle">文案 → 选择音色 → 生成</span></div>
        <Tabs value={mode} onValueChange={setMode}><TabsList aria-label="配音文案来源"><TabsTrigger value="text"><FileText size={14} />直接输入</TabsTrigger><TabsTrigger value="video"><Video size={14} />从视频提取</TabsTrigger></TabsList></Tabs>
        {mode === 'video' && <div className="dubbing-source-panel">
          <Field label="选择已上传的视频或音频"><FormSelect value={sourceId} onValueChange={setSourceId}><option value="">请选择已上传的视频或音频</option>{sources.map(a => <option value={a.id} key={a.id}>{a.name}{projectId && !a.projectId ? ' · 未归属项目' : ''}</option>)}</FormSelect></Field>
          <form className="dubbing-video-upload" onSubmit={uploadVideo} onChange={() => { sourceRequest.current = null; }}><Field label="或上传新视频"><Input aria-label="上传配音来源视频" name="file" type="file" accept=".mp4,.mov,.webm" required disabled={busy} /></Field><label className="dubbing-consent"><Checkbox checked={videoConsent} onCheckedChange={v => setVideoConsent(v === true)} /><span>我有权使用此视频并提取其中的文案</span></label><Button type="submit" variant="outline" disabled={busy || !videoConsent || !mediaReady}><Upload size={14} />上传视频并提取文案</Button></form>
          {source && <div className="dubbing-source-preview"><div className="row-between"><strong>{source.name}</strong><Badge tone={sourceReady ? 'green' : 'orange'}>{dubbingSourceLabels[source.status]}</Badge></div>{sourceReady ? <><p className="dubbing-transcript">{sourceText}</p><Button type="button" size="sm" variant="outline" onClick={() => { changeText(sourceText); setUsedSourceId(source.id); if (!title) setTitle(source.name.replace(/\.[^.]+$/, '') + ' · 配音'); }}>使用此文案</Button> <ToolAssetButton projectId={projectId} assets={assets} saveAsset={saveAsset} source={{ type: 'dubbing-source', id: source.id }} busy={busy} /></> : <><p>{source.error || (source.status === 'skipped' ? '这个视频没有音轨，请选择有说话内容的视频。' : data.capabilities.asr ? '转写会在后台继续，完成后点击“使用此文案”，再校对内容。' : '语音转写尚未配置，也可以直接输入文案。')}</p>{source.status === 'failed' && data.capabilities.asr && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => perform(() => request(`dubbing-sources/${source.id}/retry`), '已重新提交视频转写')}><RefreshCw size={13} />重试提取</Button>}</>}</div>}
        </div>}
        <form onSubmit={generate} className="dubbing-script-form">
          <p className="dubbing-draft-status" role="status">{draft.status === 'saved' ? '草稿已自动保存到本机 · 刷新或切换页面后可继续' : draft.status === 'error' ? '本机草稿保存不可用，请保留文案后再离开页面' : '正在恢复本机草稿…'}</p>
          {draft.canRestoreLegacy && <Button type="button" variant="outline" size="sm" onClick={draft.restoreLegacy}>载入旧版配音草稿</Button>}
          {projectTexts.length > 0 && <Field label="填入项目文案"><FormSelect value="" onValueChange={id => {
            const selected = projectTexts.find(item => item.id === id);
            if (selected) { changeText(selected.text); setUsedSourceId(null); setScriptView('whole'); }
          }}><option value="">选择脚本或已授权素材的逐字稿</option>{projectTexts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</FormSelect></Field>}
          <Field label="配音名称"><Input value={title} onChange={e => setTitle(e.target.value)} maxLength={120} placeholder="例如：我的第一段配音" /></Field>
          <Tabs value={scriptView} onValueChange={changeScriptView}><TabsList aria-label="文案编辑方式"><TabsTrigger value="whole">整篇编辑</TabsTrigger><TabsTrigger value="sentences" disabled={!text.trim()}>逐句表达</TabsTrigger></TabsList></Tabs>
          {scriptView === 'whole' ? <Field label="朗读文案" hint={`保留原文语言；单次最多 ${MAX_DUBBING_TEXT} 字符。逐句表达可自动分句并单独设置。`}><Textarea value={text} onChange={e => changeText(e.target.value)} rows={9} maxLength={MAX_DUBBING_TEXT} required placeholder="在这里输入或粘贴文案。支持中文、英文和中英文混合内容。" /></Field> : parts && <DubbingScriptEditor parts={parts} selectedId={activePartId || ''} onSelect={setSelectedPartId} onChange={changeParts} settings={settings} expressionSupported={expressionSupported} disabled={busy} />}
          {parts && <p className="form-note">共 {parts.length} 句 · {parts.filter(part => Object.keys(part.settings || {}).length || part.pauseAfterMs).length} 句有独立表达。整篇编辑时仍保留逐句设置；改写的句子会重新分句，未改的句子保留标记。</p>}
          {scriptInvalid && !!text.trim() && <p className="dubbing-error" role="alert">请检查空句、单句 {MAX_DUBBING_PART_TEXT} 字符、最多 {MAX_DUBBING_PARTS} 句及全文 {MAX_DUBBING_TEXT} 字符的限制。</p>}
          <div className="dubbing-text-meta"><span>{usedSourceId ? <>来自：{sources.find(a => a.id === usedSourceId)?.name || '视频文案'} <Button type="button" size="sm" variant="ghost" onClick={() => { setUsedSourceId(null); }}>改为独立文案</Button></> : '直接输入的文案'}</span><span className={text.length > MAX_DUBBING_TEXT ? 'dubbing-error' : ''}>{text.length} / {MAX_DUBBING_TEXT}</span></div>
          <div className="form-grid"><Field label="朗读音色"><FormSelect value={voiceId} onValueChange={setVoiceId}><option value="">请选择自己的音色</option>{voices.map(v => <option key={v.id} value={v.id} disabled={v.status !== 'ready'}>{v.name}{v.status !== 'ready' ? ` · ${voiceStatusLabels[v.status]}` : ''}</option>)}</FormSelect></Field><Field label="朗读语速"><FormSelect value={rate} onValueChange={setRate}>{[['0.75', '舒缓 · 0.75 倍'], ['1', '自然 · 1 倍'], ['1.25', '轻快 · 1.25 倍'], ['1.5', '快速 · 1.5 倍']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</FormSelect></Field></div>
          <section className="dubbing-expression" aria-label="配音表达设置"><div className="dubbing-expression-heading"><strong>全篇表达设置</strong><span>试听与完整配音使用相同设置</span></div><div className="dubbing-expression-fields"><Field label="朗读语调"><FormSelect value={tone} onValueChange={value => setTone(value as DubbingTone)} disabled={busy || !expressionSupported}>{dubbingTones.map(value => <option key={value} value={value}>{dubbingToneLabels[value]}</option>)}</FormSelect></Field><Field label="朗读情感"><FormSelect value={emotion} onValueChange={value => setEmotion(value as DubbingEmotion)} disabled={busy || !expressionSupported}>{dubbingEmotions.map(value => <option key={value} value={value}>{dubbingEmotionLabels[value]}</option>)}</FormSelect></Field><Field label="声音音高"><FormSelect value={pitch} onValueChange={setPitch} disabled={busy}>{[['0.9', '稍低 · 0.9 倍'], ['1', '原始 · 1 倍'], ['1.1', '稍高 · 1.1 倍']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</FormSelect></Field></div><p className="form-note">{expressionSupported ? '语调和情感由模型引导，建议先试听确认；音高小幅调整更容易保留个人音色。' : '此音色支持语速和音高调整，暂不支持语调与情感选项。'}</p></section>
          <DubbingPreview voiceId={voiceId} text={spokenText} parts={parts} selectedPartId={activePartId} settings={settings} disabled={busy || !data.capabilities.tts || !mediaReady || selectedVoice?.status !== 'ready' || scriptInvalid} onBusyChange={setPreviewBusy} />
          <Button className="primary full" type="submit" disabled={busy || previewBusy || !data.capabilities.tts || !mediaReady || selectedVoice?.status !== 'ready' || scriptInvalid}><WandSparkles size={16} />生成完整配音</Button>
          <p className="form-note">生成在后台继续，关闭页面后也会保存结果。配音将使用语音服务额度，试听和下载已生成的音频无需重新合成。</p>
        </form>
      </section>
      <aside className="section-card dubbing-voices"><div className="section-heading"><h2>我的音色 <span className="counter">{voices.length}</span></h2><Button variant="outline" size="sm" disabled={busy || !mediaReady} onClick={() => { setConsent(false); setVoiceFile(null); setVoiceSampleBusy(false); setVoiceDialog(true); }}><Plus size={14} />添加音色</Button></div><p className="subtle">保存一次，后续配音可重复使用。</p>
        {!mediaReady && <p className="dubbing-error">音频处理服务暂不可用，请联系管理员。</p>}
        {!voices.length ? <Empty title="先留下你的声音" text="直接录音或上传清晰的单人朗读录音，建立第一个个人音色。" /> : <div className="dubbing-voice-list">{voices.map(v => <article className={`dubbing-voice ${voiceId === v.id ? 'selected' : ''}`} key={v.id}><div className="row-between"><strong>{v.name}</strong><Badge tone={v.status === 'ready' ? 'green' : v.status === 'failed' ? 'orange' : 'neutral'}>{voiceStatusLabels[v.status]}</Badge></div><small>声音样本 · {formatTime(v.sampleDuration)}</small>{!['deleting', 'delete_failed'].includes(v.status) && <audio aria-label={`${v.name}的声音样本`} controls preload="none" src={`/api/dubbing-files/${v.id}?sample`} />}{v.error && <p className="dubbing-error" role="alert">{v.error}</p>}<div className="button-row">{v.status === 'ready' && <Button type="button" size="sm" variant={voiceId === v.id ? 'default' : 'outline'} onClick={() => setVoiceId(v.id)}>{voiceId === v.id ? '当前音色' : '使用这个音色'}</Button>}{v.status === 'failed' && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => perform(() => request(`voices/${v.id}/retry`), '音色创建已重新排队')}><RefreshCw size={13} />重试创建</Button>}<Button type="button" size="sm" variant="outline" className="dubbing-delete-voice" disabled={busy || v.status === 'processing' || v.status === 'deleting'} onClick={() => { if (v.status === 'delete_failed') void removeVoice(v); else setDeleteTarget(v); }}><Trash2 size={13} />{v.status === 'delete_failed' ? '重试删除' : '删除音色'}</Button></div>{v.status === 'processing' && <p className="form-note">正在创建音色，完成后可删除。</p>}</article>)}</div>}
      </aside>
    </div>
    <section className="dubbing-history"><div className="section-heading"><h2>配音记录 <span className="counter">{dubbings.length}</span></h2><span className="subtle">音频与文案一起保存</span></div>{!dubbings.length ? <Empty title="下一段文案，等你发声" text="生成的配音会保存在这里，可随时回来试听或下载。" /> : <div className="dubbing-history-list">{dubbings.map(d => <article className="section-card dubbing-result" key={d.id}><div className="row-between"><h3>{d.title}</h3><Badge tone={d.status === 'completed' ? 'green' : d.status === 'failed' ? 'orange' : 'neutral'}>{['queued', 'processing'].includes(d.status) && <LoaderCircle size={12} className="spin" />}{dubbingStatusLabels[d.status]}</Badge></div><div className="dubbing-result-meta"><span>{projectId && !d.projectId && '未归属项目 · '}{d.voiceName} · {dubbingSettingsLabel(d)}</span><time>{new Date(d.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</time></div><p className="dubbing-result-text">{d.text}</p>{d.parts && <details className="dubbing-record-parts"><summary>{d.parts.length} 句逐句表达{d.status === 'processing' || d.status === 'failed' ? ` · 已完成 ${d.completedParts || 0} 句` : ''}</summary>{d.parts.map((part, index) => <div key={part.id}><p>{index + 1}. {part.text}</p><small>{dubbingSettingsLabel(effectivePartSettings({ rate: d.rate, pitch: d.pitch ?? 1, tone: d.tone ?? 'natural', emotion: d.emotion ?? 'neutral' }, part))}{part.pauseAfterMs ? ` · 额外停顿 ${part.pauseAfterMs / 1000} 秒` : ''}</small></div>)}</details>}{d.status === 'completed' && d.hasAudio && <div className="dubbing-playback"><audio aria-label={`${d.title}配音试听`} controls preload="none" src={`/api/dubbing-files/${d.id}`} /><Button variant="outline" size="sm" asChild><a href={`/api/dubbing-files/${d.id}?download`} download><Download size={14} />下载 MP3</a></Button><ToolAssetButton projectId={projectId} assets={assets} saveAsset={saveAsset} source={{ type: 'dubbing', id: d.id }} busy={busy} /></div>}{d.error && <p className="dubbing-error" role="alert">{d.error}</p>}{d.status === 'failed' && <Button type="button" variant="outline" size="sm" disabled={busy || !data.capabilities.tts} onClick={() => perform(() => request(`dubbings/${d.id}/retry`), '配音任务已重新排队')}><RefreshCw size={13} />重试配音</Button>}</article>)}</div>}</section>
    {deleteTarget && <Dialog title="删除这个音色？" subtitle="将删除保存的录音及对应服务音色，已生成的配音仍可试听和下载。删除后无法再用此音色生成或重试配音。" close={() => { if (!busy) setDeleteTarget(null); }}><div className="form-body"><p>确定删除「{deleteTarget.name}」吗？</p><div className="form-footer"><Button type="button" variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>取消</Button><Button type="button" variant="destructive" disabled={busy} onClick={() => void removeVoice(deleteTarget)}><Trash2 size={14} />确认删除音色</Button></div></div></Dialog>}
    {voiceDialog && <Dialog title="保存我的音色" subtitle="使用自己的录音，创建可重复使用的个人音色。" close={() => { if (!busy) setVoiceDialog(false); }}><form className="form-body" onSubmit={addVoice} onChange={() => { voiceRequest.current = null; }}><Field label="音色名称"><Input name="name" placeholder="例如：我的日常声音" maxLength={80} required /></Field><VoiceSamplePicker disabled={busy} onFileChange={file => { setVoiceFile(file); voiceRequest.current = null; }} onBusyChange={setVoiceSampleBusy} /><div className="info-box"><strong>怎样录得更像自己？</strong><p>在安静环境里，用平时说话的语气连续朗读。录音中只保留一个人的声音，避免音乐、回声和长时间停顿。</p></div><label className="dubbing-consent"><Checkbox checked={consent} onCheckedChange={v => setConsent(v === true)} /><span>这是我自己的声音，我同意将录音发送至语音服务创建音色</span></label><div className="form-footer"><Button type="button" variant="outline" onClick={() => setVoiceDialog(false)} disabled={busy}>取消</Button><Button type="submit" className="primary" disabled={busy || voiceSampleBusy || !voiceFile || !consent}>{busy ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}保存并创建音色</Button></div></form></Dialog>}
  </div>;
}
