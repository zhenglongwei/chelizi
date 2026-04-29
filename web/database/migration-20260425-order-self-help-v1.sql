-- 订单自救入口：维修商未处理 / 强制结单 / 等待配件延期

CREATE TABLE IF NOT EXISTS order_self_help_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(40) NOT NULL UNIQUE COMMENT '业务主键',
  order_id VARCHAR(32) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  request_type VARCHAR(32) NOT NULL COMMENT 'merchant_not_handled|force_close',
  note VARCHAR(500) DEFAULT NULL,
  image_urls JSON DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'submitted' COMMENT 'submitted|approved|rejected|cancelled|processed',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_oshr_order (order_id),
  INDEX idx_oshr_type_status (request_type, status),
  CONSTRAINT fk_oshr_order FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单自救请求（车主侧）';

CREATE TABLE IF NOT EXISTS order_waiting_parts_extensions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  extension_id VARCHAR(40) NOT NULL UNIQUE COMMENT '业务主键',
  order_id VARCHAR(32) NOT NULL,
  shop_id VARCHAR(32) NOT NULL,
  note VARCHAR(500) DEFAULT NULL,
  proof_urls JSON NOT NULL COMMENT '采购/到货等凭证',
  extend_days INT UNSIGNED NOT NULL DEFAULT 15,
  status VARCHAR(20) NOT NULL DEFAULT 'submitted' COMMENT 'submitted|approved|rejected',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_owpe_order (order_id),
  INDEX idx_owpe_status (status),
  CONSTRAINT fk_owpe_order FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='等待配件延期申请（服务商侧）';

