# Docker 运行与维护

更新日期：2026-11-06。当前使用 Next.js、Fastify、PostgreSQL 三个独立服务，原网页地址保持不变。详细代码边界和迁移机制见 [Fastify 与 PostgreSQL](docs/FASTIFY_POSTGRESQL.md)。

## 启动

需要 Docker Engine / Docker Desktop 与 Compose。首次配置可使用宿主机 Node.js 24+：

```bash
cd ~/Code/merchant-content-hub
npm run setup
docker compose up -d --build
```

`setup` 创建或补全 `.env` 的随机数据库口令，不修改已有 AI / ASR Key，不输出凭据。没有宿主机 Node.js 时，可复制 `.env.example` 为 `.env`，自行填入随机十六进制 `POSTGRES_PASSWORD`；Compose 内的数据库地址自动生成，本机开发另需设置 `DATABASE_URL`。

访问 <http://127.0.0.1:3100>。首次构建下载基础镜像、依赖和 FFmpeg。后续可以复用缓存。

| 服务 | 职责与镜像 | 数据与访问 |
| --- | --- | --- |
| `web` | Next.js standalone，`merchant-content-hub:local` | 宿主机默认仅开放 127.0.0.1:3100；不挂载媒体或持有模型 Key |
| `api` | Fastify + FFmpeg，`merchant-content-hub-api:local` | 内网 3101，业务 API、AI / ASR 配置、媒体与后台 Worker |
| `db` | `postgres:17-alpine` | 内网 5432，PostgreSQL 业务数据；默认不暴露宿主机端口 |

```bash
docker compose ps
docker compose logs --tail=100 api web db
```

API 等数据库健康后启动，Web 等 API 健康后启动。健康检查之外，还应访问网页和 `/api/health` 核对实际可达性。其他项目占用 3100 时可设置 `HUB_PORT=3200`；不要修改其他项目的容器。

## 配置 AI、转写与访问口令

DeepSeek 与百炼配置放在本机 `.env`：`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`，以及 `ASR_PROVIDER=aliyun`、`ASR_BASE_URL` / `ASR_API_KEY` / `ASR_MODEL`。已有公共默认值见 `.env.example`。全部模型凭据只传入 API 容器，构建阶段不读取，不进入网页产物。

个人配音另支持 `TTS_API_KEY`、`TTS_BASE_URL`、`TTS_MODEL=cosyvoice-v3-flash` 和 `TTS_WORKER_ENABLED`。前两项为空且 ASR 使用百炼时，复用 ASR 的 Key 与地址；对应账号需开通声音复刻与语音合成能力。独立音色、视频转写和配音任务在 PostgreSQL 的三张独立表中，样本、上传的视频和最终 MP3 在 `hub-data`，均随现有备份策略保存。

独立视频旁白页面为 `/narration`，使用 `VISION_API_KEY`、`VISION_BASE_URL`、`VISION_MODEL=qwen3.8-flash` 和 `NARRATION_WORKER_ENABLED`。Key 和地址为空时复用百炼 ASR 配置并转换为 `/compatible-mode/v1`；只把视频画面发送至云端分析，不在服务器部署视觉或语音模型。新增的 `narrations` / `narration_renders` 表由 API 初始化，原片、分镜图、可复用音频片段和 MP4 保存到 `hub-data`，备份时需同时保留数据库与该卷。

修改配置后：

```bash
docker compose up -d api web
```

`up -d` 会应用新环境；`restart` 不重新加载环境变量。ASR 队列和远端任务编号保存在 PostgreSQL；Fastify 重启后恢复，已知百炼任务继续查询。浏览器关闭不影响识别。文本模型未配置时显示演示模板；真实调用失败不会静默替换成演示结果。未配置 ASR 时可以导入人工逐字稿或 SRT。

团队口令用 `HUB_ACCESS_TOKEN`；跨域客户端的完整来源通过 `HUB_ALLOWED_ORIGINS` 精确配置。默认不允许任意跨域。HTTPS 代理需配置实际 HTTPS 来源。本版仍是内部共享口令，独立账号和角色权限尚未实现。

如果使用 `.env.local`，所有 Compose 命令都需加 `--env-file .env.local`，并在该文件配置数据库口令；建议只维护一个配置来源。容器内 `127.0.0.1` 指向容器自己，连接宿主机服务时应使用可达地址，例如 Docker Desktop 的 `host.docker.internal`。

## 数据保存与旧库迁移

- PostgreSQL：`merchant-content-hub_hub-postgres`，容器内 `/var/lib/postgresql/data`。
- 原有媒体：`merchant-content-hub_hub-data`，API 内 `/app/data/uploads`。
- 旧 `/app/data/hub.sqlite` 保留为迁移前副本，切换后不继续更新。
- 新建容器、重启和 `docker compose down` 保留命名卷；`down -v` 会删除业务数据，不用于日常维护。
- 本机开发使用独立 Compose 项目和卷，不能将开发数据库和正式数据混用，操作见后端文档。

旧部署切换前停止写入，并保存一致的 SQLite / 媒体备份和原镜像。API 首次启动时通过 `LEGACY_SQLITE_PATH` 向空 PostgreSQL 导入全部 8 类业务记录，保持 ID、版本、审核链接、完整 ASR 句词时间与文件引用。导入在同一事务中完成并记录迁移标记，后续启动不重复导入；目标非空又未迁移时会拒绝自动合并。任务指纹为适配 JSONB 键顺序作规范化，远端任务编号保留。

不要同时运行新旧两套服务写入同一个媒体卷。切换后不能直接使用旧 SQLite 恢复最新业务；应先核对并导出 PostgreSQL 的新增数据。

## 日常维护与备份

```bash
# 停止 / 恢复；数据卷保留
docker compose stop
docker compose up -d

# 只重启 API 和网页
docker compose restart api web

# 更新代码与镜像
docker compose up -d --build
```

备份时使用全新的带日期目录，并暂停应用写入，以便数据库和媒体一致：

```bash
mkdir -p backups/20261106
chmod 700 backups/20261106
docker compose stop web api
docker compose exec -T db pg_dump -U hub -d merchant_content_hub -Fc > backups/20261106/hub.dump
docker compose cp api:/app/data backups/20261106/media-data
chmod 600 backups/20261106/hub.dump
docker compose up -d api web
```

`backups/` 被 Git 和 Docker 构建上下文排除。数据库备份包含客户审核令牌等业务数据，妥善保存。不要对运行中的 PostgreSQL 数据目录直接打包作为逻辑备份。恢复时先备份当前状态，在独立 PostgreSQL 目标执行 `pg_restore` 并恢复对应媒体，再校验记录、授权和文件；自行挂载目录时确保 API 的 UID/GID 1000 可读写。当前自动验收覆盖重启和容器重建，不代表已完成正式灾难恢复演练。

## 镜像与自动验收

Dockerfile 多阶段构建：锁定依赖 → 独立 API / Next.js 构建 → 各自运行镜像。API 生产依赖使用独立 npm 工作区，包含 Fastify / pg / Zod；FFmpeg 只在 API 层。应用容器使用非 root 用户及健康检查，Compose 设失败重启策略。构建上下文排除密钥、数据库、媒体、Git 和备份。

当前实际验证平台为本机 Linux ARM64；其他架构应在目标环境重新构建验证。

```bash
docker compose build
npm ci
npm run test:backend
npm run test:docker
HUB_TEST_DOCKER_IMAGE=merchant-content-hub:local npm run test:browser
HUB_TEST_DOCKER_IMAGE=merchant-content-hub:local npm run test:search
HUB_TEST_DOCKER_IMAGE=merchant-content-hub:local npm run test:creation
HUB_TEST_DOCKER_IMAGE=merchant-content-hub:local npm run test:transcription
```

测试创建隔离的 PostgreSQL、API、Web、临时网络和两种命名卷，使用随机端口和模拟模型。覆盖导入、事务回滚、并发审核、真实视频上传 / 缩略图 / 粗剪 / Range 下载、交付 / 排期、重启及重建持久化。浏览器使用系统 Google Chrome；不调用收费模型，不改动正式业务数据。结束只清理本次 QA 资源。

实现参考：[Fastify 请求体解析](https://fastify.dev/docs/latest/Reference/ContentTypeParser/)、[node-postgres 事务](https://node-postgres.com/features/transactions)、[PostgreSQL 事务锁](https://www.postgresql.org/docs/17/explicit-locking.html)。

双语字幕自动翻译复用 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`，不使用商家策划上下文。API 镜像安装 `fonts-noto-cjk` 供 FFmpeg/libass 渲染中文；只运行媒体处理，不部署本地模型。修改 Dockerfile 后需重新构建 API 镜像。
