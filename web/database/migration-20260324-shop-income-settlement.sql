-- 标品支付货款入账（店铺可提现余额）+ 服务商货款提现单
-- mysql -u root -p zhejian < migration-20260324-shop-income-settlement.sql

-- 1. 佣金钱包：标品货款可用 / 提现冻结（与 balance/frozen 佣金语义分离）
ALTER TABLE merchant_commission_wallets
  ADD COLUMN income_balance DECIMAL(12, 2) NOT NULL DEFAULT 0.00 COMMENT '标品货款可提现余额(元)' AFTER frozen,
  ADD COLUMN income_frozen DECIMAL(12, 2) NOT NULL DEFAULT 0.00 COMMENT '标品货款提现处理中冻结(元)' AFTER income_balance;

-- 2. 商品订单：平台抽成与结算状态
ALTER TABLE product_orders
  ADD COLUMN platform_fee_yuan DECIMAL(10, 2) DEFAULT NULL COMMENT '平台抽成(元)' AFTER amount_total,
  ADD COLUMN shop_settle_yuan DECIMAL(10, 2) DEFAULT NULL COMMENT '店铺应收(元)' AFTER platform_fee_yuan,
  ADD COLUMN settlement_status VARCHAR(24) DEFAULT NULL COMMENT 'NULL=未结算 paid=已支付待入账 settled=已入账' AFTER paid_at,
  ADD COLUMN settled_at DATETIME DEFAULT NULL COMMENT '货款入账时间' AFTER settlement_status;

CREATE TABLE IF NOT EXISTS merchant_shop_income_ledger (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ledger_id VARCHAR(32) NOT NULL UNIQUE,
  shop_id VARCHAR(32) NOT NULL,
  type VARCHAR(32) NOT NULL COMMENT 'product_order_settle|withdraw_payout|withdraw_refund',
  amount DECIMAL(12, 2) NOT NULL COMMENT '正=入可提现余额 负=出账',
  balance_after DECIMAL(12, 2) DEFAULT NULL COMMENT '入账后 income_balance（不含 frozen）',
  product_order_id VARCHAR(32) DEFAULT NULL,
  withdraw_id VARCHAR(32) DEFAULT NULL,
  remark VARCHAR(500) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_product_order_settle (product_order_id),
  KEY idx_shop_created (shop_id, created_at),
  KEY idx_withdraw (withdraw_id),
  CONSTRAINT fk_shop_income_shop FOREIGN KEY (shop_id) REFERENCES shops (shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='服务商标品货款流水';

CREATE TABLE IF NOT EXISTS merchant_income_withdrawals (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  withdraw_id VARCHAR(32) NOT NULL UNIQUE COMMENT '商户单号=微信 out_bill_no',
  shop_id VARCHAR(32) NOT NULL,
  merchant_id VARCHAR(32) DEFAULT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  status TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0待微信确认 1成功 2失败 3已撤销',
  remark VARCHAR(200) DEFAULT NULL,
  wx_transfer_bill_no VARCHAR(64) DEFAULT NULL,
  wx_bill_state VARCHAR(32) DEFAULT NULL,
  wx_package_info TEXT DEFAULT NULL,
  processed_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_shop_status (shop_id, status),
  KEY idx_shop_created (shop_id, created_at),
  CONSTRAINT fk_miwd_shop FOREIGN KEY (shop_id) REFERENCES shops (shop_id),
  CONSTRAINT fk_miwd_merchant FOREIGN KEY (merchant_id) REFERENCES merchant_users (merchant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='服务商标品货款提现';

INSERT INTO settings (`key`, `value`)
VALUES ('product_order_platform_fee_rate', '0')
ON DUPLICATE KEY UPDATE `key` = `key`;
