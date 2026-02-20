# 数据库初始化说明

按《docs/database/数据库设计文档.md》在服务器 MySQL 中创建数据表。

## 方式一：命令行执行（推荐）

SSH 登录阿里云服务器后执行：

```bash
# 1. 进入项目目录（或上传 schema.sql 到服务器）
cd /path/to/chelizi

# 2. 执行建表脚本（根据实际修改 -u 用户名 -p 会提示输入密码）
mysql -u root -p < web/database/schema.sql

# 或指定数据库主机（若 MySQL 在别的机器）
mysql -h localhost -u root -p < web/database/schema.sql
```

## 方式二：MySQL 客户端

1. 使用 Navicat、DBeaver 等连接服务器 MySQL
2. 打开 `web/database/schema.sql`
3. 全选并执行

## 执行结果

- 创建数据库 `chelizi`
- 创建 15 张表：users, shops, damage_reports, biddings, quotes, orders, reviews, transactions, withdrawals, user_messages, user_favorite_shops, merchant_users, shop_penalties, appointments, settings
- 插入默认系统配置和 3 条测试维修厂、1 条测试用户数据

## 已有数据库升级（新增 service_category 字段）

若此前已创建 appointments 表，需单独执行：

```sql
ALTER TABLE appointments ADD COLUMN service_category VARCHAR(20) DEFAULT 'other' COMMENT '服务类型: maintenance-保养 wash-洗车 repair-修车 other-其他' AFTER time_slot;
```

## 验证

```sql
USE chelizi;
SHOW TABLES;
SELECT * FROM shops;
SELECT * FROM settings;
```
