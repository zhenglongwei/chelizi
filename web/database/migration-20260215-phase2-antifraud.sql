-- ========================================================
-- 第二阶段防刷 - 黑名单、防刷配置
-- 执行：mysql -u user -p chelizi < migration-20260215-phase2-antifraud.sql
-- ========================================================

USE chelizi;

-- 1. 黑名单表
CREATE TABLE IF NOT EXISTS blacklist (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  blacklist_type VARCHAR(20) NOT NULL COMMENT 'user_id/phone/device_id/ip/id_card',
  blacklist_value VARCHAR(128) NOT NULL COMMENT '对应类型的值',
  reason VARCHAR(255) DEFAULT NULL COMMENT '拉黑原因',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_type_value (blacklist_type, blacklist_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='防刷黑名单';

-- 2. reviews 表新增权重相关字段（供店铺得分计算）
ALTER TABLE reviews ADD COLUMN weight_score DECIMAL(10, 4) DEFAULT NULL COMMENT '单条评价权重';
ALTER TABLE reviews ADD COLUMN is_negative TINYINT UNSIGNED DEFAULT 0 COMMENT '是否差评 0-否 1-是';

-- 3. 防刷规则配置（存入 settings）
INSERT INTO settings (`key`, `value`, `description`) VALUES
('antifraud_order_same_shop_days', '30', '同用户同商户订单频次统计天数'),
('antifraud_order_same_shop_max', '3', '同用户同商户周期内最大订单数'),
('antifraud_new_user_days', '7', '新用户判定天数'),
('antifraud_new_user_order_max', '5', '新用户周期内最大订单数'),
('antifraud_l1_monthly_cap', '100', 'L1 订单每月奖励金封顶（元）'),
('antifraud_l1l2_freeze_days', '0', 'L1-L2 奖励金冻结天数，0=即发'),
('antifraud_l1l2_sample_rate', '5', 'L1-L2 抽检比例（%）')
ON DUPLICATE KEY UPDATE `key`=`key`;
