-- ========================================================
-- 第三阶段防刷 - 违规处理、审计日志、防刷报表
-- 执行：mysql -u user -p chelizi < migration-20260215-phase3-antifraud.sql
-- ========================================================

USE chelizi;

-- 1. 违规记录表
CREATE TABLE IF NOT EXISTS violation_records (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  record_id VARCHAR(32) NOT NULL UNIQUE COMMENT '业务主键',
  target_type VARCHAR(20) NOT NULL COMMENT 'user/shop',
  target_id VARCHAR(32) NOT NULL COMMENT '用户ID或店铺ID',
  violation_level TINYINT UNSIGNED NOT NULL COMMENT '1-4 级',
  violation_type VARCHAR(50) DEFAULT NULL COMMENT '违规类型',
  related_order_id VARCHAR(32) DEFAULT NULL,
  related_review_id VARCHAR(32) DEFAULT NULL,
  description TEXT DEFAULT NULL COMMENT '违规描述',
  penalty_applied JSON DEFAULT NULL COMMENT '已执行处罚',
  status TINYINT UNSIGNED DEFAULT 0 COMMENT '0-待处理 1-已处理 2-已申诉 3-申诉通过',
  operator_id VARCHAR(32) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME DEFAULT NULL,
  INDEX idx_target (target_type, target_id),
  INDEX idx_level (violation_level),
  INDEX idx_status (status),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='违规记录';

-- 2. 审计日志表（关键操作留痕）
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  log_type VARCHAR(50) NOT NULL COMMENT 'rule_change/blacklist/violation/config',
  action VARCHAR(50) NOT NULL COMMENT 'create/update/delete/execute',
  target_table VARCHAR(50) DEFAULT NULL,
  target_id VARCHAR(64) DEFAULT NULL,
  old_value JSON DEFAULT NULL,
  new_value JSON DEFAULT NULL,
  operator_id VARCHAR(32) DEFAULT NULL,
  operator_role VARCHAR(32) DEFAULT NULL,
  ip VARCHAR(64) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_type (log_type),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='审计日志';

-- 3. 申诉记录表
CREATE TABLE IF NOT EXISTS appeal_records (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  appeal_id VARCHAR(32) NOT NULL UNIQUE,
  violation_record_id VARCHAR(32) NOT NULL,
  target_type VARCHAR(20) NOT NULL,
  target_id VARCHAR(32) NOT NULL,
  reason TEXT DEFAULT NULL,
  attachments JSON DEFAULT NULL,
  status TINYINT UNSIGNED DEFAULT 0 COMMENT '0-待复核 1-通过 2-驳回',
  reviewer_id VARCHAR(32) DEFAULT NULL,
  review_note TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME DEFAULT NULL,
  INDEX idx_violation (violation_record_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='申诉记录';

-- 4. 内容反作弊配置
INSERT INTO settings (`key`, `value`, `description`) VALUES
('antifraud_content_min_length', '10', '评价内容最小有效字数'),
('antifraud_content_similarity_threshold', '60', '与已有评价重复度阈值(%)，超过则驳回'),
('antifraud_water_words', '不错,很好,划算,可以,满意', '无意义水评关键词，含任一且无其他有效内容则驳回')
ON DUPLICATE KEY UPDATE `key`=`key`;
