import type { Asset } from '../shared/types';
import type { Table } from './db';
export function seedRecords(id: () => string, now: () => string) {
  const records: { table: Table; record: any }[] = [];
  const put = (table: Table, record: any) => { records.push({ table, record }); return record; };
  const log = (projectId: string, text: string) => put('activities', { id: id(), projectId, text, at: now() });
  const createdAt = now();
  put('merchants', { id: 'm-demo-coffee', name: '青野咖啡', industry: '咖啡 · 轻食', city: '杭州', audience: '附近上班族与咖啡爱好者', positioning: '用一杯好咖啡，留住城市里的片刻松弛', brandTone: '自然、真诚、有温度', createdAt });
  put('merchants', { id: 'm-demo-hair', name: '本色理发室', industry: '美发 · 造型', city: '杭州', audience: '重视日常打理的年轻客群', positioning: '适合自己的发型，比流行更重要', brandTone: '专业、轻松、直接', createdAt });
  put('projects', { id: 'p-demo-coffee', merchantId: 'm-demo-coffee', name: '十一月 · 门店日常内容', mode: 'managed', dueDate: '2026-11-30', deliverables: 12, fee: 6800, goal: '通过产品知识和主理人故事，让附近的人认识门店', createdAt });
  put('projects', { id: 'p-demo-hair', merchantId: 'm-demo-hair', name: '门店品牌形象拍摄', mode: 'shoot', dueDate: '2026-11-20', deliverables: 4, fee: 2800, goal: '交付门店介绍与服务流程短片', createdAt });
  const demoAssets: Asset[] = [
    { id: 'a-demo-interview', projectId: 'p-demo-coffee', name: '主理人访谈 · 为什么开这家店', kind: 'video', mime: 'video/mp4', size: 0, storageKey: '', thumbnailKey: null, duration: 48, tags: ['主理人', '访谈', '品牌故事', '咖啡'], segments: [{ start: 0, end: 16, text: '我希望这里是附近上班族能停下来喘口气的地方。' }, { start: 16, end: 32, text: '我们会跟客人聊喜欢的风味，再推荐适合他的咖啡豆。' }, { start: 32, end: 48, text: '有人每天来，也有人只是路过，大家都能自在坐一会儿。' }], transcriptSource: 'demo', rights: 'authorized', expiresAt: '', note: '演示数据，无实际视频；请上传真实素材体验预览和粗剪。', error: null, createdAt },
    { id: 'a-demo-product', projectId: 'p-demo-coffee', name: '手冲咖啡 · 风味讲解', kind: 'video', mime: 'video/mp4', size: 0, storageKey: '', thumbnailKey: null, duration: 24, tags: ['手冲', '产品特写', '制作过程', '咖啡豆'], segments: [{ start: 0, end: 12, text: '咖啡的酸味不一定是坏了，不同豆子会有不同的果酸风味。' }, { start: 12, end: 24, text: '试着等温度降一点，再感受它的甜感和余韵。' }], transcriptSource: 'demo', rights: 'authorized', expiresAt: '', note: '演示数据，无实际视频。', error: null, createdAt },
    { id: 'a-demo-space', projectId: 'p-demo-coffee', name: '午后门店 · 窗边空间', kind: 'image', mime: 'image/jpeg', size: 0, storageKey: '', thumbnailKey: null, duration: null, tags: ['门店环境', '窗边', '空间', '氛围'], segments: [], transcriptSource: 'none', rights: 'pending', expiresAt: '', note: '示例：待确认画面人物授权，暂不进入创作引用。', error: null, createdAt }
  ];
  demoAssets.forEach(a => put('assets', a));
  put('contents', { id: 'c-demo', projectId: 'p-demo-coffee', title: '开一家咖啡店，是想留住怎样的日常？', platform: '小红书', brief: '主理人故事 · 30 秒口述', script: '开场：门口走进店内。\n主理人口述：希望附近上班的人，能有个喘口气的地方。\n画面：手冲、递杯、窗边空镜。\n收尾：来坐坐，找到你喜欢的那杯咖啡。', caption: '不是每一杯咖啡都要匆忙喝完。我们想留住的，是你停下来坐一会儿的日常。\n\n你喜欢怎样的咖啡馆？', hashtags: ['咖啡店日常', '主理人故事', '杭州咖啡'], sourceAssetIds: ['a-demo-interview'], mediaAssetId: null, provider: 'demo', status: 'draft', version: 1, reviews: [], reviewToken: null, reviewExpiresAt: null, scheduledAt: null, createdAt });
  [ ['主理人正面采访', '拍一段开店初衷；安静环境收声，保留完整问答。', '阿哲', 'high'], ['手冲制作与产品特写', '补拍注水、咖啡液、递杯；每镜头保持 8 秒以上。', '小林', 'high'], ['窗边与门头空镜', '避开未授权顾客，拍摄横竖版各一组。', '小林', 'normal'] ].forEach(([title, description, owner, priority]) => put('tasks', { id: id(), projectId: 'p-demo-coffee', title, description, owner, priority: priority as 'high' | 'normal', dueDate: '2026-11-12', status: 'todo', createdAt }));
  log('p-demo-coffee', '演示项目已建立 · 上传第一份真实素材，开始你们的内容工作流');

  return records;
}
