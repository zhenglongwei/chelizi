#!/usr/bin/env bash
# 辙见 - 本地开发快速初始化（macOS / Linux）
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f "$ROOT/web/.env" && -f "$ROOT/web/.env.example" ]]; then
  cp "$ROOT/web/.env.example" "$ROOT/web/.env"
  echo "[OK] 已创建 web/.env（请编辑填写 DB_PASSWORD、WX_APPID、WX_SECRET）"
else
  echo "[SKIP] web/.env 已存在或缺少 web/.env.example"
fi

if [[ ! -f "$ROOT/config.local.js" && -f "$ROOT/config.local.example.js" ]]; then
  cp "$ROOT/config.local.example.js" "$ROOT/config.local.js"
  echo "[OK] 已创建 config.local.js"
else
  echo "[SKIP] config.local.js 已存在或缺少模板"
fi

echo ""
echo "下一步：导入 schema → 编辑 web/.env → cd web/api-server && npm install && npm run dev"
