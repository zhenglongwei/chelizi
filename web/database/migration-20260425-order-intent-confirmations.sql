-- 车主选定维修商“三重确认”留痕
-- 对齐《订单生灭周期与超时处理规则_V1.0》与产品约束：选定前强制停留+条款勾选，并生成确认书落库

CREATE TABLE IF NOT EXISTS order_intent_confirmations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  confirmation_id VARCHAR(40) NOT NULL UNIQUE COMMENT '业务主键',
  bidding_id VARCHAR(32) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  shop_id VARCHAR(32) NOT NULL,
  quote_id VARCHAR(32) NOT NULL,
  quoted_amount DECIMAL(10, 2) NOT NULL,
  dwell_seconds INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '强制停留秒数（客户端上报）',
  clauses JSON NOT NULL COMMENT '勾选条款快照 {required_clause_ids,checked_clause_ids,clauses_text_map}',
  client_confirmed_at DATETIME DEFAULT NULL COMMENT '客户端点击确认时间（可空，服务端以 created_at 为准）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_oic_bidding (bidding_id),
  INDEX idx_oic_user (user_id),
  INDEX idx_oic_shop (shop_id),
  INDEX idx_oic_created (created_at),
  CONSTRAINT fk_oic_bidding FOREIGN KEY (bidding_id) REFERENCES biddings(bidding_id),
  CONSTRAINT fk_oic_user FOREIGN KEY (user_id) REFERENCES users(user_id),
  CONSTRAINT fk_oic_shop FOREIGN KEY (shop_id) REFERENCES shops(shop_id),
  CONSTRAINT fk_oic_quote FOREIGN KEY (quote_id) REFERENCES quotes(quote_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='车主选定维修商意向确认书（选厂三重确认留痕）';

