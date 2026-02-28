-- 4级爆款前置：车型+维修项目结构化
-- 用于「同车型同项目≤10条」统计
-- 执行：mysql -u root -p chelizi < migration-20260226-review-level4-keys.sql

USE chelizi;

DELIMITER $$

DROP PROCEDURE IF EXISTS add_review_level4_columns$$
CREATE PROCEDURE add_review_level4_columns()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reviews' AND COLUMN_NAME = 'vehicle_model_key'
  ) THEN
    ALTER TABLE reviews ADD COLUMN vehicle_model_key VARCHAR(100) DEFAULT NULL
      COMMENT '车型键 brand|model 用于同车型统计' AFTER content_quality_level;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reviews' AND COLUMN_NAME = 'repair_project_key'
  ) THEN
    ALTER TABLE reviews ADD COLUMN repair_project_key VARCHAR(255) DEFAULT NULL
      COMMENT '维修项目键 用于同项目统计' AFTER vehicle_model_key;
  END IF;
END$$

DELIMITER ;

CALL add_review_level4_columns();
DROP PROCEDURE add_review_level4_columns;

-- 2. 索引（同车型同项目≤10条查询）
CREATE INDEX idx_review_vehicle_project ON reviews (vehicle_model_key(50), repair_project_key(100), type, status);

-- 3. 回填：需由应用层脚本执行（见 web/scripts/backfill-review-level4-keys.js）
