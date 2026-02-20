-- ========================================================
-- 资质审核中：允许用户撤回后重新修改
-- qualification_withdrawn: 0=正常 1=已撤回（可编辑）
-- 仅当 qualification_status=0（待审核）时可撤回；审核通过/驳回后不可撤回
-- 执行前请备份数据
-- ========================================================

USE chelizi;

ALTER TABLE shops
  ADD COLUMN qualification_withdrawn TINYINT UNSIGNED DEFAULT 0
  COMMENT '资质是否已撤回：0=否 1=是（审核中时用户撤回，可重新编辑提交）'
  AFTER qualification_audit_reason;
