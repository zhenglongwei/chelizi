-- ========================================================
-- 资质审核：待审核原因 + 驳回状态
-- qualification_status: 0=待审核 1=通过 2=驳回待修改
-- 执行前请备份数据
-- ========================================================

USE chelizi;

-- 1. shops 表新增 qualification_audit_reason
ALTER TABLE shops
  ADD COLUMN qualification_audit_reason VARCHAR(500) DEFAULT NULL
  COMMENT '待审核/驳回原因，如：用户修改了技师职业等级，需人工复核'
  AFTER qualification_status;

-- 2. 修改 qualification_status 注释
ALTER TABLE shops
  MODIFY COLUMN qualification_status TINYINT UNSIGNED DEFAULT 0
  COMMENT '资质审核状态 0-待审核 1-通过 2-驳回待修改';
