-- ========================================================
-- 用户等级体系 Phase 1
-- 0-4 级、实名认证、车辆绑定、待回溯奖励
-- ========================================================

-- 1. users 表：level 改为 0-4，新增等级相关字段
ALTER TABLE users
  MODIFY COLUMN level TINYINT UNSIGNED DEFAULT 0 COMMENT '用户可信度等级 0-4，0=风险受限 1=基础注册 2=普通可信 3=活跃可信 4=核心标杆',
  ADD COLUMN level_demoted_by_violation TINYINT UNSIGNED DEFAULT 0 COMMENT '是否曾因违规降级：0=否 1=是，恢复1级时不可回溯奖励' AFTER level,
  ADD COLUMN level_updated_at DATETIME DEFAULT NULL COMMENT '等级最后核算时间' AFTER level_demoted_by_violation;

-- 迁移已有数据：原 level 1-8 映射为 1-4
UPDATE users SET level = LEAST(4, GREATEST(0, COALESCE(level, 1))) WHERE level > 4;
UPDATE users SET level = 1 WHERE level IS NULL;

-- 2. 实名认证表
CREATE TABLE IF NOT EXISTS user_verification (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL UNIQUE COMMENT '用户ID',
  verified TINYINT UNSIGNED DEFAULT 0 COMMENT '0=未认证 1=已认证（手机号/身份证）',
  verified_at DATETIME DEFAULT NULL COMMENT '认证完成时间',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户实名认证';

-- 已有手机号用户写入实名记录（阶段1：手机号=实名）
INSERT IGNORE INTO user_verification (user_id, verified, verified_at)
SELECT user_id, 1, updated_at FROM users WHERE phone IS NOT NULL AND phone != '';

-- 已有用户：实名+有订单（含车辆信息）视为1级
UPDATE users u
JOIN user_verification uv ON u.user_id = uv.user_id AND uv.verified = 1
JOIN orders o ON o.user_id = u.user_id AND o.status = 3 AND o.bidding_id IS NOT NULL
JOIN biddings b ON o.bidding_id = b.bidding_id AND b.vehicle_info IS NOT NULL AND b.vehicle_info != 'null' AND b.vehicle_info != '{}'
SET u.level = 1, u.level_updated_at = NOW();

-- 3. 用户绑定车辆表（最多 3 台）
CREATE TABLE IF NOT EXISTS user_vehicles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
  plate_number VARCHAR(20) DEFAULT NULL COMMENT '车牌号',
  vin VARCHAR(50) DEFAULT NULL COMMENT '车架号',
  vehicle_info JSON DEFAULT NULL COMMENT '车辆信息 {brand, model, year}',
  status TINYINT UNSIGNED DEFAULT 1 COMMENT '0=已解绑 1=有效',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户绑定车辆';

-- 4. 待回溯奖励表（0级因未实名/车辆未发放，完成认证后可补发）
CREATE TABLE IF NOT EXISTS withheld_rewards (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
  review_id VARCHAR(32) NOT NULL COMMENT '评价ID',
  order_id VARCHAR(32) NOT NULL COMMENT '订单ID',
  amount DECIMAL(10, 2) NOT NULL COMMENT '应发税前金额',
  tax_deducted DECIMAL(10, 2) DEFAULT 0.00 COMMENT '代扣个税',
  user_receives DECIMAL(10, 2) NOT NULL COMMENT '用户实收金额',
  status VARCHAR(20) DEFAULT 'pending' COMMENT 'pending=待发放 paid=已发放 rejected=不可发放',
  reason VARCHAR(50) DEFAULT 'no_verification' COMMENT 'no_verification=因未实名/车辆暂扣',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME DEFAULT NULL COMMENT '实际发放时间',
  INDEX idx_user_status (user_id, status),
  INDEX idx_review_id (review_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='待回溯奖励（0级未发放，认证后补发）';
