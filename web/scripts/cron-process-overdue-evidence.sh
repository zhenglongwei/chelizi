#!/bin/bash
# 商户申诉逾期处理 - 定时任务脚本
# 用法：由 crontab 每小时调用，处理 deadline 已过的申诉请求 → 写入 shop_violations、更新合规率
# 需先配置 cron.env（见 cron.env.example）

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/cron.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 未找到 cron.env，请复制 cron.env.example 并配置" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$ENV_FILE"

if [ -z "$CRON_SECRET" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] CRON_SECRET 未配置" >&2
  exit 1
fi

API_URL="${API_BASE_URL:-https://simplewin.cn/api}"
ENDPOINT="${API_URL}/v1/admin/cron/process-overdue-evidence"

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$ENDPOINT" \
  -H "X-Cron-Secret: $CRON_SECRET" \
  -H "Content-Type: application/json")

HTTP_BODY=$(echo "$RESPONSE" | head -n -1)
HTTP_CODE=$(echo "$RESPONSE" | tail -n 1)

if [ "$HTTP_CODE" = "200" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] OK: $HTTP_BODY"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] HTTP $HTTP_CODE: $HTTP_BODY" >&2
  exit 1
fi
