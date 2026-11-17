import { ArrowLeft, Compass } from 'lucide-react';
import { Brand } from '@/components/brand';

export default function NotFound() {
  return <main className="missing-page"><section><Brand/><Compass size={36}/>
    <h1>页面不存在</h1><p>可以回到创作室，继续上次的创作。</p>
    <a href="/"><ArrowLeft size={16}/>返回个人创作室</a>
  </section></main>;
}
