-- ========================================================
-- 维修方案调整与确认
-- 按《维修方案调整与确认流程.md》：
-- orders 新增 repair_plan、repair_plan_status、repair_plan_adjusted_at
-- 执行：mysql -u 用户名 -p 数据库名 < migration-20260223-repair-plan.sql
-- ========================================================

USE chelizi;

DELIMITER $$

DROP PROCEDURE IF EXISTS add_orders_repair_plan_columns$$
CREATE PROCEDURE add_orders_repair_plan_columns()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'repair_plan'
  ) THEN
    ALTER TABLE orders ADD COLUMN repair_plan JSON DEFAULT NULL
      COMMENT '当前维修方案 {items,value_added_services?,amount?,duration?,warranty?}，接单时从quote复制' AFTER completion_evidence;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'repair_plan_status'
  ) THEN
    ALTER TABLE orders ADD COLUMN repair_plan_status TINYINT UNSIGNED DEFAULT 0
      COMMENT '0=已确认 1=待车主确认' AFTER repair_plan;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'repair_plan_adjusted_at'
  ) THEN
    ALTER TABLE orders ADD COLUMN repair_plan_adjusted_at DATETIME DEFAULT NULL
      COMMENT '最近一次维修方案调整时间' AFTER repair_plan_status;
  END IF;
END$$

DELIMITER ;

CALL add_orders_repair_plan_columns();
DROP PROCEDURE add_orders_repair_plan_columns;
