-- ========================================================
-- 评价和激励体系 - 数据库变更迁移脚本
-- 适用于已存在旧 schema 的数据库
-- 执行前请备份数据
-- ========================================================

USE chelizi;

-- 1. shops 表新增字段
ALTER TABLE shops
  ADD COLUMN compliance_rate DECIMAL(5, 2) DEFAULT NULL COMMENT 'AI校验维修合规率(%)',
  ADD COLUMN complaint_rate DECIMAL(5, 2) DEFAULT NULL COMMENT '用户有效投诉率(%)',
  ADD COLUMN qualification_level VARCHAR(20) DEFAULT NULL COMMENT '维修资质等级',
  ADD COLUMN technician_certs JSON DEFAULT NULL COMMENT '技师持证情况';

-- 2. orders 表新增字段
ALTER TABLE orders
  ADD COLUMN order_tier TINYINT UNSIGNED DEFAULT NULL COMMENT '订单分级 1-4',
  ADD COLUMN complexity_level VARCHAR(10) DEFAULT NULL COMMENT '维修项目复杂度 L1-L4',
  ADD COLUMN vehicle_price_tier VARCHAR(20) DEFAULT NULL COMMENT '车价分级 low/mid/high',
  ADD COLUMN reward_preview DECIMAL(10, 2) DEFAULT NULL COMMENT '奖励金预估',
  ADD COLUMN review_stage_status VARCHAR(50) DEFAULT NULL COMMENT '评价阶段完成状态';

-- 3. reviews 表新增字段（需在 rating 前插入新字段时，可分批执行）
ALTER TABLE reviews
  ADD COLUMN review_stage VARCHAR(20) DEFAULT NULL COMMENT 'main/1m/3m',
  ADD COLUMN settlement_list_image VARCHAR(500) DEFAULT NULL COMMENT '维修结算清单图片URL',
  ADD COLUMN completion_images JSON DEFAULT NULL COMMENT '完工实拍图URL数组',
  ADD COLUMN objective_answers JSON DEFAULT NULL COMMENT '客观题答案',
  ADD COLUMN reward_amount DECIMAL(10, 2) DEFAULT NULL COMMENT '奖励金金额',
  ADD COLUMN tax_deducted DECIMAL(10, 2) DEFAULT 0.00 COMMENT '代扣个税';

-- 4. transactions 表新增字段
ALTER TABLE transactions
  ADD COLUMN reward_tier TINYINT UNSIGNED DEFAULT NULL COMMENT '订单分级 1-4',
  ADD COLUMN review_stage VARCHAR(20) DEFAULT NULL COMMENT 'main/1m/3m',
  ADD COLUMN tax_deducted DECIMAL(10, 2) DEFAULT 0.00 COMMENT '代扣个税';

-- 5. reviews.rating 改为可空（原 NOT NULL）
ALTER TABLE reviews MODIFY COLUMN rating TINYINT UNSIGNED DEFAULT NULL COMMENT '综合评分 1-5（选填）';

-- 6. 插入新配置
INSERT INTO settings (`key`, `value`, `description`) VALUES
('require_settlement_before_review', '0', '是否需等分账完成才允许评价/返现 0-否 1-是')
ON DUPLICATE KEY UPDATE `key`=`key`;

-- 7. 新增表
CREATE TABLE IF NOT EXISTS repair_complexity_levels (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `level` VARCHAR(10) NOT NULL COMMENT 'L1/L2/L3/L4',
  project_type VARCHAR(100) NOT NULL COMMENT '维修项目类型',
  fixed_reward DECIMAL(10, 2) NOT NULL COMMENT '固定奖励（元）',
  float_ratio DECIMAL(4, 2) NOT NULL COMMENT '浮动比例(%)',
  cap_amount DECIMAL(10, 2) NOT NULL COMMENT '单项目封顶（元）',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_level (level),
  INDEX idx_project_type (project_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reward_rules (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  rule_key VARCHAR(50) NOT NULL UNIQUE,
  rule_value JSON DEFAULT NULL,
  description VARCHAR(200) DEFAULT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS review_dimensions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  review_id VARCHAR(32) NOT NULL,
  dimension VARCHAR(20) NOT NULL COMMENT 'quote/process/completion',
  score TINYINT UNSIGNED DEFAULT NULL,
  answers JSON DEFAULT NULL,
  images JSON DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_review_id (review_id),
  INDEX idx_dimension (dimension)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS review_audit_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  review_id VARCHAR(32) NOT NULL,
  audit_type VARCHAR(20) NOT NULL COMMENT 'ai/manual',
  result VARCHAR(20) NOT NULL COMMENT 'pass/reject',
  missing_items JSON DEFAULT NULL,
  operator_id VARCHAR(32) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_review_id (review_id),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS complexity_upgrade_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(32) NOT NULL UNIQUE,
  order_id VARCHAR(32) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  current_level VARCHAR(10) DEFAULT NULL,
  requested_level VARCHAR(10) NOT NULL,
  reason TEXT DEFAULT NULL,
  status TINYINT UNSIGNED DEFAULT 0 COMMENT '0-待审核 1-通过 2-拒绝',
  auditor_id VARCHAR(32) DEFAULT NULL,
  audited_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_request_id (request_id),
  INDEX idx_user_id (user_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
