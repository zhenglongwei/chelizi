-- 月度定期结算 - 评价升级差额、点赞追加
-- 结算日每月10日，到账预留1-3个工作日

-- 1. 待结算记录表（评价升级差额等，结算时读取并发放）
CREATE TABLE IF NOT EXISTS reward_settlement_pending (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
  review_id VARCHAR(32) NOT NULL COMMENT '主评价ID',
  order_id VARCHAR(32) NOT NULL COMMENT '订单ID',
  pending_type VARCHAR(30) NOT NULL COMMENT 'upgrade_diff-评价升级差额',
  amount_before_tax DECIMAL(10, 2) NOT NULL COMMENT '税前金额',
  tax_deducted DECIMAL(10, 2) DEFAULT 0.00 COMMENT '个税扣减',
  amount_after_tax DECIMAL(10, 2) NOT NULL COMMENT '实发金额',
  calc_reason VARCHAR(500) DEFAULT NULL COMMENT '计算依据，供清单展示',
  trigger_month VARCHAR(7) NOT NULL COMMENT '触发月份 YYYY-MM',
  settled_at DATETIME DEFAULT NULL COMMENT '结算时间',
  transaction_id VARCHAR(32) DEFAULT NULL COMMENT '结算后关联交易ID',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_month (user_id, trigger_month),
  INDEX idx_trigger_month (trigger_month),
  INDEX idx_pending_type (pending_type),
  INDEX idx_settled (settled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='待结算奖励（评价升级差额等）';

-- 2. 结算任务日志表
CREATE TABLE IF NOT EXISTS reward_settlement_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  settlement_month VARCHAR(7) NOT NULL COMMENT '结算月份 YYYY-MM',
  run_at DATETIME NOT NULL COMMENT '任务执行时间',
  upgrade_diff_count INT UNSIGNED DEFAULT 0 COMMENT '评价升级差额条数',
  upgrade_diff_amount DECIMAL(12, 2) DEFAULT 0.00 COMMENT '评价升级差额总额',
  like_bonus_count INT UNSIGNED DEFAULT 0 COMMENT '常规点赞追加条数',
  like_bonus_amount DECIMAL(12, 2) DEFAULT 0.00 COMMENT '常规点赞追加总额',
  status VARCHAR(20) DEFAULT 'completed' COMMENT 'completed/failed/partial',
  error_msg TEXT DEFAULT NULL COMMENT '异常信息',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_settlement_month (settlement_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='月度结算任务日志';

-- 3. transactions.type 扩展说明（无需改表，新 type 直接使用）
-- rebate | withdraw | recharge | upgrade_diff | like_bonus | conversion_bonus | post_verify_bonus

-- 4. transactions 扩展：description 500 字符，新增 settlement_month
ALTER TABLE transactions MODIFY COLUMN description VARCHAR(500) DEFAULT NULL COMMENT '描述（含计算依据供清单展示）';
ALTER TABLE transactions ADD COLUMN settlement_month VARCHAR(7) DEFAULT NULL COMMENT '结算月份 YYYY-MM（定期结算类）' AFTER description;

-- 5. 结算配置
INSERT INTO settings (`key`, `value`, `description`) VALUES
('monthly_settlement_day', '10', '月度结算日（每月几号）'),
('settlement_delay_days', '2', '结算后到账预留工作日数 1-3')
ON DUPLICATE KEY UPDATE `key`=`key`;
