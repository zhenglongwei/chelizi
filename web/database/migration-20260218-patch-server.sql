-- ========================================================
-- 服务器补丁：补齐 shops 缺失列 + blacklist 表
-- 当 schema 未在服务器执行或执行的是旧版时使用
-- 用法：mysql -u root -p chelizi < migration-20260218-patch-server.sql
-- ========================================================

USE chelizi;

DELIMITER $$

DROP PROCEDURE IF EXISTS patch_server_schema$$
CREATE PROCEDURE patch_server_schema()
BEGIN
  -- shop_images
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'shop_images') THEN
    ALTER TABLE shops ADD COLUMN shop_images JSON DEFAULT NULL
      COMMENT '服务商/店铺环境照片 URL 数组' AFTER logo;
  END IF;

  -- qualification_ai_recognized
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'qualification_ai_recognized') THEN
    ALTER TABLE shops ADD COLUMN qualification_ai_recognized VARCHAR(50) DEFAULT NULL
      COMMENT 'AI识别的资质等级' AFTER qualification_level;
  END IF;

  -- qualification_ai_result
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'qualification_ai_result') THEN
    ALTER TABLE shops ADD COLUMN qualification_ai_result VARCHAR(50) DEFAULT NULL
      COMMENT 'AI识别结果' AFTER qualification_ai_recognized;
  END IF;

  -- qualification_audit_reason
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'qualification_audit_reason') THEN
    ALTER TABLE shops ADD COLUMN qualification_audit_reason VARCHAR(500) DEFAULT NULL
      COMMENT '待审核/驳回原因' AFTER qualification_status;
  END IF;

  -- qualification_withdrawn
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'qualification_withdrawn') THEN
    ALTER TABLE shops ADD COLUMN qualification_withdrawn TINYINT UNSIGNED DEFAULT 0
      COMMENT '资质是否已撤回' AFTER qualification_audit_reason;
  END IF;
END$$

DELIMITER ;

CALL patch_server_schema();
DROP PROCEDURE patch_server_schema;

-- blacklist 表
CREATE TABLE IF NOT EXISTS blacklist (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  blacklist_type VARCHAR(20) NOT NULL COMMENT 'user_id/phone/device_id/ip/id_card',
  blacklist_value VARCHAR(128) NOT NULL COMMENT '对应类型的值',
  reason VARCHAR(255) DEFAULT NULL COMMENT '拉黑原因',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_type_value (blacklist_type, blacklist_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='防刷黑名单';
