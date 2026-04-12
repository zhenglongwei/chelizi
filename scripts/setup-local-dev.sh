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

if [[ -f "$ROOT/package.json" ]]; then
  (cd "$ROOT" && npm run sync:config) || echo "[WARN] npm run sync:config 失败，请手动在项目根执行"
else
  echo "[INFO] 请执行: node scripts/sync-miniprogram-config.js"
fi

echo ""
echo "下一步：导入 schema → 编辑 web/.env（含 ZHEJIAN_MINIPROGRAM）→ npm run sync:config → cd web/api-server && npm install && npm run dev"
