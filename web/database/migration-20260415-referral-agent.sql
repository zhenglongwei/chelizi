-- 代理人（推荐）机制：一级/二级分佣、分销买家标记（转化类减半）
-- 执行前请确认列不存在，避免重复执行报错。

ALTER TABLE users
  ADD COLUMN referrer_user_id VARCHAR(32) DEFAULT NULL COMMENT '一级推荐人 user_id' AFTER unionid,
  ADD COLUMN referral_bound_at DATETIME DEFAULT NULL COMMENT '绑定推荐人时间' AFTER referrer_user_id,
  ADD COLUMN is_distribution_buyer TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '经分销体系引入的买家 1=转化/post_verify作者侧减半' AFTER referral_bound_at;

CREATE INDEX idx_users_referrer_user_id ON users (referrer_user_id);

CREATE TABLE IF NOT EXISTS referral_commission_settled_orders (
  order_id VARCHAR(32) NOT NULL COMMENT '已结算推荐佣金的订单',
  settlement_month VARCHAR(7) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (order_id),
  INDEX idx_referral_settled_month (settlement_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单推荐佣金已结算防重';
