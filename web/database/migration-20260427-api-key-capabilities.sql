-- OpenAPI：API Key 能力开通映射（主体级 entitlement 最小可用）
-- 依赖 migration-20260426-api-keys-and-audit.sql 中的 api_keys

CREATE TABLE IF NOT EXISTS api_key_capabilities (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  api_key_id VARCHAR(40) NOT NULL COMMENT '业务主键，对应 api_keys.api_key_id',
  capability_key VARCHAR(100) NOT NULL COMMENT '能力 key，如 damage.report_share',
  status TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '0-禁用 1-启用',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_api_key_cap (api_key_id, capability_key),
  INDEX idx_api_key_id (api_key_id),
  INDEX idx_capability_key (capability_key),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='OpenAPI Key 能力开通映射';

