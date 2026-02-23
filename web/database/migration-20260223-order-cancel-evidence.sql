-- ========================================================
-- 订单撤单与维修完成凭证
-- 按《订单撤单与维修完成流程.md》：
-- 1. orders 新增 accepted_at、completion_evidence
-- 2. 新增 order_cancel_requests 表
-- 执行：mysql -u 用户名 -p 数据库名 < migration-20260223-order-cancel-evidence.sql
-- ========================================================

USE chelizi;

DELIMITER $$

DROP PROCEDURE IF EXISTS add_orders_cancel_evidence_columns$$
CREATE PROCEDURE add_orders_cancel_evidence_columns()
BEGIN
  -- accepted_at: 服务商接单时间，用于撤单 30 分钟判断
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'accepted_at'
  ) THEN
    ALTER TABLE orders ADD COLUMN accepted_at DATETIME DEFAULT NULL
      COMMENT '服务商接单时间（接单时写入，用于撤单 30 分钟判断）' AFTER status;
  END IF;

  -- completion_evidence: 维修完成凭证 JSON
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'completion_evidence'
  ) THEN
    ALTER TABLE orders ADD COLUMN completion_evidence JSON DEFAULT NULL
      COMMENT '维修完成凭证 {repair_photos,settlement_photos,material_photos}' AFTER accepted_at;
  END IF;
END$$

DELIMITER ;

CALL add_orders_cancel_evidence_columns();
DROP PROCEDURE add_orders_cancel_evidence_columns;

-- 订单撤单申请表
CREATE TABLE IF NOT EXISTS order_cancel_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(32) NOT NULL UNIQUE COMMENT '业务主键',
  order_id VARCHAR(32) NOT NULL COMMENT '订单ID',
  user_id VARCHAR(32) NOT NULL COMMENT '发起人（车主）',
  reason VARCHAR(500) NOT NULL COMMENT '撤单理由（超过 30 分钟必填）',
  status TINYINT UNSIGNED DEFAULT 0 COMMENT '0=待服务商处理 1=服务商同意 2=服务商拒绝 3=已提交人工 4=人工同意 5=人工拒绝',
  shop_response_at DATETIME DEFAULT NULL COMMENT '服务商响应时间',
  escalated_at DATETIME DEFAULT NULL COMMENT '车主提交人工通道时间',
  admin_resolution VARCHAR(20) DEFAULT NULL COMMENT '人工处理：approved/rejected',
  admin_resolved_at DATETIME DEFAULT NULL COMMENT '人工处理时间',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_request_id (request_id),
  INDEX idx_order_id (order_id),
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  FOREIGN KEY (order_id) REFERENCES orders(order_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单撤单申请';
