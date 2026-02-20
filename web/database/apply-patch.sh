#!/bin/bash
# 在服务器上执行补丁，--force 使某条失败时继续执行后续
# 用法：./apply-patch.sh  或  mysql -u root -p --force chelizi < migration-20260218-patch-direct.sql

cd "$(dirname "$0")"
echo "执行补丁（列已存在时会报错但会继续）..."
mysql -u root -p --force chelizi < migration-20260218-patch-direct.sql
echo ""
echo "验证 shops.shop_images 和 blacklist："
mysql -u root -p -e "USE chelizi; SHOW COLUMNS FROM shops LIKE 'shop_images'; SELECT 1 FROM blacklist LIMIT 1;" 2>/dev/null && echo "OK" || echo "请检查"
