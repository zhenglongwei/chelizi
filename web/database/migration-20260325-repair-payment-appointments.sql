-- 预约关联标品/维修单、自费维修款微信支付、货款流水 order_id、保险免佣默认关闭
-- mysql -u root -p zhejian < migration-20260325-repair-payment-appointments.sql

-- 1. 预约表：关联已付标品或已接单维修单
ALTER TABLE appointments
  ADD COLUMN product_order_id VARCHAR(32) DEFAULT NULL COMMENT '已支付标品订单' AFTER remark,
  ADD COLUMN order_id VARCHAR(32) DEFAULT NULL COMMENT '已接单维修订单' AFTER product_order_id,
  ADD KEY idx_product_order (product_order_id),
  ADD KEY idx_order (order_id);

-- 2. 维修单：车主支付维修款
ALTER TABLE orders
  ADD COLUMN repair_payment_status VARCHAR(24) DEFAULT NULL COMMENT 'pending_pay|paid|closed' AFTER commission_paid_amount,
  ADD COLUMN repair_out_trade_no VARCHAR(32) DEFAULT NULL COMMENT '微信商户订单号' AFTER repair_payment_status,
  ADD COLUMN repair_wx_transaction_id VARCHAR(64) DEFAULT NULL AFTER repair_out_trade_no,
  ADD COLUMN repair_prepay_id VARCHAR(128) DEFAULT NULL AFTER repair_wx_transaction_id,
  ADD COLUMN repair_paid_at DATETIME DEFAULT NULL AFTER repair_prepay_id,
  ADD UNIQUE KEY uk_repair_out_trade (repair_out_trade_no);

-- 3. 车主维修款支付意图
CREATE TABLE IF NOT EXISTS repair_order_payment_intents (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  intent_id VARCHAR(32) NOT NULL UNIQUE,
  order_id VARCHAR(32) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  out_trade_no VARCHAR(32) NOT NULL,
  amount_fen INT UNSIGNED NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  prepay_id VARCHAR(64) DEFAULT NULL,
  wx_transaction_id VARCHAR(64) DEFAULT NULL,
  raw_notify JSON DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_out_trade (out_trade_no),
  KEY idx_order (order_id),
  KEY idx_user (user_id),
  CONSTRAINT fk_ropt_order FOREIGN KEY (order_id) REFERENCES orders(order_id),
  CONSTRAINT fk_ropt_user FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='车主维修款微信支付单';

-- 4. 货款流水：支持维修单入账（与标品并列）
ALTER TABLE merchant_shop_income_ledger
  ADD COLUMN order_id VARCHAR(32) DEFAULT NULL COMMENT '维修单入账时填写' AFTER product_order_id,
  ADD UNIQUE KEY uk_repair_order_income (order_id);

-- 5. 保险单按规则收佣：关闭免佣默认
INSERT INTO settings (`key`, `value`, description)
VALUES ('commission_waive_insurance', '0', '1=保险事故单免佣 0=按规则收佣')
ON DUPLICATE KEY UPDATE `value` = '0', description = VALUES(description);
