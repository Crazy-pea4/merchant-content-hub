# 片场 · 页面设计稿

以用户提供的界面参考为视觉基准。每张 GPT Image 设计图展示同一页面的暗色和明亮两种状态。示例文稿、缩略图、数量和日期用于展示信息层级，网页从实际数据读取。

| 页面 | 路由或状态 | 设计稿 |
| --- | --- | --- |
| 个人创作首页 | `/` | [暗色与明亮](./01-home.webp) |
| 创作对话 | `/?s=…` | [暗色与明亮](./02-session.webp) |
| 我的资产 | `/?tab=assets` | [暗色与明亮](./03-library.webp) |
| 作品阅读与直接编辑 | `/?tab=assets&item=w:…` | [暗色与明亮](./04-editor.webp) |
| 素材详情 | `/?tab=assets&item=a:…` | [暗色与明亮](./05-media.webp) |
| 素材画布 | `/?tab=board` | [暗色与明亮](./06-board.webp) |
| 声音克隆与配音 | `/?tab=dubbing` | [暗色与明亮](./07-voice.webp) |
| 抖音文案提取 | `/?tab=douyin` | [暗色与明亮](./08-subtitles.webp) |
| 视频旁白与逐段编辑 | `/narration` | [暗色与明亮](./09-narration.webp) |
| 访问口令 | `/（需口令）` | [暗色与明亮](./10-login.webp) |
| 历史项目概览 | `/archive` | [暗色与明亮](./11-overview.webp) |
| 商家与项目 | `/archive?tab=projects` | [暗色与明亮](./12-projects.webp) |
| 项目素材资产库 | `/archive?tab=assets` | [暗色与明亮](./13-archive-assets.webp) |
| 项目 AI 创作台 | `/archive?tab=create` | [暗色与明亮](./14-archive-create.webp) |
| 拍摄任务 | `/archive?tab=tasks` | [暗色与明亮](./15-tasks.webp) |
| 审核与交付 | `/archive?tab=review` | [暗色与明亮](./16-delivery.webp) |
| 内容日历 | `/archive?tab=calendar` | [暗色与明亮](./17-calendar.webp) |
| 客户内容审核 | `/review/[token]` | [暗色与明亮](./18-client.webp) |
| 上传、录音与业务表单 | `弹窗` | [暗色与明亮](./19-dialogs.webp) |
| 手机创作与审核 | `移动端` | [暗色与明亮](./20-mobile.webp) |
| 链接不可用与未找到页面 | `/review/[失效链接]、404` | [暗色与明亮](./21-status.webp) |

## 生成提示词

共同提示词以及每张图的页面提示如下。

UI-mockup. Reference image is a style reference with six screenshots. Produce ONE design sheet for the specific Fieldwork screen below, exactly TWO full desktop UI artboards vertically stacked, DARK THEME above, LIGHT THEME below, same layout, same data. Each artboard is a wide desktop viewport; use a tall or square high-resolution canvas containing both. No device frames, extraneous stuff, annotations or captions outside the screens. Reproduce the reference's cinematic, contemporary personal-creator app with restrained violet light, charcoal #14151c body, side rail #101117, violet #976bf6 accent, dark raised surfaces #22232f, muted lavender borders; the light companion uses true off-white #f6f5fb, white rail and cards, deep charcoal typography and violet #7349cf accents, each text clearly legible. Fine one-pixel outlines; 10–14px corners, compact line icons in soft violet/teal/pink; crisp modern Chinese sans, avoid inflated SaaS marketing copy. Typical personal layout has ~210px rail with violet iris logo 片场 Fieldwork, purple 新创作 button, 创作对话 / 素材画布 / 我的资产 / 创作工具, recent session list, personal footer. Compact topbar with location and sun/moon theme switch. Fictional data only: a small coffee shop 雾岸咖啡. Realistic photography where there is actual footage/content. Only show requested functional controls. Avoid decorative metrics, fake notification counters, device chrome.

### 01-home 个人创作首页

Personal creative home. Follow the top-left panel of the reference closely. Right of sidebar, upper wide cinematic illustration of stacked purple mountain ridges at dusk, coral clouds, small black seated cat at far right, ample faded negative space on the left. There prominent left-aligned Chinese 今天，想创作什么？ and a quiet instruction. Large wide gently translucent input overlapping bottom of hero, attachment / 资产 / 剧本 mode controls lower left and purple send arrow lower right. Below, one row of FIVE shortcut tiles 新建画布, 写一个短剧, 视频分镜, 声音克隆与配音, 抖音文案提取 with chromatic icons, followed by a compact 最近创作 list with actual session titles. Light hero version is a soft lilac sunrise with warm clouds and matching dark cat silhouette.

### 02-session 创作对话

Active conversation. Title 咖啡馆探店脚本 with 素材画布 action. The left rail includes the recent session list, the selected session highlighted. In a spacious central transcript a right-aligned muted-purple user request and attached clip chip, on the left a white or charcoal assistant document with violet icon, 剧本, check 已存入资产, title and three readable scene paragraphs. Inline actions 直接编辑 / 复制 / 继续创作. Big low composer anchored to bottom. Keep hierarchy like the reference chat panel.

### 03-library 我的资产

Asset library matching reference media grid. Header 我的资产, compact search input 搜索资产; tabs 全部 / 作品 / 素材 then compact kind filter (视频、图片、音频、文稿). Equal landscape cards display coffee footage, storefront, documents, audio waveform. Use real photos on photographic cards, expressive glyph thumbnail on synthetic document/audio cards. Name, type and date outside thumbnail, quiet metadata. 3–4 columns. No fake file counts or inactive feature buttons.

### 04-editor 作品阅读与直接编辑

Full-page work reader in inline EDITING state. Sidebar, breadcrumb 我的资产 / 作品编辑. Single generous document page, status 编辑中 and 剧本, editable title 雾岸咖啡的第一杯, large well typeset editable script with three Chinese numbered scene subheads, comfortable leading. Prominent violet 保存修改 and ghost 取消. No modal and no questionnaire.

### 05-media 素材详情

Asset detail page. Back to 我的资产. Large wide media player with still of barista preparing pour-over; fine native playback controls. Header 手冲现场.mp4 and 视频. Transcript small paragraphs beneath and actions 下载, 用于创作. A simple media inspector, focus on the footage not dashboard statistics.

### 06-board 素材画布

Use middle-left reference graph panel. Full-bleed dotted infinite React Flow canvas, top heading 素材画布 and conversation switcher, floating 加入素材 top left, zoom and fit controls bottom right. Show 2 rich thumb cards for cafe footage on left, script card and storyboard version towards right, connected with slender violet Bézier lines, round input/output ports. Node cards contain actual thumbnail / type / short name. No fictional automation controls.

### 07-voice 声音克隆与配音

Personal voice creation tool like bottom-left reference. Header 声音克隆与配音. Two-column main surface: left script editor with 文本配音/视频转写 mode, whole/逐句 tabs, text area, advanced expression controls and 试听 / 生成配音. Right 我的音色 with saved samples as compact selectable rows, subtle waveform icon and 添加音色 button. History of generated MP3 below. Use lavender on sound controls.

### 08-subtitles 抖音文案提取

Douyin subtitle extraction. A compact large link-entry panel across top labeled 抖音分享链接或完整分享文字, subtitle-region selector, violet 提取文案 button. Below, a slim list of recent 提取记录 left and a wide readable proofreading pane right with title 探店片段, timecoded subtitles, 逐句校对 / 复制 / TXT / SRT controls. No fake social feed.

### 09-narration 视频旁白与逐段编辑

Narration workspace. Standalone compact topbar returns to 片场 and links to 我的音色与配音 with theme switch. Title 视频旁白. Upload strip with 选择视频、旁白音色、语言、讲述风格 and generate. Below, large 16:9 cafe video with playback and export controls left, segment list and text editor with timecodes to right. Violet selection for current segment.

### 10-login 访问口令

Minimal standalone login screen. No sidebar. Fullscreen soft cinematic background with cat on right-end mountain ridge, dramatic dusk in dark / pastel lilac dawn in light. Center a 400px glass-like clearly legible card with violet iris logo and 片场 Fieldwork, title 进入个人创作室, single password input 访问口令, wide purple 进入创作室 button. Compact theme switch in top right.

### 11-overview 历史项目概览

Legacy project archive overview, secondary navigation for 工作概览 / 商家与项目 / 素材资产库 / AI 创作台 / 拍摄任务 / 审核与交付 / 内容日历. Rail top returns to personal studio. Header 工作概览, project picker, upload action. Short project banner with mountain/cat half-image and project name 雾岸咖啡, next action. Four real project progress tiles, then content pipeline and next shoot tasks. No analytics claims.

### 12-projects 商家与项目

Archive 商家与项目 page. Historical project rail, header with project switch. Controls 新增商家 and 新建项目. Orderly merchant dossier cards and associated project rows: project title, shoot/managed mode, goals, delivery date. Elegant document-like spacing, a slim violet accent and small semantic badges.

### 13-archive-assets 项目素材资产库

Archive 素材资产库. Archive navigation. Wide natural-language search with example 镜头 or 逐字稿; segmented type filters, primary 上传素材; rich landscape thumbnails of barista, shop window, latte. Cards include media name, tags, authorization and transcript status. Show a small transcription timecode in one search hit.

### 14-archive-create 项目 AI 创作台

Archive AI 创作台 page. Two columns, narrower brief with platform selector, content goal and selected reference materials, violet generate button. Wider right column 内容草案: a pair of readable draft cards with titles, brief, real source clip references, version and 编辑与关联成片. Compact status chips, spacious cards.

### 15-tasks 拍摄任务

Archive 拍摄任务 checklist for shoot day. Current project switch and 新增任务, compact summary of completed tasks. A spacious vertical actionable list; checkbox, task title, brief shot description, owner and due date. Mix checked and open rows, single violet重点镜头 tag. No kanban fiction.

### 16-delivery 审核与交付

Archive 审核与交付 page. Project switch, download delivery manifest. A vertical list of content versions with clearly distinct state chips 草稿、待审核、已通过, title, platform, final media link. Show actions 提交审核, 客户审核链接, 确认交付 for their respective states. Restrained and practical.

### 17-calendar 内容日历

Publishing calendar following the bottom-right reference. In the largest panel show a functional 7-column month grid with Chinese weekdays, previous/next month controls and 今天, violet dot for actual scheduled dates. Adjacent panel selected date and a list of real scheduled post titles with time, platform, publish confirmation. Header 内容日历, selected project. No fake analytics or cross-platform publishing claims.

### 18-client 客户内容审核

Standalone client review portal, no creator sidebar; narrow header with 片场 and 客户内容审核 and discreet theme toggle. Main two-column layout: left white or charcoal editorial document with project, version, status, coffee film preview, readable script & caption; right feedback card with reviewer, comment, 确认通过这一版, 提交修改意见 and past review timeline.

### 19-dialogs 上传、录音与业务表单

Component state sheet: within EACH theme artboard show three distinct modal specimens next to one another on a softly dimmed app ground: 上传素材 with dashed file drop zone and files/rights; 保存我的音色 with recording controls and consent; 打磨这一版内容 with clear title, script and selected source assets. Each should have titled header, controls and usable footer.

### 20-mobile 手机创作与审核

Mobile responsive design specs, override desktop composition: inside each theme half show THREE flat 390px mobile viewports in a row: home with mountain cat panorama, compact composer and wrapping shortcuts, no permanent rail; active mobile chat with bottom composer; client review with stacked reading and feedback. Header hamburger and compact sun/moon toggle. Same app palette. No physical phone shells.

### 21-status 链接不可用与未找到页面

Two standalone sparse status examples within each theme artboard: a missing page titled 页面不存在 with home link 返回创作室, and an expired client review link titled 这份审核链接暂不可用 with contact instruction. Subtle iris/status line icon, concise centered readable surfaces and top-right theme toggle.


## 网页使用的首页插画

以同一山脊、云层和右侧坐猫的构图生成无文字的宽幅背景。暗色使用靛蓝远山与珊瑚色晚霞，明亮使用淡紫山影与晨光；左侧留出文字空间。网页上的标题、输入框和操作均独立渲染。

[暮色山景](../../public/studio/hero-dusk.webp) · [晨光山景](../../public/studio/hero-dawn.webp)
