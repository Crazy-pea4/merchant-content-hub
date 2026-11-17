'use client';
import { Children, cloneElement, isValidElement, useId, useState, type ReactElement, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge as UiBadge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Dialog as UiDialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function Dialog({ title, subtitle, children, close, wide = false }: { title: string; subtitle?: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const [returnFocus] = useState(() => typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null);
  return <UiDialog open onOpenChange={open => { if (!open) close(); }}><DialogContent onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus?.isConnected) returnFocus.focus(); }} className={cn('modal hub-dialog', wide && 'wide')} showCloseButton={false}><DialogHeader className="modal-header"><div><DialogTitle>{title}</DialogTitle><DialogDescription className={subtitle ? undefined : 'sr-only'}>{subtitle || '查看并编辑本次内容，完成后保存或关闭。'}</DialogDescription></div><DialogClose asChild><Button type="button" variant="ghost" size="icon-sm" className="icon-button" aria-label="关闭"><X size={20} /></Button></DialogClose></DialogHeader>{children}</DialogContent></UiDialog>;
}
export function Field({ label, children, hint, className = '' }: { label: string; children: ReactNode; hint?: string; className?: string }) {
  const generatedId = useId();
  const child = isValidElement(children) ? children as ReactElement<{ id?: string; 'aria-describedby'?: string }> : null;
  const id = child?.props.id || generatedId;
  return <div className={`field ${className}`}><Label htmlFor={id}>{label}</Label>{child ? cloneElement(child, { id, ...(hint ? { 'aria-describedby': `${id}-hint` } : {}) }) : children}{hint && <small id={`${id}-hint`}>{hint}</small>}</div>;
}
// Adapt existing form options to shadcn Select while keeping native FormData values.
export function FormSelect({ children, name, value, defaultValue, onValueChange, className, id, disabled, required, ...aria }: {
  children: ReactNode; name?: string; value?: string; defaultValue?: string; onValueChange?: (value: string) => void;
  className?: string; id?: string; disabled?: boolean; required?: boolean; 'aria-label'?: string; 'aria-describedby'?: string;
}) {
  const options = Children.toArray(children).filter(isValidElement).map(child => {
    const option = child as ReactElement<{ value?: string; children: ReactNode; disabled?: boolean }>;
    return { value: String(option.props.value ?? option.props.children), label: option.props.children, disabled: option.props.disabled };
  });
  const [internal, setInternal] = useState(defaultValue ?? options[0]?.value ?? '');
  const selected = value ?? internal;
  const emptyValue = '__fieldwork_empty_selection__';
  return <><Select value={selected || emptyValue} disabled={disabled} required={required} onValueChange={next => { const actual = next === emptyValue ? '' : next; if (value === undefined) setInternal(actual); onValueChange?.(actual); }}><SelectTrigger id={id} className={cn('hub-select', className)} {...aria}><SelectValue placeholder="请选择" /></SelectTrigger><SelectContent position="popper" align="start" className="hub-select-content">{options.map(option => <SelectItem key={option.value || emptyValue} value={option.value || emptyValue} disabled={option.disabled}>{option.label}</SelectItem>)}</SelectContent></Select>{name && <input type="hidden" name={name} value={selected} disabled={disabled} />}</>;
}
export function Empty({ title, text, children }: { title: string; text: string; children?: ReactNode }) { return <div className="empty"><span className="empty-mark">＋</span><h3>{title}</h3><p>{text}</p>{children}</div>; }
export function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <UiBadge variant="outline" className={cn('badge', tone)}>{children}</UiBadge>; }
export function formatTime(seconds: number | null) { if (seconds === null) return '无时间码'; return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }
export function formatSize(bytes: number) { return bytes ? bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB` : '示例素材'; }
