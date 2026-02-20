-- ========================================================
-- 维修厂信息页扩展：服务商照片
-- 执行前请备份数据。若列已存在（Duplicate column），可跳过 ALTER
-- ========================================================

USE chelizi;

-- shop_images: 服务商/店铺环境照片 URL 数组
ALTER TABLE shops
  ADD COLUMN shop_images JSON DEFAULT NULL COMMENT '服务商/店铺环境照片 URL 数组'
  AFTER logo;
