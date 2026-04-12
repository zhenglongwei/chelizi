-- 平台电子质保卡：店铺默认样式、订单本单样式、快照 JSON
-- 执行：在目标库运行本文件（与既有 orders/shops 表兼容）

SET @dbname = DATABASE();

-- shops.warranty_card_template_id：1=经典金 2=极简白 3=商务蓝 4=建档米 5=辙痕蓝 6=墨线白（样式表见 order-warranty-card-service.js CARD_TEMPLATES）
SET @sql = (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'warranty_card_template_id'
    ),
    'SELECT 1',
    'ALTER TABLE shops ADD COLUMN warranty_card_template_id TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT ''电子质保卡默认样式 1-3'' AFTER status'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'warranty_card_template_id'
    ),
    'SELECT 1',
    'ALTER TABLE orders ADD COLUMN warranty_card_template_id TINYINT UNSIGNED DEFAULT NULL COMMENT ''本单质保卡样式（完工提交时写入）'' AFTER completion_evidence'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'platform_warranty_card'
    ),
    'SELECT 1',
    'ALTER TABLE orders ADD COLUMN platform_warranty_card JSON DEFAULT NULL COMMENT ''平台电子质保卡快照'' AFTER warranty_card_template_id'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
