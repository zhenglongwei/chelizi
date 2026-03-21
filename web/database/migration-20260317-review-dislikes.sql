-- 踩功能：评价内容质量负向反馈
-- 与 02-评价内容质量等级体系、04-点赞追加奖金体系 联动
CREATE TABLE IF NOT EXISTS review_dislikes (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  dislike_id VARCHAR(32) NOT NULL UNIQUE COMMENT '业务主键',
  review_id VARCHAR(32) NOT NULL COMMENT '评价ID',
  user_id VARCHAR(32) NOT NULL COMMENT '踩的用户',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_review (user_id, review_id),
  INDEX idx_review_id (review_id),
  INDEX idx_user_id (user_id),
  FOREIGN KEY (review_id) REFERENCES reviews(review_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='评价踩记录（负向权重，影响内容质量与奖金）';

-- 添加踩数字段（执行前请确认 reviews 表无 dislike_count 列，否则会报错可忽略）
ALTER TABLE reviews ADD COLUMN dislike_count INT UNSIGNED DEFAULT 0 COMMENT '踩数量' AFTER like_count;
