-- 竞价单分发机制 - 数据库迁移
-- 执行：mysql -u user -p chelizi < migration-20260225-bidding-distribution.sql

-- 1. biddings 表增加第一梯队窗口结束时间
ALTER TABLE biddings
  ADD COLUMN tier1_window_ends_at DATETIME DEFAULT NULL COMMENT '第一梯队独家窗口结束时间（创建时+15分钟）' AFTER expire_at;

-- 2. 竞价分发结果表（用于快速查询店铺可见性）
CREATE TABLE IF NOT EXISTS bidding_distribution (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bidding_id VARCHAR(32) NOT NULL,
  shop_id VARCHAR(32) NOT NULL,
  tier TINYINT UNSIGNED NOT NULL COMMENT '1=第一梯队 2=第二梯队 3=第三梯队',
  match_score DECIMAL(5,2) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_bidding_shop (bidding_id, shop_id),
  INDEX idx_bidding (bidding_id),
  INDEX idx_shop (shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='竞价分发结果';

-- 3. 竞价分发配置（JSON 存 settings）
INSERT INTO settings (`key`, `value`, `description`) VALUES
('biddingDistribution', '{
  "filterComplianceMin": 80,
  "filterViolationDays": 30,
  "filterCapacityCheck": false,
  "fallbackDistanceExpandRate": 0.2,
  "fallbackMinShops": 3,
  "tier1MatchScoreMin": 80,
  "tier1ComplianceMin": 95,
  "tier2MatchScoreMin": 60,
  "tier2MatchScoreMax": 79,
  "tier2ComplianceMin": 85,
  "tier1ExclusiveMinutes": 15,
  "tier3MaxShops": 2,
  "distributeL1L2Max": 10,
  "distributeL1L2ValidStop": 5,
  "distributeL3L4Max": 15,
  "distributeL3L4ValidStop": 8,
  "newShopDays": 90,
  "newShopBaseScore": 60,
  "sameProjectScorePriority": 15,
  "sameProjectScoreFallback": 5,
  "sceneWeightL1L2": 0.35,
  "sceneWeightL3L4": 0.60
}', '竞价单分发机制配置（JSON）')
ON DUPLICATE KEY UPDATE `key`=`key`;
