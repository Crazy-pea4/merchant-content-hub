'use client';

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Upload, X } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { formatSize } from './ui';

const accept = '.mp4,.mov,.webm,.mp3,.wav,.m4a,.ogg,.flac,.jpg,.jpeg,.png,.webp,.txt,.srt,.md';
const extensions = new Set(accept.split(','));
const fileKey = (file: File) => JSON.stringify([file.name, file.size, file.lastModified, file.type]);
const hasFiles = (transfer: DataTransfer) => Array.from(transfer.types).includes('Files');

export function UploadDropzone({ files, onChange, disabled }: { files: File[]; onChange: (files: File[]) => void; disabled: boolean }) {
  const [dragging, setDragging] = useState(false), [error, setError] = useState('');
  const depth = useRef(0);
  useEffect(() => {
    // Stop a file dropped outside the upload area from replacing the current page.
    const preventNavigation = (event: globalThis.DragEvent) => {
      if (event.dataTransfer && hasFiles(event.dataTransfer)) event.preventDefault();
      if (event.type === 'drop') { depth.current = 0; setDragging(false); }
    };
    const reset = () => { depth.current = 0; setDragging(false); };
    window.addEventListener('dragover', preventNavigation);
    window.addEventListener('drop', preventNavigation);
    window.addEventListener('dragend', reset);
    return () => { window.removeEventListener('dragover', preventNavigation); window.removeEventListener('drop', preventNavigation); window.removeEventListener('dragend', reset); };
  }, []);
  function addFiles(incoming: FileList | File[]) {
    if (disabled) return;
    const next = [...files], seen = new Set(files.map(fileKey)), rejected: string[] = [];
    for (const file of Array.from(incoming)) {
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
      if (!extensions.has(ext)) { rejected.push(`${file.name}：不支持的文件格式或文件夹`); continue; }
      if (!file.size) { rejected.push(`${file.name}：空文件不能上传`); continue; }
      if (!seen.has(fileKey(file))) { next.push(file); seen.add(fileKey(file)); }
    }
    setError(rejected.slice(0, 3).join('；') + (rejected.length > 3 ? `；另有 ${rejected.length - 3} 个文件未添加` : ''));
    onChange(next);
  }
  function enter(event: DragEvent<HTMLLabelElement>) {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation();
    if (disabled) { event.dataTransfer.dropEffect = 'none'; return; }
    depth.current++; setDragging(true);
  }
  function leave(event: DragEvent<HTMLLabelElement>) {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation();
    depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false);
  }
  return <div className="upload-selection">
    <label className={`upload-zone${dragging && !disabled ? ' dragging' : ''}${disabled ? ' disabled' : ''}`} aria-disabled={disabled} onDragEnter={enter} onDragLeave={leave} onDragOver={event => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
    }} onDrop={event => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation(); depth.current = 0; setDragging(false); addFiles(event.dataTransfer.files);
    }}>
      <Upload size={30} /><strong>{dragging && !disabled ? '松开即可添加素材' : '拖拽文件到这里，或点击选择'}</strong>
      <span>视频、音频、图片或文稿 · 支持多选 · 单文件默认上限 128 MB</span>
      <span className="upload-choose-button" aria-hidden="true">选择文件</span>
      <Input className="upload-file-input" aria-label="选择素材文件" type="file" name="file" multiple accept={accept} disabled={disabled} onChange={event => { if (event.currentTarget.files) addFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
    </label>
    {error && <p className="error-text upload-selection-error" role="alert">{error}</p>}
    <p className="upload-selection-summary" role="status" aria-live="polite">{files.length ? `已选择 ${files.length} 个文件 · 共 ${formatSize(files.reduce((total, file) => total + file.size, 0))}，可继续添加` : '可分次拖入多个文件，确认标签和授权后点击“上传并入库”。'}</p>
    {files.length > 0 && <ul className="upload-file-list" aria-label="已选择的素材">{files.map(file => <li key={fileKey(file)}><div><strong>{file.name}</strong><small>{formatSize(file.size)}</small></div><Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={`移除文件：${file.name}`} onClick={() => onChange(files.filter(item => fileKey(item) !== fileKey(file)))}><X size={16} /></Button></li>)}</ul>}
  </div>;
}
