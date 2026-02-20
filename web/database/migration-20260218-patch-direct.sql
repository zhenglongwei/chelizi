-- ========================================================
-- 直接补丁（无存储过程）：补齐 shops 缺失列 + blacklist 表
-- 若 patch-server.sql 执行失败，可尝试本脚本
-- 用法：mysql -u root -p chelizi < migration-20260218-patch-direct.sql
-- 注意：若列/表已存在会报错，可忽略
-- ========================================================

USE chelizi;

-- shops 缺失列（逐条执行，某条报 Duplicate column 可忽略）
ALTER TABLE shops ADD COLUMN shop_images JSON DEFAULT NULL COMMENT '服务商/店铺环境照片' AFTER logo;
ALTER TABLE shops ADD COLUMN qualification_ai_recognized VARCHAR(50) DEFAULT NULL COMMENT 'AI识别的资质等级' AFTER qualification_level;
ALTER TABLE shops ADD COLUMN qualification_ai_result VARCHAR(50) DEFAULT NULL COMMENT 'AI识别结果' AFTER qualification_ai_recognized;
ALTER TABLE shops ADD COLUMN qualification_audit_reason VARCHAR(500) DEFAULT NULL COMMENT '待审核/驳回原因' AFTER qualification_status;
ALTER TABLE shops ADD COLUMN qualification_withdrawn TINYINT UNSIGNED DEFAULT 0 COMMENT '资质是否已撤回' AFTER qualification_audit_reason;

-- blacklist 表
CREATE TABLE IF NOT EXISTS blacklist (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  blacklist_type VARCHAR(20) NOT NULL,
  blacklist_value VARCHAR(128) NOT NULL,
  reason VARCHAR(255) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_type_value (blacklist_type, blacklist_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
