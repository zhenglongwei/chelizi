-- ========================================================
-- 评价奖励金体系 - 数据库变更迁移脚本
-- 基于《评价奖励金体系-设计方案》
-- 执行前请备份数据
-- ========================================================

USE chelizi;

-- 1. 确保 settings 表可存储 rewardRules（key 已支持，value 为 TEXT 可存 JSON）
-- 无需修改，rewardRules 通过 PUT /api/v1/admin/config 写入

-- 2. 插入 rewardRules 默认配置（可选，前端 RewardRulesConfig 会写入）
-- INSERT INTO settings (`key`, `value`, `description`) VALUES
-- ('rewardRules', '{}', '奖励金规则配置（JSON），由运营后台 RewardRulesConfig 维护')
-- ON DUPLICATE KEY UPDATE `key`=`key`;

-- 3. 订单表已有 order_tier, complexity_level, vehicle_price_tier, reward_preview, commission_rate
-- 无需新增字段

-- 4. vehicle_info 中 vehicle_price（裸车价）为 JSON 字段内容，无需表结构变更
-- biddings.vehicle_info 可包含 { vehicle_price: 150000 } 等，由前端/定损写入

-- 5. 确保 shops 表有 compliance_rate, complaint_rate（评价体系迁移已包含）
-- 若无则执行：
-- ALTER TABLE shops ADD COLUMN IF NOT EXISTS compliance_rate DECIMAL(5,2) DEFAULT NULL;
-- ALTER TABLE shops ADD COLUMN IF NOT EXISTS complaint_rate DECIMAL(5,2) DEFAULT NULL;

-- 6. 评价体系相关表已存在：repair_complexity_levels, reward_rules, review_dimensions, review_audit_logs, complexity_upgrade_requests
-- 奖励金配置现统一存 settings.rewardRules，reward_rules 表可保留作扩展

-- 本迁移主要为文档记录，实际表结构已在 schema.sql 与 migration-20260211 中完成
