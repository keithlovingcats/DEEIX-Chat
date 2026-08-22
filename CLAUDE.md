# CLAUDE.md

DEEIX Chat 开发指南。面向在仓库内工作的开发者与 AI 编码助手，记录技术栈、架构约束与本地调测流程。

## 项目概览

开源企业级 AI 对话平台：多模型路由、多模态对话、文件与 RAG、MCP 工具、计费支付、身份认证与审计运营。**pnpm monorepo + Turborepo** 管理，前后端分离开发、单运行时部署（前端静态导出后由 Go 服务托管）。

## 常用命令

```bash
pnpm dev           # turbo 同时启动前端(:3000) + 后端(:8080)
pnpm dev:web       # 仅前端
pnpm dev:api       # 仅后端（make run → go run ./cmd/server）
pnpm build         # 全量构建（前端 → frontend/out；Go → .cache/deeix-chat/deeix-chat）
pnpm verify        # check + test + build 全套校验（提交前必跑）
pnpm api:generate  # 后端 Swagger 变更后重新生成前端 TS 类型（packages/api-contract）

# 后端
cd backend && go test ./...          # Go 全量测试
cd backend && go vet ./...           # 静态检查

# 前端
cd frontend && pnpm lint             # Biome lint
cd frontend && pnpm typecheck        # tsc --noEmit
```

注意：`pnpm dev` 的后端是 `go run` 普通进程，**改 Go 代码不会热重载**，需重启；前端 next dev 有 HMR。

## 工程架构（Monorepo）

| 组成 | 说明 |
| --- | --- |
| `pnpm-workspace` + `turbo 2.10.5` | 包管理与任务编排（build/check/test 缓存；dev 不缓存、persistent） |
| `frontend/` | Next.js Web 应用（`@deeix/web`） |
| `backend/` | Go API 服务（`@deeix/api`，空壳 npm 包，scripts 桥接 Makefile → go 命令） |
| `packages/api-contract` | 从后端 Swagger 注解生成 TS 类型（`swagger-typescript-api`） |

## 技术栈

### 前端（`frontend/`）

- **Next.js 16**（App Router + Turbopack + `output: "export"` 静态导出 + PWA）+ **React 19** + **TypeScript 7**
- **Tailwind CSS 4** + **shadcn/ui**（radix-ui 统一包）+ lucide-react + @lobehub/icons-static-svg（模型图标，postinstall 脚本同步）
- 领域库：Streamdown（流式 Markdown + cjk/code/math/mermaid 插件）、KaTeX、Recharts、Monaco Editor、PDF.js、docx-preview、modern-screenshot
- 工程化：**Biome**（lint，无 ESLint/Prettier）、next-intl（i18n，locale 文件在 `frontend/i18n/messages/{zh-CN,en-US}/`）、next-themes
- 状态管理：纯 React hooks（无 zustand/redux），FSD 风格分层 `features/entities/shared/components/ui`

### 后端（`backend/`，Go 1.26）

- **Gin** + **GORM** + validator；分层：`cmd → internal/cli → internal/app → transport/http → application → domain → infra/repository`
- **HTTP DTO + Swagger annotation 是传输契约唯一事实源**；Handler 只做入参/鉴权/响应转换，业务在 application 层
- 数据：PostgreSQL（pgvector）或 SQLite（sqlite-vec）双驱动；缓存 Redis 或进程内存；存储本地或 S3
- 认证：JWT + HttpOnly refresh cookie、2FA/TOTP、SSO/OIDC；敏感数据加密存储（`data_encryption_key`）
- 协议适配：OpenAI / Anthropic / Google Gemini / xAI / OpenRouter / OpenAI 兼容（`internal/infra/llm/` adapter）
- 可观测：OpenTelemetry + Zap；支付 Stripe/EPay；**MCP** Streamable HTTP JSON-RPC
- ⚠️ **CGO 依赖**：mattn/go-sqlite3 与 sqlite-vec-go-bindings 需 C 编译器（macOS 自带 clang；Linux 需 gcc + libsqlite3-dev）

### 关键机制速查

- **消息流式协议是 NDJSON**（`application/x-ndjson`），非 SSE。事件类型：`message_created`（消息对落库即发，多模型 fan-out 锚点）/ `file_proc` / `delta` / `process_update` / `usage` / `moderation_*` / `completed` / `error`
- **消息树**：`ParentMessageID` + `SourceMessageID` + `BranchReason`（default/retry/edit）。retry 的 assistant 消息复用同一条 user 消息（`reuseUserMessage` 路径），多模型并行回答即同 parent 的 assistant 兄弟
- **断线重连**：`GET /conversation-runs/{run_id}/stream?after=seq` 回放 + 订阅；取消仅用户显式暂停（`/cancel`），断线不取消
- **计费预留**：每次模型调用前原子预留余额（`UsageReservationMaxActivePerUser = 20`，与前端 `MAX_CONCURRENT_RUNS`/`MAX_PARALLEL_MODELS` 对齐）
- **多模型并行对话**：前端编排 fan-out——主请求收到 `message_created` 后，以 `branchReason=retry, parent=user, source=assistant` 并行发出其余模型请求；每模型独立 run（计费/重连/审计天然隔离）。标签页 UI 在助手气泡顶部（`ModelBranchTabs`）
- **多模型讨论**：讨论 = 串行化的 fan-out——2-5 个模型 N 轮串行辩论（第 1 轮独立回答、后续轮互见 transcript 补纠挑战，主模型合成终稿）。编排器 `use-chat-discussion.ts` 逐 turn `await submitMessage`（每发言独立 run）；讨论发言随消息落库标记 `chat_messages.discussion_meta_json`（前端随请求透传 `discussionMeta`），刷新后凭 meta 重建聚合面板（`DiscussionPanel`，组内消息不走 `ModelBranchTabs`）。⚠️ 关键守卫：`service_message_preparation.go` 的 reuseUserMessage 分支仅当 `DiscussionMeta == nil` 才回填原 user content（讨论 prompt 需原样进生成上下文），有单测锁定；首条 turn 用原始用户输入（default 分支 content 会落库为用户消息）。开关/轮数是会话内内存态，不持久化

## 本地开发

### 前置工具

| 工具 | 版本 | 用途 |
| --- | --- | --- |
| Go | 1.26+ | 后端（brew install go） |
| pnpm | 10.17.0 | workspace（npm i -g pnpm@10.17.0；Node 25 无 corepack） |
| Node | 24/25 | 前端 |
| C 编译器 | clang/gcc | CGO 必需 |

### 配置（gitignore 内，不提交）

```bash
cp config.sqlite.example.yaml config.yaml   # 零依赖方案（SQLite + 内存缓存）
# 记得把 sqlite.path / storage.root_dir 从 /app/... 改为 ./data / ./storage 相对路径
# 分离端口开发需在 cors_allow_origin 加入 http://localhost:3000

cp frontend/.env.example frontend/.env.local  # NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8080
```

PostgreSQL + Redis 方案（需要测多实例/生产行为时）：`cp config.example.yaml config.yaml` + docker 起 `postgres:16` / `redis:7`（DSN 账密见该文件默认值）。

配置优先级：`环境变量 > config.yaml > 内置默认值`。

### 启动与访问

```bash
pnpm install   # 首次
pnpm dev
```

| 服务 | URL |
| --- | --- |
| 前端 | http://localhost:3000 |
| API | http://localhost:8080 |
| Swagger | http://localhost:8080/swagger/index.html |

首次建库自动创建超级管理员 `admin`（随机密码仅打印一次，见启动日志）。本地数据：`data/deeix.db`、`storage/`（删掉即重置）。开发自动登录：`.env.local` 设 `NEXT_PUBLIC_DEV_AUTO_LOGIN=true` + 测试账号（仅 dev 生效）。

测多模型对话：管理后台「上游渠道」配 ≥2 个模型渠道 → 聊天页选择器 `+` 多选 → 发送。

## 部署形态

- **Docker 单镜像**：多阶段（node:24 前端 → golang:1.26 后端 → debian-slim 运行时），Go 同时托管静态前端与 API
- **Compose 三档**：`docker-compose.sqlite.yml`（轻量）/ `docker-compose.yml`（外接 PG+Redis）/ `docker-compose.full.yml`（全套）
- **分离部署**：`NEXT_PUBLIC_API_BASE_URL` + `server.cors_allow_origin` + public URL 配置
- 可选文档服务：Tika / Tesseract / Docling（`docker/` 下 compose，仅管理后台启用时需要）

## 约定提醒

- 后端 API/DTO 改动 → 跑 `pnpm api:generate`，前端类型从 `@deeix/api-contract` re-export（`shared/api/conversation.types.ts`）
- i18n 文案 zh-CN / en-US 两个 locale 同步加
- 提交前 `pnpm verify`；commit message 用中文（类型: 描述），不加 `Co-Authored-By` 等尾注
