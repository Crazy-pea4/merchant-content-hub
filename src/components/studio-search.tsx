'use client';

import { useEffect, useState } from 'react';
import { ArrowUpRight, MessageSquare, Search } from 'lucide-react';
import { Dialog } from './ui';
import { KindIcon, type ShelfItem } from './studio-library';

export function StudioSearch({ sessions, items, openChat, openItem }: {
  sessions: { id: string; title: string }[]; items: ShelfItem[];
  openChat: (id: string) => void; openItem: (id: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setQuery('');
        setVisible(current => !current);
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  const find = query.trim().toLocaleLowerCase();
  const chats = sessions.filter(s => s.title.toLocaleLowerCase().includes(find)).slice(0, 6);
  const works = items.filter(i => (i.title + ' ' + i.body).toLocaleLowerCase().includes(find)).slice(0, 16);
  function choose(fn: (id: string) => void, id: string) {
    setVisible(false);
    fn(id);
  }
  return <>
    <button className="studio-find" aria-label="搜索素材、作品或会话" onClick={() => { setQuery(''); setVisible(true); }}>
      <Search size={15}/><span>搜索素材、作品或会话</span>
    </button>
    {visible && <Dialog title="搜索创作室" close={() => setVisible(false)}>
      <div className="studio-search-body">
        <label className="search-box"><Search size={17}/><input autoFocus aria-label="搜索关键词" value={query}
          placeholder="输入名称或正文关键词" onChange={event => setQuery(event.target.value)}/></label>
        <div className="quick-results">
          {chats.length > 0 && <h3>创作对话</h3>}
          {chats.map(s => <button key={s.id} onClick={() => choose(openChat, s.id)}><MessageSquare size={16}/><span>{s.title}</span><ArrowUpRight size={14}/></button>)}
          {works.length > 0 && <h3>我的资产</h3>}
          {works.map(i => <button key={i.id} onClick={() => choose(openItem, i.id)}><KindIcon kind={i.kind}/><span>{i.title}</span><small>{i.kind}</small></button>)}
          {!chats.length && !works.length && <p>没有找到匹配的会话或资产。</p>}
        </div>
      </div>
    </Dialog>}
  </>;
}
