import type { Metadata } from 'next';
import './shadcn.css';
import './globals.css';
export const metadata: Metadata = { title: '片场 Fieldwork · 个人创作室', description: '从一个想法或几段素材开始，写剧本、做分镜，并保存每次创作。', robots: { index: false, follow: false } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
