-- 内容转化 + 事后验证 - 防重复结算
-- 记录已发放事后验证的订单，避免重复支付

CREATE TABLE IF NOT EXISTS post_verify_settled_orders (
  order_id VARCHAR(32) NOT NULL PRIMARY KEY COMMENT '已发放事后验证的订单ID',
  settlement_month VARCHAR(7) NOT NULL COMMENT '结算月份',
  settled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_settlement_month (settlement_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='已发放事后验证补发的订单';
