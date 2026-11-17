'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

const storageKey = 'fieldwork.appearance';
type Theme = 'dark' | 'light';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');
  function apply(next: Theme) {
    document.documentElement.dataset.theme = next;
    setTheme(next);
  }
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    function sync(event: StorageEvent) {
      if (event.key === storageKey || event.key === null) apply(event.newValue === 'light' ? 'light' : 'dark');
    }
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const label = theme === 'dark' ? '切换到明亮主题' : '切换到暗色主题';
  return <button className="appearance-toggle" type="button" aria-label={label} title={label} onClick={() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    apply(next);
    try { localStorage.setItem(storageKey, next); } catch { /* The current tab can still switch. */ }
  }}><Sun className="theme-sun" size={17}/><Moon className="theme-moon" size={17}/></button>;
}
