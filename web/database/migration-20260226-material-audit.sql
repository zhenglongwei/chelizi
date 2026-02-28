-- 材料 AI 审核任务表（1→2 异步审核）
-- 执行：mysql -u root -p chelizi < migration-20260226-material-audit.sql

-- 1. 材料审核任务表
CREATE TABLE IF NOT EXISTS material_audit_tasks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id VARCHAR(32) NOT NULL UNIQUE COMMENT '任务唯一ID',
  order_id VARCHAR(32) NOT NULL COMMENT '订单ID',
  shop_id VARCHAR(32) NOT NULL COMMENT '店铺ID',
  completion_evidence JSON NOT NULL COMMENT '维修完成凭证 {repair_photos,settlement_photos,material_photos}',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending=待审核 passed=通过 rejected=不通过',
  reject_reason VARCHAR(500) DEFAULT NULL COMMENT '不通过原因',
  ai_details JSON DEFAULT NULL COMMENT 'AI 审核详情',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME DEFAULT NULL,
  INDEX idx_order_status (order_id, status),
  INDEX idx_pending (status),
  INDEX idx_created (created_at),
  FOREIGN KEY (order_id) REFERENCES orders(order_id),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='材料AI审核任务';
