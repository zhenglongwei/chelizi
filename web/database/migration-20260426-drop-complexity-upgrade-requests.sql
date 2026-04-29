-- ========================================================
-- 删除已取消的破格升级机制相关表（complexity_upgrade_requests）
-- 说明：
-- - 破格升级机制已从需求中删除，前后端入口与接口已下线
-- - 此迁移用于清理历史表，避免误用与误维护
-- 回滚方式：
-- - 如需回滚，请从历史迁移 migration-20260211-evaluation-system.sql 恢复建表语句
-- ========================================================

USE zhejian;

DROP TABLE IF EXISTS complexity_upgrade_requests;

