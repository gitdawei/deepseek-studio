#!/usr/bin/env bash
# 把源码推到 main，把构建产物推到 gh-pages（GitHub Pages 用）。
#
# 前置：GitHub 上已存在一个空仓库（不要勾 README/.gitignore/license），
#       且本机 SSH key 对该账号有权限（gitdawei 已验证）。
#
# 用法：
#   ./dev/push-github.sh [owner/repo]
#   ./dev/push-github.sh gitdawei/deepseek-studio

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

TARGET="${1:-gitdawei/deepseek-studio}"
REMOTE="git@github.com:${TARGET}.git"

echo "▶ 目标仓库：$TARGET"

# 注意：不能用 --exit-code —— 空仓库没有任何 ref，它会返回非 0 造成误判
if ! git ls-remote "$REMOTE" >/dev/null 2>&1; then
  echo
  echo "仓库不存在或无权访问：$REMOTE"
  echo "请先去 https://github.com/new 建一个空仓库（名字：${TARGET#*/}），不要勾任何初始化文件。"
  exit 2
fi

# ---------- main：源码 ----------
if [ ! -d .git ]; then
  echo "▶ 初始化本地仓库"
  git init -q -b main
fi

git add -A
if ! git diff --cached --quiet; then
  git -c user.name="gitdawei" -c user.email="dawei.ww@qq.com" commit -q -m "DeepSeek Studio：全家桶应用 API 工作台"
  echo "▶ 已提交源码"
fi

git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE"
echo "▶ 推送 main"
git push -u origin main

# ---------- gh-pages：构建产物 ----------
echo "▶ 构建静态产物"
node build.mjs

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp -R dist/. "$TMP"/
touch "$TMP/.nojekyll"   # 关掉 Jekyll，避免 _ 开头文件被忽略

(
  cd "$TMP"
  git init -q -b gh-pages
  git add -A
  git -c user.name="gitdawei" -c user.email="dawei.ww@qq.com" \
      commit -q -m "build: $(date '+%Y-%m-%d %H:%M')"
  git remote add origin "$REMOTE"
  git push -q --force origin gh-pages
)

echo "▶ 已推送 gh-pages"
echo
echo "线上地址（需在 Settings → Pages 选择 gh-pages 分支）："
echo "  https://${TARGET%%/*}.github.io/${TARGET#*/}/"
