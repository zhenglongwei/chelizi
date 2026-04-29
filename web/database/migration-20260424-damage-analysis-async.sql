-- 异步 AI 定损分析 + 分发门闸 + 人工审核兜底
-- 执行：mysql -u user -p zhejian < migration-20260424-damage-analysis-async.sql

-- 1) damage_reports：扩展状态与审计字段
ALTER TABLE damage_reports
  MODIFY COLUMN status TINYINT UNSIGNED DEFAULT 0 COMMENT '状态 0-分析中 1-已完成(可分发) 3-与修车无关(拒绝) 4-人工审核' ,
  ADD COLUMN analysis_relevance VARCHAR(20) DEFAULT NULL COMMENT 'relevant/irrelevant/unknown' AFTER analysis_result,
  ADD COLUMN analysis_attempts TINYINT UNSIGNED DEFAULT 0 COMMENT 'AI分析尝试次数' AFTER analysis_relevance,
  ADD COLUMN analysis_error VARCHAR(255) DEFAULT NULL COMMENT '最近一次失败原因（截断）' AFTER analysis_attempts;

-- 2) biddings：分发状态（与 damage_reports.status 联动）
ALTER TABLE biddings
  ADD COLUMN distribution_status VARCHAR(20) DEFAULT NULL COMMENT 'pending/done/rejected/manual_review' AFTER selected_shop_id;

-- 3) damage_analysis_tasks：异步分析任务队列（worker 拉取执行）
CREATE TABLE IF NOT EXISTS damage_analysis_tasks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id VARCHAR(32) NOT NULL UNIQUE COMMENT '任务ID',
  report_id VARCHAR(32) NOT NULL COMMENT '定损报告ID',
  status VARCHAR(20) NOT NULL DEFAULT 'queued' COMMENT 'queued/running/done/failed/manual_review',
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '已尝试次数',
  last_error VARCHAR(255) DEFAULT NULL COMMENT '最近一次错误（截断）',
  locked_at DATETIME DEFAULT NULL COMMENT '锁定时间（worker claim）',
  locked_by VARCHAR(64) DEFAULT NULL COMMENT '锁定者标识',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_report (report_id),
  INDEX idx_status_locked (status, locked_at),
  CONSTRAINT fk_dat_report FOREIGN KEY (report_id) REFERENCES damage_reports(report_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI定损异步分析任务';

