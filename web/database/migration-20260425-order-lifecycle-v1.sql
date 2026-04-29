-- 订单生灭周期与超时处理规则（V1.0）- 生命周期状态机与倒计时字段

-- 1) orders 扩展：主/子状态 + 倒计时起算与截止时间 + 关键节点时间戳
ALTER TABLE orders
  ADD COLUMN lifecycle_main VARCHAR(32) DEFAULT NULL COMMENT '生命周期主状态 pending_confirm/pending_arrival/pending_disassembly/pending_decision/repairing/pending_delivery/pending_review/completed/cancelled' AFTER status,
  ADD COLUMN lifecycle_sub VARCHAR(32) DEFAULT NULL COMMENT '生命周期子状态（细分阶段）' AFTER lifecycle_main,
  ADD COLUMN lifecycle_started_at DATETIME DEFAULT NULL COMMENT '本阶段倒计时起算点' AFTER lifecycle_sub,
  ADD COLUMN lifecycle_deadline_at DATETIME DEFAULT NULL COMMENT '本阶段硬截止时间' AFTER lifecycle_started_at,
  ADD COLUMN owner_arrived_at DATETIME DEFAULT NULL COMMENT '车主标记到店时间' AFTER lifecycle_deadline_at,
  ADD COLUMN shop_arrival_confirmed_at DATETIME DEFAULT NULL COMMENT '服务商确认到店时间' AFTER owner_arrived_at,
  ADD COLUMN disassembly_started_at DATETIME DEFAULT NULL COMMENT '拆解开始时间' AFTER shop_arrival_confirmed_at,
  ADD COLUMN disassembly_completed_at DATETIME DEFAULT NULL COMMENT '拆解完成时间' AFTER disassembly_started_at,
  ADD COLUMN owner_decision_at DATETIME DEFAULT NULL COMMENT '车主决策时间（同意/拒修）' AFTER disassembly_completed_at,
  ADD COLUMN promised_delivery_at DATETIME DEFAULT NULL COMMENT '承诺交车时间（硬deadline）' AFTER owner_decision_at,
  ADD COLUMN delivery_confirmed_at DATETIME DEFAULT NULL COMMENT '车主确认交车时间' AFTER promised_delivery_at,
  ADD COLUMN review_due_at DATETIME DEFAULT NULL COMMENT '待评价截止时间（默认交车后+7天）' AFTER delivery_confirmed_at,
  ADD COLUMN appeal_until DATETIME DEFAULT NULL COMMENT '质量申诉期截止（默认完结后+15天）' AFTER review_due_at;

-- 2) 订单生命周期事件留痕（便于运营/客服追溯超时推进）
CREATE TABLE IF NOT EXISTS order_lifecycle_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(40) NOT NULL UNIQUE COMMENT '业务主键',
  order_id VARCHAR(32) NOT NULL,
  actor_type VARCHAR(16) NOT NULL COMMENT 'system/user/merchant/admin',
  actor_id VARCHAR(32) DEFAULT NULL,
  event_type VARCHAR(40) NOT NULL COMMENT 'init/arrived/arrival_confirmed/timeout_cancel/timeout_push/... ',
  payload JSON DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ole_order (order_id),
  INDEX idx_ole_type_time (event_type, created_at),
  CONSTRAINT fk_ole_order FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单生命周期事件日志';

