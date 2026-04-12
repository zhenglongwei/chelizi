-- 补齐 merchant_shop_income_ledger.order_id（仅执行过 20260324、未执行 20260325 的环境会缺列导致资金流水 500）
-- 执行前必须选中库，否则 DATABASE() 为空会报错：
--   mysql -u root -p zhejian < migration-20260326-shop-income-ledger-order-id.sql
-- 或在客户端内：USE zhejian; 再 source 本文件（库名与下句一致，若线上不同请改）
USE zhejian;

DELIMITER $$

DROP PROCEDURE IF EXISTS patch_shop_income_ledger_order_id$$

CREATE PROCEDURE patch_shop_income_ledger_order_id()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'merchant_shop_income_ledger'
      AND COLUMN_NAME = 'order_id'
  ) THEN
    ALTER TABLE merchant_shop_income_ledger
      ADD COLUMN order_id VARCHAR(32) DEFAULT NULL COMMENT '维修单入账时填写' AFTER product_order_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'merchant_shop_income_ledger'
      AND INDEX_NAME = 'uk_repair_order_income'
  ) THEN
    ALTER TABLE merchant_shop_income_ledger
      ADD UNIQUE KEY uk_repair_order_income (order_id);
  END IF;
END$$

DELIMITER ;

CALL patch_shop_income_ledger_order_id();

DROP PROCEDURE IF EXISTS patch_shop_income_ledger_order_id;
