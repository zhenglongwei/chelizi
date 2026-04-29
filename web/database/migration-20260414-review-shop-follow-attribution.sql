-- 评价页「关注店铺」归因：记录 source_review_id，供订单转化归因与 §3.9 计划对齐
-- 执行：mysql -u root -p zhejian < web/database/migration-20260414-review-shop-follow-attribution.sql

CREATE TABLE IF NOT EXISTS review_shop_follow_attributions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id VARCHAR(64) NOT NULL,
  shop_id VARCHAR(64) NOT NULL,
  source_review_id VARCHAR(64) NOT NULL COMMENT '因哪条主评在评价上下文内关注',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user_shop (user_id, shop_id),
  KEY idx_source_review (source_review_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='店铺关注归因（评价上下文）';
