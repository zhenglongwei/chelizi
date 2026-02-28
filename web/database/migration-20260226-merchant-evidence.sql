-- 商户申诉任务表 + 店铺违规记录表（阶段2、3）
-- 执行：mysql -u root -p chelizi < migration-20260226-merchant-evidence.sql

-- 1. 商户申诉任务表（表名 merchant_evidence_requests 保留兼容）
CREATE TABLE IF NOT EXISTS merchant_evidence_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(32) NOT NULL UNIQUE COMMENT '业务主键',
  order_id VARCHAR(32) NOT NULL COMMENT '订单ID',
  review_id VARCHAR(32) NOT NULL COMMENT '评价ID',
  shop_id VARCHAR(32) NOT NULL COMMENT '店铺ID',
  question_key VARCHAR(32) NOT NULL COMMENT 'q1_progress_synced / q2_parts_shown',
  status TINYINT UNSIGNED DEFAULT 0 COMMENT '0=待申诉 1=已申诉待审核 2=申诉有效 3=申诉无效/超时',
  deadline DATETIME NOT NULL COMMENT '截止时间（通知发送+48h）',
  evidence_urls JSON DEFAULT NULL COMMENT '申诉材料URL数组',
  ai_result VARCHAR(50) DEFAULT NULL COMMENT 'AI初审结果',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_order_question (order_id, question_key),
  INDEX idx_shop_status (shop_id, status),
  INDEX idx_deadline (deadline),
  FOREIGN KEY (order_id) REFERENCES orders(order_id),
  FOREIGN KEY (review_id) REFERENCES reviews(review_id),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='商户申诉任务';

-- 2. 店铺违规记录表
CREATE TABLE IF NOT EXISTS shop_violations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  shop_id VARCHAR(32) NOT NULL COMMENT '店铺ID',
  order_id VARCHAR(32) NOT NULL COMMENT '订单ID',
  violation_type VARCHAR(50) NOT NULL COMMENT 'progress_not_synced / parts_not_shown',
  penalty INT NOT NULL COMMENT '扣分 5/15',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_shop_created (shop_id, created_at),
  INDEX idx_order (order_id),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id),
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='店铺违规记录';
