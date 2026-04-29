-- 单笔订单佣金 C 上 (B) 硬帽汇总：rebate / like_bonus / upgrade_diff / conversion_bonus / post_verify_bonus 均写入 reward_source_order_id（佣金来源订单）
-- 执行后需重启 API；历史行 NULL 仍按 reviews / reward_settlement_pending 回退汇总

ALTER TABLE transactions
  ADD COLUMN reward_source_order_id VARCHAR(32) DEFAULT NULL COMMENT '奖励所锚定的订单实收佣金来源 order_id' AFTER related_id;

CREATE INDEX idx_transactions_reward_source_order ON transactions (reward_source_order_id);
