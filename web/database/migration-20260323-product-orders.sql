-- 车主商品直购订单（与竞价维修 orders 表并行）
-- mysql -u root -p zhejian < migration-20260323-product-orders.sql

CREATE TABLE IF NOT EXISTS product_orders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_order_id VARCHAR(32) NOT NULL UNIQUE COMMENT '业务主键',
  user_id VARCHAR(32) NOT NULL COMMENT '车主',
  shop_id VARCHAR(32) NOT NULL,
  product_id VARCHAR(32) NOT NULL,
  product_name_snapshot VARCHAR(200) NOT NULL,
  product_price_snapshot DECIMAL(10, 2) NOT NULL COMMENT '单价快照（元）',
  quantity INT UNSIGNED NOT NULL DEFAULT 1,
  amount_total DECIMAL(10, 2) NOT NULL COMMENT '应付总额（元）',
  payment_status VARCHAR(24) NOT NULL DEFAULT 'pending_pay' COMMENT 'pending_pay | paid | closed',
  out_trade_no VARCHAR(32) DEFAULT NULL COMMENT '微信商户订单号',
  wx_transaction_id VARCHAR(64) DEFAULT NULL,
  prepay_id VARCHAR(128) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  paid_at DATETIME DEFAULT NULL,
  UNIQUE KEY uk_out_trade_no (out_trade_no),
  KEY idx_user_id (user_id),
  KEY idx_shop_id (shop_id),
  KEY idx_payment_status (payment_status),
  CONSTRAINT fk_product_orders_user FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT fk_product_orders_shop FOREIGN KEY (shop_id) REFERENCES shops (shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='车主商品直购订单';
