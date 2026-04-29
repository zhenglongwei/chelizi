-- Open API：第三方调用鉴权与审计（分发优先：先轻量可用）

CREATE TABLE IF NOT EXISTS api_keys (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  api_key_id VARCHAR(40) NOT NULL UNIQUE COMMENT '业务主键',
  api_key_hash CHAR(64) NOT NULL UNIQUE COMMENT 'SHA256(api_key)',
  owner_type VARCHAR(20) NOT NULL DEFAULT 'tenant' COMMENT 'tenant|shop|system',
  owner_id VARCHAR(64) NOT NULL COMMENT '租户/主体ID（自定义）',
  name VARCHAR(100) DEFAULT NULL COMMENT '用途名称',
  status TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '0-禁用 1-启用',
  daily_limit INT UNSIGNED DEFAULT 0 COMMENT '0=不限',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_owner (owner_type, owner_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='第三方OpenAPI Key';

CREATE TABLE IF NOT EXISTS api_call_audit (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  audit_id VARCHAR(50) NOT NULL UNIQUE COMMENT '业务主键',
  req_id VARCHAR(50) DEFAULT NULL,
  api_key_id VARCHAR(40) DEFAULT NULL,
  user_id VARCHAR(32) DEFAULT NULL,
  merchant_id VARCHAR(32) DEFAULT NULL,
  path VARCHAR(255) NOT NULL,
  method VARCHAR(10) NOT NULL,
  status_code INT NOT NULL,
  duration_ms INT NOT NULL,
  error_code VARCHAR(50) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created_at (created_at),
  INDEX idx_api_key (api_key_id),
  INDEX idx_path (path(120))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='OpenAPI调用审计（最小可用）';

