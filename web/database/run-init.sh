#!/bin/bash
# 在服务器上执行此脚本初始化数据库
# 用法: ./run-init.sh  或  bash run-init.sh
# 会提示输入 MySQL root 密码

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="${SCRIPT_DIR}/schema.sql"

if [ ! -f "$SQL_FILE" ]; then
  echo "错误: 找不到 schema.sql"
  exit 1
fi

echo "正在初始化车厘子数据库..."
mysql -u root -p < "$SQL_FILE"
if [ $? -eq 0 ]; then
  echo "数据库初始化成功"
else
  echo "数据库初始化失败"
  exit 1
fi
