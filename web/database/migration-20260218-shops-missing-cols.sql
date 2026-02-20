-- ========================================================
-- shops 表缺失字段补充（首次开发必执行）
-- 添加 shop_images、qualification_withdrawn
-- 执行：mysql -u 用户名 -p 数据库名 < migration-20260218-shops-missing-cols.sql
-- ========================================================

USE chelizi;

DELIMITER $$

DROP PROCEDURE IF EXISTS add_shops_missing_columns$$
CREATE PROCEDURE add_shops_missing_columns()
BEGIN
  -- shop_images: 服务商/店铺环境照片 URL 数组
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'shop_images'
  ) THEN
    ALTER TABLE shops ADD COLUMN shop_images JSON DEFAULT NULL
      COMMENT '服务商/店铺环境照片 URL 数组' AFTER logo;
  END IF;

  -- qualification_withdrawn: 资质是否已撤回
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'qualification_withdrawn'
  ) THEN
    ALTER TABLE shops ADD COLUMN qualification_withdrawn TINYINT UNSIGNED DEFAULT 0
      COMMENT '资质是否已撤回：0=否 1=是（审核中时用户撤回，可重新编辑提交）'
      AFTER qualification_status;
  END IF;
END$$

DELIMITER ;

CALL add_shops_missing_columns();
DROP PROCEDURE add_shops_missing_columns;
