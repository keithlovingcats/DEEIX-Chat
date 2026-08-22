#!/bin/bash
# DEEIX-Chat 镜像构建打包脚本（Ubuntu）
# 脚本放在代码目录（DEEIX-Chat）的父目录运行；镜像 zip 也保存在父目录。
# 流程：开代理 → git pull → docker build latest → docker save 打包为 .zip
# 用法：./build-image-zip.sh [代码目录]
#   代码目录默认取脚本同级的 DEEIX-Chat
# 可用环境变量覆盖：PROXY_ADDR / IMAGE_NAME / IMAGE_TAG / SKIP_PULL=1

set -euo pipefail

# ── 配置（环境变量可覆盖）──────────────────────────────────────
PROXY_ADDR="${PROXY_ADDR:-192.168.31.36:7890}"
IMAGE_NAME="${IMAGE_NAME:-junchat}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
# npm 镜像（corepack 下载 pnpm 与 pnpm install 用；Node 原生 fetch 不读
# http_proxy，corepack 无法走代理，必须直连可达的 registry）
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${1:-${SCRIPT_DIR}/DEEIX-Chat}"

IMAGE_REF="${IMAGE_NAME}:${IMAGE_TAG}"
STAMP="$(date +%Y%m%d-%H%M)"
ARCHIVE="${SCRIPT_DIR}/${IMAGE_NAME}_${IMAGE_TAG}_${STAMP}.zip"

# ── 代理 ──────────────────────────────────────────────────────
proxy_on() {
  export http_proxy="http://${PROXY_ADDR}"
  export https_proxy="http://${PROXY_ADDR}"
  export all_proxy="socks5://${PROXY_ADDR}"
  export no_proxy="localhost,127.0.0.1"
  echo "[1/4] proxy on → ${PROXY_ADDR}"
}
proxy_on

# ── 拉代码 ────────────────────────────────────────────────────
cd "${REPO_DIR}"
if [[ ! -d .git ]]; then
  echo "错误：${REPO_DIR} 不是 git 仓库" >&2
  exit 1
fi
if [[ "${SKIP_PULL:-0}" == "1" ]]; then
  echo "[2/4] SKIP_PULL=1，跳过 git pull"
else
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  COMMIT_BEFORE="$(git rev-parse --short HEAD)"
  echo "[2/4] git pull（分支 ${BRANCH}）"
  git pull --ff-only
  COMMIT_AFTER="$(git rev-parse --short HEAD)"
  echo "      ${COMMIT_BEFORE} → ${COMMIT_AFTER}"
fi
GIT_COMMIT="$(git rev-parse --short HEAD)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── 构建镜像 ──────────────────────────────────────────────────
echo "[3/4] docker build ${IMAGE_REF}"
docker build \
  --build-arg GIT_COMMIT="${GIT_COMMIT}" \
  --build-arg BUILD_TIME="${BUILD_TIME}" \
  --build-arg NPM_REGISTRY="${NPM_REGISTRY}" \
  --build-arg http_proxy="http://${PROXY_ADDR}" \
  --build-arg https_proxy="http://${PROXY_ADDR}" \
  -t "${IMAGE_REF}" \
  "${REPO_DIR}"

# ── 导出镜像 ──────────────────────────────────────────────────
# 说明：docker save | gzip 流式压缩，文件扩展名 .zip 但容器格式是
# gzip+tar，docker load -i 可直接加载，无需解压。
echo "[4/4] docker save → ${ARCHIVE}"
docker save "${IMAGE_REF}" | gzip > "${ARCHIVE}"

echo ""
echo "完成：${ARCHIVE} ($(du -h "${ARCHIVE}" | cut -f1))"
echo "目标机加载：docker load -i ${ARCHIVE##*/}"
