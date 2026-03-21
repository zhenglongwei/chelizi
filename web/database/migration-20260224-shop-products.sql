-- 服务商商品表：支持上架/下架，上架需后台审核通过
-- 执行：mysql -u root -p chelizi < migration-20260224-shop-products.sql

CREATE TABLE IF NOT EXISTS shop_products (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id VARCHAR(32) NOT NULL UNIQUE COMMENT '商品唯一ID',
  shop_id VARCHAR(32) NOT NULL COMMENT '维修厂ID',
  name VARCHAR(200) NOT NULL COMMENT '商品/服务名称',
  category VARCHAR(50) NOT NULL COMMENT '服务分类：钣金喷漆、发动机维修、电路维修、保养服务',
  price DECIMAL(10, 2) NOT NULL COMMENT '价格（元）',
  description TEXT DEFAULT NULL COMMENT '商品描述',
  images JSON DEFAULT NULL COMMENT '商品图片URL数组',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending=待审核 approved=已上架 rejected=已驳回 off_shelf=已下架',
  audit_reason VARCHAR(500) DEFAULT NULL COMMENT '驳回原因（status=rejected时）',
  audited_at DATETIME DEFAULT NULL COMMENT '审核时间',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_shop_id (shop_id),
  INDEX idx_category_status (category, status),
  INDEX idx_status (status),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='服务商商品（上架需审核）';
