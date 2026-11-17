'use client';

import { useState } from 'react';
import { CalendarDays, Check, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { statusLabels, type Content } from '@/shared/types';
import { Badge } from './ui';

const dayMs = 86_400_000;
const dateKey = (date: Date) => date.toISOString().slice(0, 10);
const beijingDay = (instant: string | number) => dateKey(new Date(new Date(instant).getTime() + 8 * 3_600_000));
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];

export function PublicationCalendar({ contents, busy, onSchedule, onPublish }: {
  contents: Content[]; busy: boolean; onSchedule: () => void; onPublish: (item: Content) => void;
}) {
  const today = beijingDay(Date.now());
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, setSelected] = useState('');
  const first = new Date(month + '-01T00:00:00Z');
  const next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const cellCount = Math.ceil((offset + (next.getTime() - first.getTime()) / dayMs) / 7) * 7;
  const entries = contents.filter(c => c.scheduledAt && beijingDay(c.scheduledAt).startsWith(month))
    .sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!));
  const days = new Set(entries.map(c => beijingDay(c.scheduledAt!)));
  const visible = selected ? entries.filter(c => beijingDay(c.scheduledAt!) === selected) : entries;
  function changeMonth(by: number) {
    setMonth(dateKey(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + by, 1))).slice(0, 7));
    setSelected('');
  }
  return <div className="publication-calendar">
    <section className="month-surface">
      <header><h2>{first.getUTCFullYear()} 年 {first.getUTCMonth() + 1} 月</h2><div>
        <button aria-label="上个月" onClick={() => changeMonth(-1)}><ChevronLeft size={16}/></button>
        <button onClick={() => { setMonth(today.slice(0, 7)); setSelected(today); }}>今天</button>
        <button aria-label="下个月" onClick={() => changeMonth(1)}><ChevronRight size={16}/></button>
      </div></header>
      <div className="month-grid">{weekdays.map(day => <span className="weekday" key={day}>周{day}</span>)}
        {Array.from({ length: cellCount }, (_, index) => {
          const date = new Date(first.getTime() + (index - offset) * dayMs), key = dateKey(date);
          const outside = !key.startsWith(month);
          return <button key={key} disabled={outside} className={key === today ? 'today' : ''} aria-pressed={key === selected}
            aria-label={key + (days.has(key) ? ' 有排期' : '')} onClick={() => setSelected(key === selected ? '' : key)}>
            {date.getUTCDate()}{days.has(key) && <i/>}
          </button>;
        })}
      </div>
    </section>
    <section className="agenda-surface">
      <header><h2>{selected ? selected.slice(5).replace('-', ' / ') + ' 排期' : '本月排期'}</h2>
        {selected && <button onClick={() => setSelected('')}>查看整月</button>}</header>
      <button className="agenda-add" onClick={onSchedule}><Plus size={15}/>安排审核通过的内容</button>
      {visible.length ? visible.map(c => <article className="agenda-entry" key={c.id}>
        <time dateTime={c.scheduledAt!}>{new Date(c.scheduledAt!).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {c.platform}</time>
        <h3>{c.title}</h3><Badge tone={c.status === 'published' ? 'green' : 'orange'}>{statusLabels[c.status]}</Badge>
        {c.status === 'scheduled' && <button disabled={busy || Date.parse(c.scheduledAt!) > Date.now()} onClick={() => onPublish(c)}> <Check size={14}/>确认已发布</button>}
      </article>) : <div className="agenda-empty"><CalendarDays size={24}/><p>{selected ? '这一天还没有排期' : '本月还没有排期'}</p></div>}
      <small>排期按北京时间显示。发布后可在此确认。</small>
    </section>
  </div>;
}
