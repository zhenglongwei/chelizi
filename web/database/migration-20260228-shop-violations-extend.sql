-- 扩展 shop_violations 支持系统核验违规类型（05 文档、评价内容设置规范）
-- 执行：mysql -u root -p zhejian < migration-20260228-shop-violations-extend.sql
-- 表结构无需变更（violation_type VARCHAR(50)、penalty INT 已支持），仅更新注释

ALTER TABLE shop_violations
  MODIFY COLUMN violation_type VARCHAR(50) NOT NULL
  COMMENT 'progress_not_synced(5)/parts_not_shown(15)/no_quote_confirm(10)/extra_project(20)/settlement_deviation(20)/service_mismatch(50)/parts_non_compliant(配件不合规)',
  MODIFY COLUMN penalty INT NOT NULL
  COMMENT '扣分 5/10/15/20/50';
