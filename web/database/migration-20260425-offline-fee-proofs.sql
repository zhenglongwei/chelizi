-- 拆检费线下支付留痕（平台不收款，仅存证）

CREATE TABLE IF NOT EXISTS order_offline_fee_proofs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  proof_id VARCHAR(40) NOT NULL UNIQUE COMMENT '业务主键',
  order_id VARCHAR(32) NOT NULL,
  uploader_type VARCHAR(16) NOT NULL COMMENT 'user/merchant/admin',
  uploader_id VARCHAR(32) DEFAULT NULL,
  proof_kind VARCHAR(32) NOT NULL COMMENT 'diagnostic_fee_payment|diagnostic_fee_receipt',
  amount DECIMAL(10, 2) DEFAULT NULL COMMENT '线下支付金额（可选）',
  note VARCHAR(500) DEFAULT NULL COMMENT '备注（可选）',
  image_urls JSON NOT NULL COMMENT '凭证图片 URL 数组',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_oofp_order (order_id),
  INDEX idx_oofp_kind_time (proof_kind, created_at),
  CONSTRAINT fk_oofp_order FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单拆检费线下支付留痕凭证';

