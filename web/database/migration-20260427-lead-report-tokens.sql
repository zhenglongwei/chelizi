-- Lead：外部引流报告 token（可分享阅读，但仅允许首次认领到车主账号后发起竞价）

CREATE TABLE IF NOT EXISTS lead_report_tokens (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  token_id VARCHAR(40) NOT NULL UNIQUE COMMENT '业务主键（明文 token 的前缀/标识）',
  token_hash CHAR(64) NOT NULL UNIQUE COMMENT 'SHA256(token)',
  report_id VARCHAR(32) NOT NULL COMMENT '关联 damage_reports.report_id',
  status TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '0-禁用 1-可用 2-已认领 3-已过期',
  claimed_user_id VARCHAR(32) DEFAULT NULL COMMENT '认领后的 user_id',
  claimed_at DATETIME DEFAULT NULL,
  expires_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_report_id (report_id),
  INDEX idx_status (status),
  INDEX idx_claimed_user (claimed_user_id),
  CONSTRAINT fk_lrt_report FOREIGN KEY (report_id) REFERENCES damage_reports(report_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='外部引流报告 token';

