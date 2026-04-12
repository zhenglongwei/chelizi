-- 主评价：车主是否授权在店铺评价列表/口碑流等公示场景展示本评价相关全部图片（提交后不可改）
-- 1=对外展示 0=不展示（公示 API 不下发图 URL，不影响 content_quality/奖励计算）
-- 可重复执行：若列已存在则跳过（避免 1060 Duplicate column）
-- 执行：mysql -u用户 -p 数据库名 < migration-20260405-review-images-public.sql

DELIMITER $$

DROP PROCEDURE IF EXISTS migrate_review_images_public$$
CREATE PROCEDURE migrate_review_images_public()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reviews' AND COLUMN_NAME = 'review_images_public'
  ) THEN
    ALTER TABLE reviews ADD COLUMN review_images_public TINYINT UNSIGNED NOT NULL DEFAULT 1
      COMMENT '1=对外展示本评价全部相关图 0=公示不下发图URL'
      AFTER is_anonymous;
  END IF;
END$$

DELIMITER ;

CALL migrate_review_images_public();
DROP PROCEDURE migrate_review_images_public;
