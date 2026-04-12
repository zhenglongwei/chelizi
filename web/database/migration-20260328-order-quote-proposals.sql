-- 到店报价多轮记录：每轮须证明材料，车主确认；评价页全量公示
-- 执行前提：orders 已存在 pre_quote_snapshot / final_quote_status 等字段

CREATE TABLE IF NOT EXISTS order_quote_proposals (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  proposal_id VARCHAR(32) NOT NULL UNIQUE COMMENT '业务主键',
  order_id VARCHAR(32) NOT NULL,
  shop_id VARCHAR(32) NOT NULL,
  revision_no INT UNSIGNED NOT NULL COMMENT '同一订单内序号，从1递增',
  quote_snapshot JSON NOT NULL COMMENT '{items,value_added_services,amount,duration,warranty}',
  evidence JSON NOT NULL COMMENT '{photo_urls[],loss_assessment_documents?,supplement_note?}',
  status TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0=待车主确认 1=已确认 2=已拒绝',
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME DEFAULT NULL,
  resolver_user_id VARCHAR(32) DEFAULT NULL COMMENT '确认/拒绝的车主 user_id',
  INDEX idx_order_id (order_id),
  INDEX idx_order_pending (order_id, status),
  CONSTRAINT fk_oqp_order FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单到店报价轮次（多轮确认）';
