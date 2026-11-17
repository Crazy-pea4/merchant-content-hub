'use client';
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Mic, RefreshCw, Square, Upload } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { Field, formatTime } from './ui';

// Decode the browser's recording format locally and keep one mono 24 kHz WAV sample.
async function recordedWav(blob: Blob) {
  const decoder = new OfflineAudioContext(1, 1, 24000);
  const audio = await decoder.decodeAudioData(await blob.arrayBuffer());
  const frames = Math.min(audio.length, 60 * audio.sampleRate), duration = frames / audio.sampleRate;
  if (duration < 5) throw new Error('录音太短，请至少朗读 5 秒，推荐录制 10～20 秒。');
  const buffer = new ArrayBuffer(44 + frames * 2), view = new DataView(buffer);
  const write = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, audio.sampleRate, true); view.setUint32(28, audio.sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, frames * 2, true);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
  for (let i = 0; i < frames; i++) {
    const sample = Math.max(-1, Math.min(1, channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return { file: new File([buffer], '我的录音.wav', { type: 'audio/wav' }), duration };
}
function microphoneError(error: unknown) {
  if (error instanceof DOMException) {
    if (['NotAllowedError', 'SecurityError'].includes(error.name)) return '麦克风权限未开启，请在浏览器地址栏允许使用麦克风后重试。';
    if (error.name === 'NotFoundError') return '没有找到麦克风，请连接麦克风后重试。';
    if (error.name === 'NotReadableError') return '无法使用麦克风，请检查是否被其他应用占用后重试。';
  }
  return '录音暂时无法开始，请检查麦克风和浏览器权限后重试。';
}
type Phase = 'idle' | 'requesting' | 'recording' | 'processing' | 'ready';
export function VoiceSamplePicker({ disabled, onFileChange, onBusyChange }: { disabled: boolean; onFileChange: (file: File | null) => void; onBusyChange: (busy: boolean) => void }) {
  const [mode, setMode] = useState('record'), [phase, setPhase] = useState<Phase>('idle'), [seconds, setSeconds] = useState(0);
  const [preview, setPreview] = useState(''), [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null), stream = useRef<MediaStream | null>(null), timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewUrl = useRef(''), generation = useRef(0), pending = useRef(false);
  const callbacks = useRef({ onFileChange, onBusyChange }); callbacks.current = { onFileChange, onBusyChange };
  const recordingBusy = ['requesting', 'recording', 'processing'].includes(phase);
  function releaseMicrophone() {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null;
  }
  function clearPreview() {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = ''; setPreview(''); callbacks.current.onFileChange(null);
  }
  function showPreview(file: File) {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = URL.createObjectURL(file); setPreview(previewUrl.current); callbacks.current.onFileChange(file);
  }
  useEffect(() => () => {
    generation.current++; pending.current = false;
    if (recorder.current?.state !== 'inactive') recorder.current?.stop();
    releaseMicrophone();
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
  }, []);
  function stop() {
    if (recorder.current?.state !== 'recording') return;
    setPhase('processing'); recorder.current.stop();
  }
  async function start() {
    if (pending.current || disabled) return;
    if (!window.isSecureContext) { setError('浏览器录音需要安全连接，请通过 HTTPS 或本机 localhost / 127.0.0.1 打开。'); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined' || typeof OfflineAudioContext === 'undefined') { setError('当前浏览器不支持网页录音，请换用新版浏览器，或选择上传录音。'); return; }
    pending.current = true; const attempt = ++generation.current;
    clearPreview(); setError(''); setSeconds(0); setPhase('requesting'); callbacks.current.onBusyChange(true);
    try {
      const input = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (attempt !== generation.current) { input.getTracks().forEach(track => track.stop()); return; }
      stream.current = input;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      const capture = new MediaRecorder(input, mimeType ? { mimeType } : undefined), chunks: Blob[] = [];
      recorder.current = capture;
      capture.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      capture.onerror = () => {
        if (attempt !== generation.current) return;
        generation.current++; releaseMicrophone(); pending.current = false; setPhase('idle'); setError('录音中断，请检查麦克风后重新录制。'); callbacks.current.onBusyChange(false);
      };
      capture.onstop = async () => {
        if (attempt !== generation.current) return;
        releaseMicrophone(); setPhase('processing');
        try {
          const result = await recordedWav(new Blob(chunks, { type: capture.mimeType }));
          if (attempt !== generation.current) return;
          showPreview(result.file); setSeconds(result.duration); setPhase('ready');
        } catch (failure) {
          if (attempt !== generation.current) return;
          setPhase('idle'); setError(failure instanceof Error && failure.message.startsWith('录音太短') ? failure.message : '录音无法处理，请重新录制，或选择上传录音。');
        } finally { if (attempt === generation.current) { pending.current = false; callbacks.current.onBusyChange(false); } }
      };
      input.getAudioTracks().forEach(track => track.addEventListener('ended', () => { if (attempt === generation.current && capture.state === 'recording') stop(); }));
      capture.start(250); const startedAt = performance.now(); setPhase('recording');
      timer.current = setInterval(() => {
        const elapsed = (performance.now() - startedAt) / 1000; setSeconds(Math.min(60, elapsed));
        if (elapsed >= 60) stop();
      }, 200);
    } catch (failure) {
      if (attempt !== generation.current) return;
      releaseMicrophone(); pending.current = false; setPhase('idle'); setError(microphoneError(failure)); callbacks.current.onBusyChange(false);
    }
  }
  return <div className="voice-sample-picker">
    <Tabs value={mode} onValueChange={value => { if (disabled || recordingBusy) return; generation.current++; clearPreview(); setError(''); setPhase('idle'); setMode(value); }}><TabsList aria-label="声音样本来源"><TabsTrigger value="record" disabled={disabled || recordingBusy}><Mic size={15} />直接录音</TabsTrigger><TabsTrigger value="upload" disabled={disabled || recordingBusy}><Upload size={15} />上传录音</TabsTrigger></TabsList></Tabs>
    {mode === 'record' ? <section className={`voice-recorder ${phase === 'recording' ? 'is-recording' : ''}`} aria-label="录制声音样本"><div className="voice-recorder-status"><span className="voice-recorder-mark"><Mic size={23} /></span><div><strong>{phase === 'requesting' ? '请允许浏览器使用麦克风' : phase === 'recording' ? '正在录音，请自然朗读' : phase === 'processing' ? '正在准备录音…' : phase === 'ready' ? '录音已就绪' : '用平时的声音，读一段话'}</strong><p>{phase === 'recording' ? '至少 5 秒，推荐 10～20 秒；满 60 秒自动停止。' : '点击开始后开启麦克风，录完可以先试听。'}</p></div><span className="voice-recording-time" aria-label="录音时长">{formatTime(seconds)}</span></div>
      {phase === 'recording' ? <Button type="button" variant="outline" className="voice-stop" onClick={stop}><Square size={14} fill="currentColor" />停止录音</Button> : <Button type="button" variant="outline" disabled={disabled || recordingBusy} onClick={() => void start()}>{recordingBusy ? <LoaderCircle size={15} className="spin" /> : phase === 'ready' ? <RefreshCw size={15} /> : <Mic size={15} />}{phase === 'requesting' ? '正在等待麦克风…' : phase === 'processing' ? '正在处理录音…' : phase === 'ready' ? '重新录音' : '开始录音'}</Button>}
      <div className="voice-reading-prompt"><strong>可以读这一段</strong><p>你好，这是我的声音。我正在用自然的语气朗读这段文字，希望每一次表达都清晰、真诚。今天的天气很好，我想和你分享一些新的想法。</p></div>
      <div className="voice-reading-prompt"><strong>有活力的朗读示例</strong><p>像在招呼朋友出门一样，带点笑意和兴奋，重音有起伏，不用刻意播音。</p><p>哎，你快看！刚才还阴着呢，这会儿太阳都出来了。走，咱们出去转转，别老闷在屋里。也不用安排什么，就随便走走，买杯喝的，说不定还能碰上点有意思的事儿！</p></div>
    </section> : <Field label="声音样本" hint="WAV / MP3 / M4A，最大 10 MB；5～60 秒，推荐 10～20 秒。"><Input type="file" accept=".wav,.mp3,.m4a" disabled={disabled} required onChange={event => { clearPreview(); setError(''); const file = event.target.files?.[0]; if (!file) return; if (file.size > 10 * 1024 * 1024) { setError('录音文件不能超过 10 MB。'); return; } showPreview(file); }} /></Field>}
    {preview && <div className="voice-sample-preview"><span>试听声音样本</span><audio aria-label="待保存的声音样本试听" controls preload="metadata" src={preview} /><small>确认录音清晰后，点击下方“保存并创建音色”。</small></div>}
    {error && <p className="dubbing-error" role="alert">{error}</p>}
  </div>;
}
