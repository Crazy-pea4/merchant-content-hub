import type { Metadata } from 'next';
import './shadcn.css';
import './globals.css';
import './appearance.css';
import { ThemeToggle } from '@/components/theme-toggle';
export const metadata: Metadata = { title: '片场 Fieldwork · 个人创作室', description: '从一个想法或几段素材开始，写剧本、做分镜，并保存每次创作。', robots: { index: false, follow: false } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const initialTheme = "try{document.documentElement.dataset.theme=localStorage.getItem('fieldwork.appearance')==='light'?'light':'dark'}catch{}";
  return <html lang="zh-CN" data-theme="dark" suppressHydrationWarning>
    <head><script dangerouslySetInnerHTML={{ __html: initialTheme }}/></head>
    <body>{children}<ThemeToggle/></body>
  </html>;
}
