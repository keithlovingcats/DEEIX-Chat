# Docker 构建与部署指南

## 版本历史

| 版本 | 日期 | 功能 | 改动说明 |
| --- | --- | --- | --- |
| 0.3.6 | 2026-08-22 | 多模型讨论 | 多选 2-5 个模型对同一问题进行多轮串行辩论（默认 2 轮、上限 5 轮，模型条上可调），第 1 轮各自独立回答，后续轮可见全部发言互相补充纠错，最后由主模型合成终稿；UI 为聚合气泡 + 可折叠讨论过程面板（按模型 / 全部轮次视图、逐发言 token 与耗时、单卡片可折叠、回到讨论开头按钮）。每个发言是独立 run，计费、断线重连、审计与现有链路完全一致；讨论过程随消息落库，刷新后自动重建面板；支持中途停止与单发言失败容错（失败不中断讨论，终稿披露失败项）。无新增配置项与依赖 |
| 0.3.5 | 2026-08-21 | 笔记功能 | 新增笔记模块：CRUD、搜索排序、Markdown 编辑与清单进度，编辑器自动保存 |
| 0.3.5 | 2026-08-21 | 多模型并行对话 | 一次提问多模型同时回答，选择持久化到会话，计费预留槽位扩至 20 |
| 0.3.5 | 2026-08-21 | 代码高亮与 Mermaid 主题 | 设置页可自定义代码高亮主题（60+ shiki）与 Mermaid 图表主题，带预览 |
| 0.3.5 | 2026-08-21 | 品牌定制 | 品牌更名为 Jun's Chat（默认配置、logo、文案） |
| 0.3.5 | 2026-08-21 | 默认行为调整 | 发送键改为 Ctrl+Enter；第三方登录与邮箱注册默认关闭 |
| 0.3.5 | 2026-08-21 | 工程与文档 | 新增开发指南与部署文档，API 契约同步更新 |

单镜像方案：前端静态导出产物 + Go 二进制打进同一个镜像，由 Go 进程同时托管 Web 页面与 API，只暴露一个 8080 端口。适合单机 Docker 部署 + nginx 反代域名的场景。

```
用户浏览器 → https://chat.example.com → nginx(443) → 127.0.0.1:8080 → deeix-chat 容器
                                                       （前端静态文件 + API 同源同端口）
```

前端构建时 `NEXT_PUBLIC_API_BASE_URL` 保持为空即可：运行时前端自动 fallback 到 `window.location.origin`（`frontend/shared/api/http-client.ts`），API 请求天然走访问域名，无跨域问题。

## 镜像结构

多阶段构建（见根目录 `Dockerfile`）：

```
node:24 前端构建   → frontend/out（Next.js 静态导出，运行时无 Node 进程）
golang:1.26 后端构建 → /out/deeix-chat（CGO 单体二进制，API + 静态文件服务器）
debian:bookworm-slim 运行时
└── /app/
    ├── deeix-chat       # 唯一进程，监听 8080
    ├── frontend/out/    # 静态前端（FRONTEND_DIST_DIR 指向）
    └── licenses/
```

注意：后端因 SQLite 依赖 CGO（`CGO_ENABLED=1`），运行时镜像基于 debian-slim（glibc），不能用 alpine/scratch。

## 一、构建镜像

在仓库根目录执行：

```bash
# NEXT_PUBLIC_API_BASE_URL 保持为空（同源模式），不要传
docker build -t deeix-chat:mytag .

# 可选：携带版本信息
docker build \
  --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) \
  -t deeix-chat:mytag .
```

## 二、分发镜像

二选一：

```bash
# 方式 A：镜像仓库
docker tag deeix-chat:mytag <registry>/deeix-chat:mytag
docker push <registry>/deeix-chat:mytag

# 方式 B：离线导出直传
docker save deeix-chat:mytag | gzip > deeix-chat.tar.gz
scp deeix-chat.tar.gz user@server:/opt/deeix-chat/
# 服务器上：
docker load < deeix-chat.tar.gz
```

## 三、服务器配置

### 3.1 目录结构

```bash
sudo mkdir -p /opt/deeix-chat && cd /opt/deeix-chat
```

```
/opt/deeix-chat/
├── docker-compose.yml
└── config.yaml
```

### 3.2 config.yaml

基于 `config.sqlite.example.yaml` 修改（SQLite + 内存缓存，单机零依赖）。关键项：

```yaml
app:
  env: prod

server:
  http_port: "8080"
  cors_allow_origin: "https://chat.example.com"        # 换成你的域名
  trusted_proxies: "127.0.0.1/32,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128,fc00::/7"  # 默认已覆盖 Docker 网段，勿删
  public_api_base_url: "https://chat.example.com"
  public_web_base_url: "https://chat.example.com"
  frontend_dist_dir: "/app/frontend/out"               # 容器内固定路径

security:
  jwt_secret: "<openssl rand -hex 32>"
  data_encryption_key: "<openssl rand -base64 32，至少 32 字节>"
  ssrf_protection_enabled: true                        # 渠道走内网（如 new-api）时需配 ssrf_allowed_hosts

database:
  driver: sqlite
  sqlite:
    path: /app/data/deeix.db                           # 持久化在 volume 中

cache:
  driver: memory

storage:
  backend: local
  local:
    root_dir: /app/storage                             # 持久化在 volume 中
```

⚠️ **`data_encryption_key` 投产后不可更换**——用于加密存储 API Key 等敏感数据，更换后已有密文无法解密。

### 3.3 docker-compose.yml

与仓库 `docker-compose.sqlite.yml` 一致，仅镜像名换成自建 tag：

```yaml
name: deeix-chat

services:
  app:
    image: deeix-chat:mytag            # 自建镜像；或 ghcr.io/deeix-ai/deeix-chat:latest
    container_name: deeix-chat-app
    ports:
      - "127.0.0.1:8080:8080"          # 只绑本机，外网无法直连，由 nginx 转发
    volumes:
      - app_storage:/app/storage
      - app_data:/app/data
      - ./config.yaml:/app/config.yaml:ro
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped
    networks:
      - deeix-chat

volumes:
  app_storage:
    name: deeix-chat-app-storage
  app_data:
    name: deeix-chat-app-data

networks:
  deeix-chat:
    name: deeix-chat-network
```

启动：

```bash
docker compose up -d
docker compose logs -f    # 首次启动打印 admin 随机密码，仅一次，注意保存
```

## 四、nginx + 域名 + HTTPS

消息流式协议是 **NDJSON 长连接**（非 SSE），nginx 必须关闭缓冲，并放宽超时与上传体积：

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name chat.example.com;

    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    client_max_body_size 100m;      # 文件上传，按需调整

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 流式 NDJSON 必需：禁用缓冲，token 立即推送到浏览器
        proxy_buffering off;
        proxy_cache off;

        # 长对话流式 + 断线重连回放，超时要够长
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

server {
    listen 80;
    server_name chat.example.com;
    return 301 https://$host$request_uri;
}
```

证书签发（certbot，自动续期）：

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d chat.example.com
```

除 80/443 外不需要暴露任何端口，容器 8080 只监听宿主机 loopback。

## 五、运维

| 操作 | 命令 |
| --- | --- |
| 查看日志 | `docker compose logs -f app` |
| 重启 | `docker compose restart` |
| 更新版本 | 本地重新 `docker build` → push/load → 服务器 `docker compose up -d`（volume 数据不受影响） |
| 数据备份 | 备份两个 volume：`deeix-chat-app-data`（SQLite）、`deeix-chat-app-storage`（上传文件） |
| 数据重置 | 删除两个 volume 后重新 `up -d` |

数据库 schema 变更由 GORM AutoMigrate 在新版本首次启动时自动执行，无需手工迁移；升级前照常备份 volume 即可。各版本涉及的变更：

- **0.3.6**：`chat_messages` 新增 `discussion_meta_json` 列（多模型讨论发言标记，可空默认空串，旧数据无感兼容）

## 常见问题

| 症状 | 原因 |
| --- | --- |
| AI 回复不是逐字出现，一坨一坨地蹦 | nginx 没配 `proxy_buffering off` |
| 审计日志里全是 172.x 内网 IP | `trusted_proxies` 被删改（默认配置已覆盖 Docker 网段） |
| 管理后台配置的 API Key 报错无法解密 | `data_encryption_key` 被更换 |
| 长对话中途断流 | nginx `proxy_read_timeout` 太短 |
