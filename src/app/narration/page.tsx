import type { Metadata } from 'next';
import NarrationTool from '@/components/narration-tool';

export const metadata: Metadata = { title: '视频旁白 · 让画面用你的声音讲述', description: '上传视频，自动理解画面并编写分镜文案，用自己的音色制作、预览和下载视频旁白成片。' };
export default function NarrationPage() { return <NarrationTool />; }
