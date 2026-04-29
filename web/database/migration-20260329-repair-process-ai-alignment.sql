-- 过程 AI、评价吻合系数、异常单队列、评价流轻量曝光（完工不卡审 + 过程 AI 评信）
-- 执行：mysql ... < migration-20260329-repair-process-ai-alignment.sql
-- 若列已存在会报错，可忽略或手工注释已执行段落

ALTER TABLE orders
  ADD COLUMN repair_process_ai JSON DEFAULT NULL COMMENT '全流程过程 AI 结构化结果' AFTER completion_evidence;

ALTER TABLE reviews
  ADD COLUMN evidence_alignment_coeff DECIMAL(5,4) NOT NULL DEFAULT 1.0000 COMMENT '过程-评价吻合系数 0~1' AFTER q3_weight_excluded,
  ADD COLUMN anomaly_status VARCHAR(24) DEFAULT NULL COMMENT '证据异常单 pending/resolved/dismissed' AFTER evidence_alignment_coeff,
  ADD COLUMN review_discovery_boost DECIMAL(6,4) NOT NULL DEFAULT 1.0000 COMMENT '评价流排序轻量乘子' AFTER anomaly_status;

CREATE TABLE IF NOT EXISTS review_evidence_anomaly_tasks (
  task_id VARCHAR(40) NOT NULL PRIMARY KEY COMMENT '异常单业务主键',
  order_id VARCHAR(32) NOT NULL,
  review_id VARCHAR(32) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  shop_id VARCHAR(32) NOT NULL,
  trigger_reason VARCHAR(64) NOT NULL,
  ai_snapshot JSON DEFAULT NULL,
  review_snapshot JSON DEFAULT NULL,
  alignment_coeff DECIMAL(5,4) DEFAULT 1.0000,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  resolution VARCHAR(64) DEFAULT NULL,
  resolved_by VARCHAR(64) DEFAULT NULL,
  resolved_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_anomaly_status_created (status, created_at),
  KEY idx_anomaly_review (review_id),
  KEY idx_anomaly_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='评价-过程证据极端冲突人工复核';
