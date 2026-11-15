#!/usr/bin/env bash
# 部署到 Cloudflare Pages（免费档无 "Powered by" 徽标）
#
# 用法：
#   CLOUDFLARE_API_TOKEN=xxx ./dev/deploy-cf.sh
#   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx ./dev/deploy-cf.sh
#
# Token 权限（创建时选「Custom token」）：
#   Account → Cloudflare Pages → Edit
#   Account → Account Settings → Read      （wrangler 需要它来定位 account id）
#
# 说明：wrangler 默认把配置写到 ~/Library/Preferences/.wrangler，
# 因此在受限环境里把 HOME 指到项目内，避免写到用户目录。

set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${CF_PAGES_PROJECT:-deepseek-studio}"
WRANGLER=".tools/node_modules/.bin/wrangler"

if [ ! -x "$WRANGLER" ]; then
  echo "wrangler 未安装，正在安装到 .tools/ ..."
  mkdir -p .tools
  (cd .tools && [ -f package.json ] || echo '{"name":"cf-tools","private":true,"version":"1.0.0"}' > package.json)
  (cd .tools && npm_config_cache="$(cd .. && pwd)/.npm-cache" npm install wrangler --no-audit --no-fund --loglevel=error)
fi

export HOME="$(pwd)/.cf-home"
mkdir -p "$HOME"

# 两种鉴权都支持：
#   1) CLOUDFLARE_API_TOKEN 环境变量（API Token）
#   2) 先用 wrangler login 登录过（OAuth，凭据在 $HOME 下）
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if [ -f "$HOME/Library/Preferences/.wrangler/config/default.toml" ] \
     || [ -f "$HOME/.config/.wrangler/config/default.toml" ] \
     || [ -f "$HOME/.wrangler/config/default.toml" ]; then
    echo "▶ 使用已保存的 OAuth 凭据"
  else
    echo "缺少凭据：请设置 CLOUDFLARE_API_TOKEN，或先运行"
    echo "  HOME=\"$HOME\" .tools/node_modules/.bin/wrangler login"
    exit 2
  fi
fi

echo "▶ 构建静态产物"
node build.mjs

echo "▶ 确认 Pages 项目：$PROJECT"
EXISTS=$("$WRANGLER" pages project list --json 2>/dev/null \
  | python3 -c "import sys,json;print(any(p.get('Project Name')=='$PROJECT' or p.get('name')=='$PROJECT' for p in json.load(sys.stdin)))" 2>/dev/null || echo False)
if [ "$EXISTS" != "True" ]; then
  echo "  项目不存在，创建中…"
  "$WRANGLER" pages project create "$PROJECT" --production-branch=main 2>&1 | tail -3 || true
fi

echo "▶ 上传 dist/"
"$WRANGLER" pages deploy dist --project-name="$PROJECT" --branch=main --commit-dirty=true 2>&1 | tee /tmp/cf-deploy.log | tail -12

echo
echo "▶ 线上地址"
grep -oE 'https://[a-z0-9-]+\.pages\.dev' /tmp/cf-deploy.log | sort -u | head -3
