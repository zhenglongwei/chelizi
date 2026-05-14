-- 维修相册中台 + 公网案例发布 + 商家价格菜单 + 预约线索（辙见 GEO / 轻量主路径）
-- 执行前请备份；未上线环境可直接 source。

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS repair_albums (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  album_id VARCHAR(32) NOT NULL COMMENT '相册业务ID',
  shop_id VARCHAR(32) NOT NULL COMMENT 'shops.shop_id',
  order_id VARCHAR(32) DEFAULT NULL COMMENT '可选关联订单',
  template_type VARCHAR(64) NOT NULL DEFAULT 'accident_default' COMMENT '模板类型',
  status VARCHAR(32) NOT NULL DEFAULT 'draft' COMMENT 'draft|active|pending_review|published|archived',
  watermark_meta JSON DEFAULT NULL COMMENT '水印元数据',
  public_case_slug VARCHAR(80) DEFAULT NULL COMMENT '公网案例 slug，唯一',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_album_id (album_id),
  UNIQUE KEY uk_public_case_slug (public_case_slug),
  KEY idx_shop_status (shop_id, status),
  KEY idx_order_id (order_id),
  CONSTRAINT fk_ra_shop FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='维修相册（order_id 可空）';

CREATE TABLE IF NOT EXISTS repair_album_nodes (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  album_id VARCHAR(32) NOT NULL,
  node_code VARCHAR(64) NOT NULL COMMENT 'pre_teardown|teardown|parts|in_progress|completion',
  sort_order INT NOT NULL DEFAULT 0,
  note VARCHAR(2000) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_album_node (album_id, node_code),
  KEY idx_album (album_id),
  CONSTRAINT fk_ran_album FOREIGN KEY (album_id) REFERENCES repair_albums(album_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='相册节点';

CREATE TABLE IF NOT EXISTS repair_album_media (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  media_id VARCHAR(32) NOT NULL,
  album_id VARCHAR(32) NOT NULL,
  node_code VARCHAR(64) NOT NULL,
  url VARCHAR(1024) NOT NULL COMMENT 'COS/HTTPS 地址',
  sort_order INT NOT NULL DEFAULT 0,
  qc_status VARCHAR(32) DEFAULT 'pending' COMMENT 'pending|pass|fail',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_media_id (media_id),
  KEY idx_album_node (album_id, node_code),
  CONSTRAINT fk_ram_album FOREIGN KEY (album_id) REFERENCES repair_albums(album_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='相册节点媒体';

CREATE TABLE IF NOT EXISTS repair_case_publications (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  publication_id VARCHAR(32) NOT NULL,
  album_id VARCHAR(32) NOT NULL,
  desensitized_snapshot JSON DEFAULT NULL COMMENT '脱敏后对外展示快照',
  review_status VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'pending|approved|rejected',
  review_note VARCHAR(500) DEFAULT NULL,
  published_url VARCHAR(500) DEFAULT NULL,
  reviewed_by VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_pub_id (publication_id),
  UNIQUE KEY uk_pub_album (album_id),
  KEY idx_review (review_status),
  CONSTRAINT fk_rcp_album FOREIGN KEY (album_id) REFERENCES repair_albums(album_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='案例公开发布审核';

CREATE TABLE IF NOT EXISTS shop_service_price_menu (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  menu_row_id VARCHAR(32) NOT NULL,
  shop_id VARCHAR(32) NOT NULL,
  service_name VARCHAR(200) NOT NULL COMMENT '服务项目名称',
  parts_type VARCHAR(64) NOT NULL DEFAULT 'unspecified' COMMENT '配件类型：原厂件|品牌件|不涉及等',
  craft_standard VARCHAR(64) NOT NULL DEFAULT 'standard' COMMENT '工艺标准',
  ref_min DECIMAL(10,2) NOT NULL COMMENT '参考区间下限（元）',
  ref_max DECIMAL(10,2) NOT NULL COMMENT '参考区间上限（元）',
  warranty_note VARCHAR(500) DEFAULT NULL,
  typical_days INT DEFAULT NULL COMMENT '典型工期（天）',
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_menu_row (menu_row_id),
  KEY idx_shop (shop_id, is_active),
  CONSTRAINT fk_sspm_shop FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='商家入驻价格菜单（区间）';

CREATE TABLE IF NOT EXISTS shop_appointment_leads (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  lead_id VARCHAR(32) NOT NULL,
  shop_id VARCHAR(32) NOT NULL,
  user_id VARCHAR(32) DEFAULT NULL,
  contact_name VARCHAR(64) DEFAULT NULL,
  contact_phone VARCHAR(32) NOT NULL,
  vehicle_plate VARCHAR(32) DEFAULT NULL,
  vehicle_model VARCHAR(128) DEFAULT NULL,
  note VARCHAR(1000) DEFAULT NULL,
  source VARCHAR(64) NOT NULL DEFAULT 'miniapp' COMMENT 'miniapp|h5|other',
  status VARCHAR(32) NOT NULL DEFAULT 'new' COMMENT 'new|confirmed|cancelled|done',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_lead (lead_id),
  KEY idx_shop_created (shop_id, created_at),
  CONSTRAINT fk_sal_shop FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='预约到店线索';
