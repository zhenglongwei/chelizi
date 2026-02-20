-- 添加 AI 定损每日调用次数限制相关表与配置
-- 执行：mysql -u user -p chelizi < add_ai_limit.sql

-- 1. AI 调用记录表（用于统计每日调用次数）
CREATE TABLE IF NOT EXISTS ai_call_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
  report_id VARCHAR(32) DEFAULT NULL COMMENT '关联报告ID',
  call_date DATE NOT NULL COMMENT '调用日期',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_date (user_id, call_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI定损调用记录';

-- 2. 默认配置：每日调用次数上限（运营后台可修改）
INSERT INTO settings (`key`, `value`, `description`) VALUES
('ai_daily_limit', '5', '每用户每日AI定损调用次数上限')
ON DUPLICATE KEY UPDATE `key`=`key`;
