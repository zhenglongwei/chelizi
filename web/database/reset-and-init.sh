#!/bin/bash
# 清空数据库并重建 - Linux/macOS
# 用法：./reset-and-init.sh [mysql路径]
# 示例：MYSQL_PWD=密码 ./reset-and-init.sh

set -e
DB_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DB_DIR"

MYSQL="${1:-mysql}"

echo "[1/2] 删除数据库 chelizi..."
"$MYSQL" -u root -p < "$DB_DIR/reset-db.sql"

echo "[2/2] 重建 schema 及初始数据..."
"$MYSQL" -u root -p < "$DB_DIR/schema.sql"

echo ""
echo "完成。数据库已清空并重建。"
