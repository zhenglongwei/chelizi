-- ========================================================
-- 服务商消息表：资质审核、系统通知等
-- 执行前请备份数据
-- ========================================================

USE chelizi;

CREATE TABLE IF NOT EXISTS merchant_messages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  message_id VARCHAR(32) NOT NULL UNIQUE COMMENT '消息唯一ID',
  merchant_id VARCHAR(32) NOT NULL COMMENT '服务商ID',
  type VARCHAR(20) NOT NULL COMMENT '类型: qualification_audit/system/bidding/order',
  title VARCHAR(100) NOT NULL COMMENT '标题',
  content TEXT DEFAULT NULL COMMENT '内容',
  related_id VARCHAR(32) DEFAULT NULL COMMENT '关联ID（如 shop_id）',
  is_read TINYINT UNSIGNED DEFAULT 0 COMMENT '0-未读 1-已读',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_message_id (message_id),
  INDEX idx_merchant_read (merchant_id, is_read),
  INDEX idx_merchant_created (merchant_id, created_at),
  FOREIGN KEY (merchant_id) REFERENCES merchant_users(merchant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='服务商消息表';
