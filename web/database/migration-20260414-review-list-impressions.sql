-- 主评列表曝光（去重：每用户每自然日每条评价最多一条），供互动轨 Q_m 曝光项 E_m 统计
-- 小程序上报 POST /api/v1/reviews/:id/impression 后写入（待接入路由时执行本迁移）

CREATE TABLE IF NOT EXISTS review_list_impressions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  review_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  impression_date DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_rid_uid_day (review_id, user_id, impression_date),
  KEY idx_review_day (review_id, impression_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='评价列表行曝光（日去重）';
