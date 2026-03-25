-- 服务商标品货款：对公提现申请（财务线下打款 + 后台核销）
-- mysql -u root -p zhejian < migration-20260325-merchant-corp-income-withdraw.sql

CREATE TABLE IF NOT EXISTS merchant_income_corp_withdrawals (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(32) NOT NULL UNIQUE COMMENT '业务单号 MC 前缀',
  shop_id VARCHAR(32) NOT NULL,
  merchant_id VARCHAR(32) DEFAULT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  company_name VARCHAR(200) NOT NULL COMMENT '对公户名',
  bank_name VARCHAR(200) NOT NULL COMMENT '开户银行',
  bank_account_no VARCHAR(64) NOT NULL COMMENT '银行账号',
  bank_branch VARCHAR(300) DEFAULT NULL COMMENT '开户支行',
  contact_name VARCHAR(64) DEFAULT NULL,
  contact_phone VARCHAR(32) DEFAULT NULL,
  merchant_remark VARCHAR(500) DEFAULT NULL,
  status TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0待财务 1已完成 2已驳回 3商户已撤销',
  admin_remark VARCHAR(500) DEFAULT NULL,
  finance_ref VARCHAR(128) DEFAULT NULL COMMENT '财务打款凭证/流水号',
  processed_by VARCHAR(64) DEFAULT NULL,
  processed_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_shop_status (shop_id, status),
  KEY idx_shop_created (shop_id, created_at),
  KEY idx_status_created (status, created_at),
  CONSTRAINT fk_micw_shop FOREIGN KEY (shop_id) REFERENCES shops (shop_id),
  CONSTRAINT fk_micw_merchant FOREIGN KEY (merchant_id) REFERENCES merchant_users (merchant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='服务商标品货款对公提现';
