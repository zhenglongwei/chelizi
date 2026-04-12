-- 双阶段报价 + 锁价：订单预/终报价快照、定损单附件、最终报价状态
-- 同步文档：docs/database/数据库设计文档.md、docs/维修方案调整与确认流程.md

ALTER TABLE orders
  ADD COLUMN pre_quote_snapshot JSON DEFAULT NULL COMMENT '选厂时预报价快照' AFTER repair_plan_adjusted_at,
  ADD COLUMN final_quote_snapshot JSON DEFAULT NULL COMMENT '车主确认后最终报价快照' AFTER pre_quote_snapshot,
  ADD COLUMN final_quote_status TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0未发起1待车主确认2已锁价' AFTER final_quote_snapshot,
  ADD COLUMN final_quote_submitted_at DATETIME DEFAULT NULL COMMENT '服务商提交最终报价时间' AFTER final_quote_status,
  ADD COLUMN final_quote_confirmed_at DATETIME DEFAULT NULL COMMENT '车主确认锁价时间' AFTER final_quote_submitted_at,
  ADD COLUMN loss_assessment_documents JSON DEFAULT NULL COMMENT '保险车定损单等附件' AFTER final_quote_confirmed_at,
  ADD COLUMN deviation_rate_settlement DECIMAL(5,2) DEFAULT NULL COMMENT '终报价vs结算偏差率稽核' AFTER deviation_rate;

ALTER TABLE quotes
  ADD COLUMN quote_import_source VARCHAR(32) DEFAULT NULL COMMENT 'manual|excel_upload|ocr_photo' AFTER remark,
  ADD COLUMN quote_import_file_url VARCHAR(500) DEFAULT NULL COMMENT '导入来源文件或图URL' AFTER quote_import_source;
