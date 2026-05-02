-- 定损异步任务队列优先级：独立「AI分析报告」优先于「预报价入队」触发的同接口任务
-- 执行：mysql -u user -p zhejian < migration-20260502-damage-analysis-queue-priority.sql

ALTER TABLE damage_analysis_tasks
  ADD COLUMN queue_priority TINYINT UNSIGNED NOT NULL DEFAULT 100
  COMMENT '100=用户立即查看报告优先 10=预报价等后台分析'
  AFTER status;

-- 与 worker 拉取顺序一致：先按优先级降序，再按入队时间升序
CREATE INDEX idx_dat_status_priority_created
  ON damage_analysis_tasks (status, queue_priority, created_at);
