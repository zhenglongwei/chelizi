-- 维修过程关键节点留痕（维修中多次上传，与 orders.completion_evidence 完工凭证区分）
CREATE TABLE IF NOT EXISTS order_repair_milestones (
  milestone_id VARCHAR(32) NOT NULL PRIMARY KEY,
  order_id VARCHAR(32) NOT NULL,
  shop_id VARCHAR(32) NOT NULL,
  milestone_code VARCHAR(64) NOT NULL,
  photo_urls JSON NOT NULL,
  note VARCHAR(500) DEFAULT NULL,
  created_by_merchant_id VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_order_created (order_id, created_at),
  KEY idx_shop (shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
