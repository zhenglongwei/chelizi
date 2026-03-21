-- 评价聚合页新鲜度：用户看过某条评价后，3天内不再展示
-- 用于 GET /api/v1/reviews/feed 的 exclude_recently_viewed 逻辑

CREATE TABLE IF NOT EXISTS review_feed_views (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL COMMENT '浏览用户',
  review_id VARCHAR(32) NOT NULL COMMENT '评价ID',
  viewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首次展示时间',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uk_user_review (user_id, review_id),
  INDEX idx_user_viewed (user_id, viewed_at),
  INDEX idx_review (review_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (review_id) REFERENCES reviews(review_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='评价聚合页浏览记录（新鲜度：3天内不重复展示）';
