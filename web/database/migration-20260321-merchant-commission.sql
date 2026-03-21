-- 服务商佣金账户、微信支付意图、订单两阶段计佣
-- 若 orders 已有 is_insurance_accident（见 migration-20260219-full-indicator.sql），请勿重复添加。

ALTER TABLE orders
  ADD COLUMN commission_status VARCHAR(32) DEFAULT NULL COMMENT 'waived_insurance|legacy_exempt|paid_provisional|arrears|awaiting_pay|finalized' AFTER commission,
  ADD COLUMN commission_provisional DECIMAL(10,2) DEFAULT NULL COMMENT '阶段A暂计佣金' AFTER commission_status,
  ADD COLUMN commission_final DECIMAL(10,2) DEFAULT NULL COMMENT '阶段B最终佣金' AFTER commission_provisional,
  ADD COLUMN commission_paid_amount DECIMAL(10,2) DEFAULT 0 COMMENT '本单已收佣金累计' AFTER commission_final,
  ADD COLUMN repair_payment_proof JSON DEFAULT NULL COMMENT '维修款支付凭证URL数组' AFTER commission_paid_amount;

UPDATE orders SET commission_status = 'legacy_exempt' WHERE status = 3 AND commission IS NOT NULL AND commission_status IS NULL;

CREATE TABLE IF NOT EXISTS merchant_commission_wallets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  shop_id VARCHAR(32) NOT NULL UNIQUE COMMENT '维修厂ID',
  balance DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '可用余额(元)',
  frozen DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '冻结(元)',
  deduct_mode VARCHAR(16) NOT NULL DEFAULT 'auto' COMMENT 'auto|per_order',
  low_balance_notified_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='服务商佣金钱包';

CREATE TABLE IF NOT EXISTS merchant_commission_ledger (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ledger_id VARCHAR(32) NOT NULL UNIQUE,
  shop_id VARCHAR(32) NOT NULL,
  type VARCHAR(32) NOT NULL COMMENT 'recharge|deduct_provisional|deduct_finalize|wx_order_pay|refund|adjust_credit|adjust_debit',
  amount DECIMAL(12,2) NOT NULL,
  balance_after DECIMAL(12,2) DEFAULT NULL,
  order_id VARCHAR(32) DEFAULT NULL,
  payment_intent_id VARCHAR(32) DEFAULT NULL,
  wx_transaction_id VARCHAR(64) DEFAULT NULL,
  remark VARCHAR(500) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_shop_created (shop_id, created_at),
  INDEX idx_order (order_id),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='服务商佣金流水';

CREATE TABLE IF NOT EXISTS merchant_commission_payment_intents (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  intent_id VARCHAR(32) NOT NULL UNIQUE,
  shop_id VARCHAR(32) NOT NULL,
  merchant_id VARCHAR(32) DEFAULT NULL,
  kind VARCHAR(24) NOT NULL COMMENT 'recharge|order_commission',
  order_id VARCHAR(32) DEFAULT NULL,
  out_trade_no VARCHAR(32) NOT NULL,
  amount_fen INT UNSIGNED NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  prepay_id VARCHAR(64) DEFAULT NULL,
  wx_transaction_id VARCHAR(64) DEFAULT NULL,
  refunded_fen INT UNSIGNED NOT NULL DEFAULT 0,
  raw_notify JSON DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_out_trade (out_trade_no),
  INDEX idx_shop_status (shop_id, status),
  INDEX idx_order (order_id),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='佣金微信支付单';

INSERT INTO settings (`key`, `value`) VALUES
  ('commission_waive_insurance', '1'),
  ('commission_low_balance_threshold_yuan', '100')
ON DUPLICATE KEY UPDATE `key` = `key`;
