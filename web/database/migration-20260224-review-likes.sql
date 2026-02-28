-- ========================================================
-- 点赞追加奖金体系 Phase 1
-- review_likes、review_reading_sessions、reviews 扩展
-- ========================================================

-- 1. 有效阅读会话表（用于累计有效阅读时长，单次≤3分钟，总≤5分钟）
CREATE TABLE IF NOT EXISTS review_reading_sessions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(32) NOT NULL UNIQUE COMMENT '业务主键',
  review_id VARCHAR(32) NOT NULL COMMENT '评价ID',
  user_id VARCHAR(32) NOT NULL COMMENT '浏览用户',
  effective_seconds INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '本次有效阅读秒数（单次最多180）',
  saw_at DATETIME DEFAULT NULL COMMENT '「看到了」的时刻（≥50%入视口且≥1秒）',
  ended_at DATETIME DEFAULT NULL COMMENT '会话结束（划走/切后台/超3分钟）',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_review_user (review_id, user_id),
  INDEX idx_user_review (user_id, review_id),
  INDEX idx_saw_at (saw_at),
  FOREIGN KEY (review_id) REFERENCES reviews(review_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='评价有效阅读会话';

-- 2. 点赞记录表
CREATE TABLE IF NOT EXISTS review_likes (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  like_id VARCHAR(32) NOT NULL UNIQUE COMMENT '业务主键',
  review_id VARCHAR(32) NOT NULL COMMENT '评价ID',
  user_id VARCHAR(32) NOT NULL COMMENT '点赞用户',
  effective_reading_seconds INT UNSIGNED DEFAULT 0 COMMENT '点赞时累计的有效阅读时长（秒）',
  like_type VARCHAR(20) DEFAULT 'normal' COMMENT 'normal-普通 post_verify-事后验证',
  is_valid_for_bonus TINYINT UNSIGNED DEFAULT 0 COMMENT '是否纳入奖金核算 0-否 1-是',
  weight_coefficient DECIMAL(6,4) DEFAULT 0 COMMENT '账号综合权重系数',
  vehicle_match_by_plate TINYINT UNSIGNED DEFAULT 0 COMMENT '车型匹配 1=车牌一致 0=否',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_review (user_id, review_id),
  INDEX idx_review_id (review_id),
  INDEX idx_user_id (user_id),
  INDEX idx_created (created_at),
  FOREIGN KEY (review_id) REFERENCES reviews(review_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='评价点赞记录';

-- 3. reviews 表扩展（若列已存在会报错，可忽略）
ALTER TABLE reviews ADD COLUMN content_quality_level TINYINT UNSIGNED DEFAULT 1 COMMENT '内容质量等级 1-4' AFTER like_count;
ALTER TABLE reviews ADD COLUMN post_verify_like_count INT UNSIGNED DEFAULT 0 COMMENT '事后验证点赞数' AFTER content_quality_level;

-- 4. transactions 表 type 扩展（已有 rebate/withdraw/recharge，新增 like_bonus/conversion_bonus/post_verify_bonus）
-- 无需改表结构，type 为 VARCHAR，直接写入新值即可
