-- 极简评价 v3：分项公示勾选 + 系统/AI 校验结果 JSON
-- 兼容旧库：若缺少 review_images_public，会先补该列再追加 JSON 列（避免 AFTER 引用不存在列导致 1054）
-- 执行：mysql -u用户 -p 你的库名 < migration-20260406-review-minimal-v3.sql

DELIMITER $$

DROP PROCEDURE IF EXISTS migrate_review_minimal_v3$$
CREATE PROCEDURE migrate_review_minimal_v3()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reviews' AND COLUMN_NAME = 'review_images_public'
  ) THEN
    ALTER TABLE reviews ADD COLUMN review_images_public TINYINT UNSIGNED NOT NULL DEFAULT 1
      COMMENT '1=对外展示本评价全部相关图 0=公示不下发图URL' AFTER is_anonymous;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reviews' AND COLUMN_NAME = 'review_public_media'
  ) THEN
    ALTER TABLE reviews ADD COLUMN review_public_media JSON DEFAULT NULL
      COMMENT '分项公开展示勾选 exterior_before_after/parts_contrast/settlement_docs/other；NULL=沿用 review_images_public'
      AFTER review_images_public;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reviews' AND COLUMN_NAME = 'review_system_checks'
  ) THEN
    ALTER TABLE reviews ADD COLUMN review_system_checks JSON DEFAULT NULL
      COMMENT '报价流程节点、外观修复度等系统/AI 校验快照'
      AFTER review_public_media;
  END IF;
END$$

DELIMITER ;

CALL migrate_review_minimal_v3();
DROP PROCEDURE migrate_review_minimal_v3;
