-- ========================================================
-- 方案A：注册免审 + 资质审核
-- 注册后直接可登录，但需补充资质并审核通过后才能接单、展示
-- 执行前请备份数据
-- ========================================================

USE chelizi;

-- 1. shops 表新增 qualification_status
-- 0=未提交/待审核（不可接单、不展示） 1=审核通过（可接单、展示）
ALTER TABLE shops
  ADD COLUMN qualification_status TINYINT UNSIGNED DEFAULT 0
  COMMENT '资质审核状态 0-未提交/待审核 1-审核通过'
  AFTER technician_certs;

-- 2. 已有 shops 默认设为审核通过（兼容历史数据）
UPDATE shops SET qualification_status = 1;

-- 3. 已有 merchant_users 待审核账号改为可登录（注册免审）
UPDATE merchant_users SET status = 1 WHERE status = 0;
