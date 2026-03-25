-- 方案A：去掉维修复杂度校准系数，并入基础固定奖励
-- 公式改为：基础奖励 = 复杂度基础固定奖励 × 车价校准系数
--
-- 执行：mysql -u root -p zhejian < web/database/migration-20260317-base-reward-simplify.sql

-- 为 reward_rules.rewardRules 添加 baseReward、baseRewardInsurance
-- 若已有 rule_value，用 JSON_SET 追加；否则需先有 rewardRules 行
UPDATE reward_rules
SET rule_value = JSON_SET(
  COALESCE(rule_value, '{}'),
  '$.baseReward',
  JSON_OBJECT('L1', 10, 'L2', 30, 'L3', 150, 'L4', 450),
  '$.baseRewardInsurance',
  JSON_OBJECT('L1', 20, 'L2', 60, 'L3', 300, 'L4', 900)
)
WHERE rule_key = 'rewardRules';
