-- ========================================================
-- 车厘子 - 事故车维修平台 数据库Schema
-- 基于MySQL 8.0
-- 阿里云ECS部署
-- ========================================================

-- 创建数据库
CREATE DATABASE IF NOT EXISTS chelizi 
  DEFAULT CHARACTER SET utf8mb4 
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE chelizi;

-- ========================================================
-- 1. 用户表 (users)
-- ========================================================
CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL UNIQUE COMMENT '用户唯一ID',
  openid VARCHAR(64) NOT NULL UNIQUE COMMENT '微信openid',
  unionid VARCHAR(64) DEFAULT NULL COMMENT '微信unionid',
  nickname VARCHAR(100) DEFAULT NULL COMMENT '用户昵称',
  avatar_url VARCHAR(500) DEFAULT NULL COMMENT '头像URL',
  phone VARCHAR(20) DEFAULT NULL COMMENT '手机号',
  level TINYINT UNSIGNED DEFAULT 0 COMMENT '用户可信度等级 0-4',
  level_demoted_by_violation TINYINT UNSIGNED DEFAULT 0 COMMENT '是否曾因违规降级',
  level_updated_at DATETIME DEFAULT NULL COMMENT '等级最后核算时间',
  points INT UNSIGNED DEFAULT 0 COMMENT '积分',
  balance DECIMAL(10, 2) DEFAULT 0.00 COMMENT '奖励金余额（原返点余额）',
  total_rebate DECIMAL(10, 2) DEFAULT 0.00 COMMENT '累计奖励金（原累计返点）',
  total_reviews INT UNSIGNED DEFAULT 0 COMMENT '评价总数',
  province VARCHAR(50) DEFAULT NULL COMMENT '省份',
  city VARCHAR(50) DEFAULT NULL COMMENT '城市',
  district VARCHAR(50) DEFAULT NULL COMMENT '区县',
  latitude DECIMAL(10, 8) DEFAULT NULL COMMENT '纬度',
  longitude DECIMAL(11, 8) DEFAULT NULL COMMENT '经度',
  status TINYINT UNSIGNED DEFAULT 1 COMMENT '状态 0-禁用 1-启用',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_openid (openid),
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户表';

-- ========================================================
-- 2. 维修厂表 (shops)
-- ========================================================
CREATE TABLE IF NOT EXISTS shops (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  shop_id VARCHAR(32) NOT NULL UNIQUE COMMENT '维修厂唯一ID',
  name VARCHAR(100) NOT NULL COMMENT '维修厂名称',
  logo VARCHAR(500) DEFAULT NULL COMMENT 'Logo URL',
  shop_images JSON DEFAULT NULL COMMENT '服务商/店铺环境照片 URL 数组',
  address VARCHAR(255) NOT NULL COMMENT '详细地址',
  province VARCHAR(50) NOT NULL COMMENT '省份',
  city VARCHAR(50) NOT NULL COMMENT '城市',
  district VARCHAR(50) NOT NULL COMMENT '区县',
  latitude DECIMAL(10, 8) NOT NULL COMMENT '纬度',
  longitude DECIMAL(11, 8) NOT NULL COMMENT '经度',
  phone VARCHAR(20) NOT NULL COMMENT '联系电话',
  business_hours VARCHAR(100) DEFAULT NULL COMMENT '营业时间',
  categories JSON DEFAULT NULL COMMENT '服务分类 ["钣金喷漆", "发动机维修"]',
  rating DECIMAL(2, 1) DEFAULT 5.0 COMMENT '综合评分 0-5',
  rating_count INT UNSIGNED DEFAULT 0 COMMENT '评价数量',
  deviation_rate DECIMAL(5, 2) DEFAULT 0.00 COMMENT '平均报价偏差率(%)',
  total_orders INT UNSIGNED DEFAULT 0 COMMENT '总订单数',
  is_certified TINYINT UNSIGNED DEFAULT 0 COMMENT '是否认证 0-否 1-是',
  certifications JSON DEFAULT NULL COMMENT '资质认证 [{type, name, image}]',
  services JSON DEFAULT NULL COMMENT '服务项目 [{name, min_price, max_price}]',
  compliance_rate DECIMAL(5, 2) DEFAULT NULL COMMENT 'AI校验维修合规率(%)',
  complaint_rate DECIMAL(5, 2) DEFAULT NULL COMMENT '用户有效投诉率(%)',
  qualification_level VARCHAR(20) DEFAULT NULL COMMENT '维修资质等级',
  qualification_ai_recognized VARCHAR(50) DEFAULT NULL COMMENT 'AI识别的资质等级',
  qualification_ai_result VARCHAR(50) DEFAULT NULL COMMENT 'AI识别结果 recognition_failed/no_qualification_found/ok',
  technician_certs JSON DEFAULT NULL COMMENT '技师持证情况',
  qualification_status TINYINT UNSIGNED DEFAULT 0 COMMENT '资质审核状态 0-待审核 1-通过 2-驳回待修改',
  qualification_audit_reason VARCHAR(500) DEFAULT NULL COMMENT '待审核/驳回原因',
  qualification_withdrawn TINYINT UNSIGNED DEFAULT 0 COMMENT '资质是否已撤回：0=否 1=是',
  status TINYINT UNSIGNED DEFAULT 1 COMMENT '状态 0-禁用 1-启用',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_shop_id (shop_id),
  INDEX idx_location (latitude, longitude),
  INDEX idx_rating (rating)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='维修厂表';

-- ========================================================
-- 3. 定损报告表 (damage_reports)
-- ========================================================
CREATE TABLE IF NOT EXISTS damage_reports (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  report_id VARCHAR(32) NOT NULL UNIQUE COMMENT '报告唯一ID',
  user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
  vehicle_info JSON NOT NULL COMMENT '车辆信息 {plate_number, model, mileage}',
  images JSON NOT NULL COMMENT '事故照片URL数组',
  analysis_result JSON DEFAULT NULL COMMENT 'AI分析结果',
  status TINYINT UNSIGNED DEFAULT 0 COMMENT '状态 0-分析中 1-已完成',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_report_id (report_id),
  INDEX idx_user_id (user_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='定损报告表';

-- ========================================================
-- 4. 竞价表 (biddings)
-- ========================================================
CREATE TABLE IF NOT EXISTS biddings (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bidding_id VARCHAR(32) NOT NULL UNIQUE COMMENT '竞价唯一ID',
  user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
  report_id VARCHAR(32) NOT NULL COMMENT '定损报告ID',
  vehicle_info JSON NOT NULL COMMENT '车辆信息',
  insurance_info JSON DEFAULT NULL COMMENT '保险信息 {is_insurance, company, accident_type}',
  range_km INT UNSIGNED DEFAULT 5 COMMENT '竞价范围（公里）',
  status TINYINT UNSIGNED DEFAULT 0 COMMENT '状态 0-进行中 1-已结束 2-已取消',
  expire_at DATETIME NOT NULL COMMENT '过期时间',
  tier1_window_ends_at DATETIME DEFAULT NULL COMMENT '第一梯队独家窗口结束时间',
  selected_shop_id VARCHAR(32) DEFAULT NULL COMMENT '选中的维修厂ID',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_bidding_id (bidding_id),
  INDEX idx_user_id (user_id),
  INDEX idx_status_expire (status, expire_at),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (report_id) REFERENCES damage_reports(report_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='竞价表';

-- ========================================================
-- 5. 报价表 (quotes)
-- ========================================================
CREATE TABLE IF NOT EXISTS quotes (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  quote_id VARCHAR(32) NOT NULL UNIQUE COMMENT '报价唯一ID',
  bidding_id VARCHAR(32) NOT NULL COMMENT '竞价ID',
  shop_id VARCHAR(32) NOT NULL COMMENT '维修厂ID',
  amount DECIMAL(10, 2) NOT NULL COMMENT '报价金额',
  items JSON DEFAULT NULL COMMENT '维修项目 [{damage_part, repair_type, parts_type?}]',
  value_added_services JSON DEFAULT NULL COMMENT '增值服务 [{name}] 如代步车、上门接送',
  quote_status TINYINT UNSIGNED DEFAULT 0 COMMENT '0-有效 1-成交 2-已失效',
  duration INT UNSIGNED DEFAULT 3 COMMENT '预计工期（天）',
  warranty INT UNSIGNED DEFAULT 12 COMMENT '质保期限（月）',
  remark TEXT DEFAULT NULL COMMENT '备注',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_quote_id (quote_id),
  INDEX idx_bidding_id (bidding_id),
  INDEX idx_shop_id (shop_id),
  FOREIGN KEY (bidding_id) REFERENCES biddings(bidding_id),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='报价表';

-- ========================================================
-- 6. 订单表 (orders)
-- ========================================================
CREATE TABLE IF NOT EXISTS orders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(32) NOT NULL UNIQUE COMMENT '订单唯一ID',
  bidding_id VARCHAR(32) NOT NULL COMMENT '竞价ID',
  user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
  shop_id VARCHAR(32) NOT NULL COMMENT '维修厂ID',
  quote_id VARCHAR(32) NOT NULL COMMENT '报价ID',
  quoted_amount DECIMAL(10, 2) NOT NULL COMMENT '报价金额',
  actual_amount DECIMAL(10, 2) DEFAULT NULL COMMENT '实际金额',
  deviation_rate DECIMAL(5, 2) DEFAULT NULL COMMENT '偏差率(%)',
  commission_rate DECIMAL(4, 2) DEFAULT 12.00 COMMENT '佣金比例(%)',
  commission DECIMAL(10, 2) DEFAULT NULL COMMENT '佣金金额',
  order_tier TINYINT UNSIGNED DEFAULT NULL COMMENT '订单分级 1-4（一级~四级）',
  complexity_level VARCHAR(10) DEFAULT NULL COMMENT '维修项目复杂度 L1-L4',
  vehicle_price_tier VARCHAR(20) DEFAULT NULL COMMENT '车价分级 low/mid/high',
  reward_preview DECIMAL(10, 2) DEFAULT NULL COMMENT '奖励金预估',
  review_stage_status VARCHAR(50) DEFAULT NULL COMMENT '评价阶段完成状态（主评价/1个月追评/3个月追评）',
  status TINYINT UNSIGNED DEFAULT 0 COMMENT '状态: 0-待维修 1-维修中 2-待验收 3-已完成 4-已取消',
  accepted_at DATETIME DEFAULT NULL COMMENT '服务商接单时间（接单时写入，用于撤单30分钟判断）',
  completion_evidence JSON DEFAULT NULL COMMENT '维修完成凭证 {repair_photos,settlement_photos,material_photos}',
  repair_plan JSON DEFAULT NULL COMMENT '当前维修方案 {items,value_added_services?,amount?,duration?,warranty?}，接单时从quote复制',
  repair_plan_status TINYINT UNSIGNED DEFAULT 0 COMMENT '0=已确认 1=待车主确认',
  repair_plan_adjusted_at DATETIME DEFAULT NULL COMMENT '最近一次维修方案调整时间',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  completed_at DATETIME DEFAULT NULL COMMENT '完成时间',
  
  INDEX idx_order_id (order_id),
  INDEX idx_bidding_id (bidding_id),
  INDEX idx_user_id (user_id),
  INDEX idx_shop_id (shop_id),
  INDEX idx_status (status),
  FOREIGN KEY (bidding_id) REFERENCES biddings(bidding_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id),
  FOREIGN KEY (quote_id) REFERENCES quotes(quote_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单表';

-- ========================================================
-- 6a. 订单撤单申请表 (order_cancel_requests)
-- ========================================================
CREATE TABLE IF NOT EXISTS order_cancel_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(32) NOT NULL UNIQUE COMMENT '业务主键',
  order_id VARCHAR(32) NOT NULL COMMENT '订单ID',
  user_id VARCHAR(32) NOT NULL COMMENT '发起人（车主）',
  reason VARCHAR(500) NOT NULL COMMENT '撤单理由（超过30分钟必填）',
  status TINYINT UNSIGNED DEFAULT 0 COMMENT '0=待服务商处理 1=服务商同意 2=服务商拒绝 3=已提交人工 4=人工同意 5=人工拒绝',
  shop_response_at DATETIME DEFAULT NULL COMMENT '服务商响应时间',
  escalated_at DATETIME DEFAULT NULL COMMENT '车主提交人工通道时间',
  admin_resolution VARCHAR(20) DEFAULT NULL COMMENT '人工处理：approved/rejected',
  admin_resolved_at DATETIME DEFAULT NULL COMMENT '人工处理时间',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_request_id (request_id),
  INDEX idx_order_id (order_id),
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  FOREIGN KEY (order_id) REFERENCES orders(order_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单撤单申请';

-- ========================================================
-- 6b. 材料 AI 审核任务表 (material_audit_tasks)
-- ========================================================
CREATE TABLE IF NOT EXISTS material_audit_tasks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id VARCHAR(32) NOT NULL UNIQUE COMMENT '任务唯一ID',
  order_id VARCHAR(32) NOT NULL COMMENT '订单ID',
  shop_id VARCHAR(32) NOT NULL COMMENT '店铺ID',
  completion_evidence JSON NOT NULL COMMENT '维修完成凭证 {repair_photos,settlement_photos,material_photos}',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending=待审核 passed=通过 rejected=不通过',
  reject_reason VARCHAR(500) DEFAULT NULL COMMENT '不通过原因',
  ai_details JSON DEFAULT NULL COMMENT 'AI 审核详情',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME DEFAULT NULL,
  INDEX idx_order_status (order_id, status),
  INDEX idx_pending (status),
  INDEX idx_created (created_at),
  FOREIGN KEY (order_id) REFERENCES orders(order_id),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='材料AI审核任务';

-- ========================================================
-- 7. 评价表 (reviews)
-- ========================================================
CREATE TABLE IF NOT EXISTS reviews (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  review_id VARCHAR(32) NOT NULL UNIQUE COMMENT '评价唯一ID',
  order_id VARCHAR(32) NOT NULL COMMENT '订单ID',
  shop_id VARCHAR(32) NOT NULL COMMENT '维修厂ID',
  user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
  type TINYINT UNSIGNED DEFAULT 1 COMMENT '评价类型 1-主评价 2-追评 3-返厂（返厂等同追评）',
  review_stage VARCHAR(20) DEFAULT NULL COMMENT 'main/1m/3m 追评阶段',
  settlement_list_image VARCHAR(500) DEFAULT NULL COMMENT '维修结算清单图片URL',
  completion_images JSON DEFAULT NULL COMMENT '完工实拍图URL数组',
  fault_evidence_images JSON DEFAULT NULL COMMENT '用户举证故障未解决（q3选否时选填）',
  objective_answers JSON DEFAULT NULL COMMENT '客观题答案（报价/维修过程/完工验收各维度）',
  reward_amount DECIMAL(10, 2) DEFAULT NULL COMMENT '奖励金金额',
  tax_deducted DECIMAL(10, 2) DEFAULT 0.00 COMMENT '代扣个税',
  rating TINYINT UNSIGNED DEFAULT NULL COMMENT '综合评分 1-5（选填，不影响奖励）',
  ratings_quality TINYINT UNSIGNED DEFAULT NULL COMMENT '维修质量评分',
  ratings_price TINYINT UNSIGNED DEFAULT NULL COMMENT '价格透明评分',
  ratings_service TINYINT UNSIGNED DEFAULT NULL COMMENT '服务态度评分',
  ratings_speed TINYINT UNSIGNED DEFAULT NULL COMMENT '维修速度评分',
  ratings_parts TINYINT UNSIGNED DEFAULT NULL COMMENT '配件质量评分',
  content TEXT DEFAULT NULL COMMENT '评价内容',
  before_images JSON DEFAULT NULL COMMENT '维修前照片（冗余存储，便于查询）',
  after_images JSON DEFAULT NULL COMMENT '维修后照片',
  ai_analysis JSON DEFAULT NULL COMMENT 'AI分析结果',
  is_anonymous TINYINT UNSIGNED DEFAULT 0 COMMENT '是否匿名 0-否 1-是',
  like_count INT UNSIGNED DEFAULT 0 COMMENT '点赞数',
  content_quality_level TINYINT UNSIGNED DEFAULT 1 COMMENT '内容质量等级 1-4',
  q3_weight_excluded TINYINT UNSIGNED DEFAULT 0 COMMENT '商户申诉有效时剔除q3权重 0-否 1-是',
  vehicle_model_key VARCHAR(100) DEFAULT NULL COMMENT '车型键 brand|model 用于同车型统计',
  repair_project_key VARCHAR(255) DEFAULT NULL COMMENT '维修项目键 用于同项目统计',
  post_verify_like_count INT UNSIGNED DEFAULT 0 COMMENT '事后验证点赞数',
  rebate_amount DECIMAL(10, 2) DEFAULT 0.00 COMMENT '奖励金金额（兼容旧字段，新数据用reward_amount）',
  rebate_rate DECIMAL(4, 2) DEFAULT 0.00 COMMENT '奖励金比例（兼容，新规则用reward_rules）',
  status TINYINT UNSIGNED DEFAULT 1 COMMENT '状态 0-隐藏 1-显示',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_review_id (review_id),
  INDEX idx_order_id (order_id),
  INDEX idx_shop_id (shop_id),
  INDEX idx_user_id (user_id),
  INDEX idx_review_vehicle_project (vehicle_model_key(50), repair_project_key(100), type, status),
  FOREIGN KEY (order_id) REFERENCES orders(order_id),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='评价表';

-- ========================================================
-- 7a. 评价有效阅读会话表 (review_reading_sessions)
-- ========================================================
CREATE TABLE IF NOT EXISTS review_reading_sessions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(32) NOT NULL UNIQUE COMMENT '业务主键',
  review_id VARCHAR(32) NOT NULL COMMENT '评价ID',
  user_id VARCHAR(32) NOT NULL COMMENT '浏览用户',
  effective_seconds INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '本次有效阅读秒数（单次最多180）',
  saw_at DATETIME DEFAULT NULL COMMENT '「看到了」的时刻',
  ended_at DATETIME DEFAULT NULL COMMENT '会话结束',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_review_user (review_id, user_id),
  INDEX idx_user_review (user_id, review_id),
  FOREIGN KEY (review_id) REFERENCES reviews(review_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='评价有效阅读会话';

-- ========================================================
-- 7b. 评价点赞记录表 (review_likes)
-- ========================================================
CREATE TABLE IF NOT EXISTS review_likes (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  like_id VARCHAR(32) NOT NULL UNIQUE COMMENT '业务主键',
  review_id VARCHAR(32) NOT NULL COMMENT '评价ID',
  user_id VARCHAR(32) NOT NULL COMMENT '点赞用户',
  effective_reading_seconds INT UNSIGNED DEFAULT 0 COMMENT '点赞时累计有效阅读时长',
  like_type VARCHAR(20) DEFAULT 'normal' COMMENT 'normal/post_verify',
  is_valid_for_bonus TINYINT UNSIGNED DEFAULT 0 COMMENT '是否纳入奖金核算',
  weight_coefficient DECIMAL(6,4) DEFAULT 0 COMMENT '账号综合权重系数',
  vehicle_match_by_plate TINYINT UNSIGNED DEFAULT 0 COMMENT '车型匹配 1=车牌一致',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_review (user_id, review_id),
  INDEX idx_review_id (review_id),
  INDEX idx_user_id (user_id),
  FOREIGN KEY (review_id) REFERENCES reviews(review_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='评价点赞记录';

-- ========================================================
-- 8. 交易记录表 (transactions)
-- ========================================================
CREATE TABLE IF NOT EXISTS transactions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  transaction_id VARCHAR(32) NOT NULL UNIQUE COMMENT '交易唯一ID',
  user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
  type VARCHAR(20) NOT NULL COMMENT '类型: rebate-奖励金 withdraw-提现 recharge-充值',
  amount DECIMAL(10, 2) NOT NULL COMMENT '金额（正数收入，负数支出）',
  reward_tier TINYINT UNSIGNED DEFAULT NULL COMMENT '订单分级 1-4',
  review_stage VARCHAR(20) DEFAULT NULL COMMENT 'main/1m/3m',
  tax_deducted DECIMAL(10, 2) DEFAULT 0.00 COMMENT '代扣个税',
  description VARCHAR(500) DEFAULT NULL COMMENT '描述（含计算依据供清单展示）',
  settlement_month VARCHAR(7) DEFAULT NULL COMMENT '结算月份 YYYY-MM（定期结算类）',
  related_id VARCHAR(32) DEFAULT NULL COMMENT '关联ID（如评价ID、提现ID）',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_transaction_id (transaction_id),
  INDEX idx_user_id (user_id),
  INDEX idx_type (type),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='交易记录表';

-- ========================================================
-- 9. 提现申请表 (withdrawals)
-- ========================================================
CREATE TABLE IF NOT EXISTS withdrawals (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  withdraw_id VARCHAR(32) NOT NULL UNIQUE COMMENT '提现唯一ID',
  user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
  amount DECIMAL(10, 2) NOT NULL COMMENT '提现金额',
  status TINYINT UNSIGNED DEFAULT 0 COMMENT '状态 0-处理中 1-已完成 2-失败',
  remark VARCHAR(200) DEFAULT NULL COMMENT '备注',
  processed_at DATETIME DEFAULT NULL COMMENT '处理时间',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_withdraw_id (withdraw_id),
  INDEX idx_user_id (user_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='提现申请表';

-- ========================================================
-- 10. 用户消息表 (user_messages)
-- ========================================================
CREATE TABLE IF NOT EXISTS user_messages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  message_id VARCHAR(32) NOT NULL UNIQUE COMMENT '消息唯一ID',
  user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
  type VARCHAR(20) NOT NULL COMMENT '类型: system/bidding/order/review',
  title VARCHAR(100) NOT NULL COMMENT '标题',
  content TEXT DEFAULT NULL COMMENT '内容',
  related_id VARCHAR(32) DEFAULT NULL COMMENT '关联竞价/订单/评价ID',
  is_read TINYINT UNSIGNED DEFAULT 0 COMMENT '0-未读 1-已读',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_message_id (message_id),
  INDEX idx_user_read (user_id, is_read),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户消息表';

-- ========================================================
-- 11. 用户收藏维修厂表 (user_favorite_shops)
-- ========================================================
CREATE TABLE IF NOT EXISTS user_favorite_shops (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
  shop_id VARCHAR(32) NOT NULL COMMENT '维修厂ID',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE KEY uk_user_shop (user_id, shop_id),
  INDEX idx_user_id (user_id),
  INDEX idx_shop_id (shop_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户收藏维修厂表';

-- ========================================================
-- 11a. 用户实名认证表 (user_verification)
-- ========================================================
CREATE TABLE IF NOT EXISTS user_verification (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL UNIQUE COMMENT '用户ID',
  verified TINYINT UNSIGNED DEFAULT 0 COMMENT '0=未认证 1=已认证',
  verified_at DATETIME DEFAULT NULL COMMENT '认证完成时间',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户实名认证';

-- ========================================================
-- 11b. 用户绑定车辆表 (user_vehicles)
-- ========================================================
CREATE TABLE IF NOT EXISTS user_vehicles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
  plate_number VARCHAR(20) DEFAULT NULL COMMENT '车牌号',
  vin VARCHAR(50) DEFAULT NULL COMMENT '车架号',
  vehicle_info JSON DEFAULT NULL COMMENT '车辆信息',
  status TINYINT UNSIGNED DEFAULT 1 COMMENT '0=已解绑 1=有效',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户绑定车辆';

-- ========================================================
-- 11c. 待回溯奖励表 (withheld_rewards)
-- ========================================================
CREATE TABLE IF NOT EXISTS withheld_rewards (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
  review_id VARCHAR(32) NOT NULL COMMENT '评价ID',
  order_id VARCHAR(32) NOT NULL COMMENT '订单ID',
  amount DECIMAL(10, 2) NOT NULL COMMENT '应发税前金额',
  tax_deducted DECIMAL(10, 2) DEFAULT 0.00 COMMENT '代扣个税',
  user_receives DECIMAL(10, 2) NOT NULL COMMENT '用户实收金额',
  status VARCHAR(20) DEFAULT 'pending' COMMENT 'pending/paid/rejected',
  reason VARCHAR(50) DEFAULT 'no_verification' COMMENT 'no_verification=因未实名/车辆暂扣',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME DEFAULT NULL COMMENT '实际发放时间',
  INDEX idx_user_status (user_id, status),
  INDEX idx_review_id (review_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='待回溯奖励';

-- ========================================================
-- 12. 服务商账号表 (merchant_users)
-- ========================================================
CREATE TABLE IF NOT EXISTS merchant_users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  merchant_id VARCHAR(32) NOT NULL UNIQUE COMMENT '服务商唯一ID',
  shop_id VARCHAR(32) NOT NULL COMMENT '维修厂ID',
  phone VARCHAR(20) NOT NULL COMMENT '登录手机号',
  password_hash VARCHAR(255) DEFAULT NULL COMMENT '密码哈希',
  openid VARCHAR(64) DEFAULT NULL COMMENT '微信openid',
  status TINYINT UNSIGNED DEFAULT 1 COMMENT '0-禁用 1-启用',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_merchant_id (merchant_id),
  INDEX idx_shop_id (shop_id),
  INDEX idx_phone (phone),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='服务商账号表';

-- ========================================================
-- 12a. 服务商消息表 (merchant_messages)
-- ========================================================
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

-- ========================================================
-- 12b. 商户申诉任务表 (merchant_evidence_requests)
-- ========================================================
CREATE TABLE IF NOT EXISTS merchant_evidence_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(32) NOT NULL UNIQUE COMMENT '业务主键',
  order_id VARCHAR(32) NOT NULL COMMENT '订单ID',
  review_id VARCHAR(32) NOT NULL COMMENT '评价ID',
  shop_id VARCHAR(32) NOT NULL COMMENT '店铺ID',
  question_key VARCHAR(32) NOT NULL COMMENT 'q1_progress_synced / q2_parts_shown',
  status TINYINT UNSIGNED DEFAULT 0 COMMENT '0=待申诉 1=已申诉待审核 2=申诉有效 3=申诉无效/超时',
  deadline DATETIME NOT NULL COMMENT '截止时间（通知发送+48h）',
  evidence_urls JSON DEFAULT NULL COMMENT '申诉材料URL数组',
  ai_result VARCHAR(50) DEFAULT NULL COMMENT 'AI初审结果',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_order_question (order_id, question_key),
  INDEX idx_shop_status (shop_id, status),
  INDEX idx_deadline (deadline),
  FOREIGN KEY (order_id) REFERENCES orders(order_id),
  FOREIGN KEY (review_id) REFERENCES reviews(review_id),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='商户申诉任务';

-- ========================================================
-- 12c. 店铺违规记录表 (shop_violations)
-- ========================================================
CREATE TABLE IF NOT EXISTS shop_violations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  shop_id VARCHAR(32) NOT NULL COMMENT '店铺ID',
  order_id VARCHAR(32) NOT NULL COMMENT '订单ID',
  violation_type VARCHAR(50) NOT NULL COMMENT 'progress_not_synced / parts_not_shown',
  penalty INT NOT NULL COMMENT '扣分 5/15',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_shop_created (shop_id, created_at),
  INDEX idx_order (order_id),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id),
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='店铺违规记录';

-- ========================================================
-- 13. 维修厂惩罚记录表 (shop_penalties)
-- ========================================================
CREATE TABLE IF NOT EXISTS shop_penalties (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  shop_id VARCHAR(32) NOT NULL COMMENT '维修厂ID',
  order_id VARCHAR(32) DEFAULT NULL COMMENT '关联订单ID',
  deviation_rate DECIMAL(5, 2) DEFAULT NULL COMMENT '偏差率(%)',
  penalty_type VARCHAR(20) NOT NULL COMMENT 'warning/deduction/suspend',
  penalty_detail VARCHAR(200) DEFAULT NULL COMMENT '惩罚说明',
  suspend_until DATETIME DEFAULT NULL COMMENT '暂停竞价资格至何时',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_shop_id (shop_id),
  INDEX idx_created (created_at),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='维修厂惩罚记录表';

-- ========================================================
-- 14. 预约表 (appointments)
-- ========================================================
CREATE TABLE IF NOT EXISTS appointments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  appointment_id VARCHAR(32) NOT NULL UNIQUE COMMENT '预约唯一ID',
  user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
  shop_id VARCHAR(32) NOT NULL COMMENT '维修厂ID',
  appointment_date DATE NOT NULL COMMENT '预约日期',
  time_slot VARCHAR(20) NOT NULL COMMENT '时段 上午/下午',
  service_category VARCHAR(20) DEFAULT 'other' COMMENT '服务类型: maintenance-保养 wash-洗车 repair-修车 other-其他',
  services JSON DEFAULT NULL COMMENT '服务项目 [{name, min_price, max_price}]',
  remark VARCHAR(500) DEFAULT NULL COMMENT '备注',
  status TINYINT UNSIGNED DEFAULT 0 COMMENT '0-待确认 1-已确认 2-已取消',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_appointment_id (appointment_id),
  INDEX idx_user_id (user_id),
  INDEX idx_shop_id (shop_id),
  INDEX idx_date (appointment_date),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='预约表';

-- ========================================================
-- 15. 系统配置表 (settings)
-- ========================================================
CREATE TABLE IF NOT EXISTS settings (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `key` VARCHAR(50) NOT NULL UNIQUE COMMENT '配置键',
  `value` TEXT DEFAULT NULL COMMENT '配置值',
  description VARCHAR(200) DEFAULT NULL COMMENT '描述',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统配置表';

-- AI 定损调用记录表（用于每日次数限制）
CREATE TABLE IF NOT EXISTS ai_call_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
  report_id VARCHAR(32) DEFAULT NULL COMMENT '关联报告ID',
  call_date DATE NOT NULL COMMENT '调用日期',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_date (user_id, call_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI定损调用记录';

-- 插入默认配置
INSERT INTO settings (`key`, `value`, `description`) VALUES
('ai_daily_limit', '5', '每用户每日AI定损调用次数上限'),
('rebate_first_rate', '0.08', '首次评价返点比例'),
('rebate_followup_rate', '0.02', '追评返点比例'),
('rebate_return_rate', '0.02', '返厂评价返点比例'),
('commission_rate', '0.12', '平台佣金比例'),
('min_withdraw_amount', '10', '最低提现金额'),
('max_withdraw_amount', '5000', '单日最高提现金额'),
('bidding_expire_hours', '24', '竞价有效期（小时）'),
('min_shops_per_bidding', '5', '单次竞价最少邀请维修厂数'),
('require_settlement_before_review', '0', '是否需等分账完成才允许评价/返现 0-否 1-是')
ON DUPLICATE KEY UPDATE `key`=`key`;

-- ========================================================
-- 评价体系新增表
-- ========================================================

-- 维修项目复杂度等级表
CREATE TABLE IF NOT EXISTS repair_complexity_levels (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `level` VARCHAR(10) NOT NULL COMMENT 'L1/L2/L3/L4',
  project_type VARCHAR(100) NOT NULL COMMENT '维修项目类型（交通部国标分类）',
  fixed_reward DECIMAL(10, 2) NOT NULL COMMENT '固定奖励（元）',
  float_ratio DECIMAL(4, 2) NOT NULL COMMENT '浮动比例(%)',
  cap_amount DECIMAL(10, 2) NOT NULL COMMENT '单项目封顶（元）',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_level (level),
  INDEX idx_project_type (project_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='维修项目复杂度等级';

-- 奖励金规则配置表
CREATE TABLE IF NOT EXISTS reward_rules (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  rule_key VARCHAR(50) NOT NULL UNIQUE COMMENT '规则键',
  rule_value JSON DEFAULT NULL COMMENT '规则值（订单分级阈值、车型系数等）',
  description VARCHAR(200) DEFAULT NULL COMMENT '描述',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='奖励金规则配置';

-- 评价维度记录表
CREATE TABLE IF NOT EXISTS review_dimensions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  review_id VARCHAR(32) NOT NULL COMMENT '评价ID',
  dimension VARCHAR(20) NOT NULL COMMENT 'quote/process/completion（报价/维修过程/完工验收）',
  score TINYINT UNSIGNED DEFAULT NULL COMMENT '该维度得分 1-5',
  answers JSON DEFAULT NULL COMMENT '客观题答案',
  images JSON DEFAULT NULL COMMENT '该维度相关图片URL',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_review_id (review_id),
  INDEX idx_dimension (dimension)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='评价维度记录';

-- 评价审核留痕表
CREATE TABLE IF NOT EXISTS review_audit_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  review_id VARCHAR(32) NOT NULL COMMENT '评价ID',
  audit_type VARCHAR(20) NOT NULL COMMENT 'ai/manual',
  result VARCHAR(20) NOT NULL COMMENT 'pass/reject',
  missing_items JSON DEFAULT NULL COMMENT '缺项说明（不通过时）',
  operator_id VARCHAR(32) DEFAULT NULL COMMENT '人工复核操作人',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_review_id (review_id),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='评价审核留痕';

-- 破格升级申请表
CREATE TABLE IF NOT EXISTS complexity_upgrade_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(32) NOT NULL UNIQUE COMMENT '业务主键',
  order_id VARCHAR(32) NOT NULL COMMENT '订单ID',
  user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
  current_level VARCHAR(10) DEFAULT NULL COMMENT '当前复杂度等级',
  requested_level VARCHAR(10) NOT NULL COMMENT '申请等级',
  reason TEXT DEFAULT NULL COMMENT '申请理由',
  status TINYINT UNSIGNED DEFAULT 0 COMMENT '0-待审核 1-通过 2-拒绝',
  auditor_id VARCHAR(32) DEFAULT NULL COMMENT '审核人',
  audited_at DATETIME DEFAULT NULL COMMENT '审核时间',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_request_id (request_id),
  INDEX idx_user_id (user_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='破格升级申请';

-- 防刷黑名单表（第二阶段）
CREATE TABLE IF NOT EXISTS blacklist (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  blacklist_type VARCHAR(20) NOT NULL COMMENT 'user_id/phone/device_id/ip/id_card',
  blacklist_value VARCHAR(128) NOT NULL COMMENT '对应类型的值',
  reason VARCHAR(255) DEFAULT NULL COMMENT '拉黑原因',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_type_value (blacklist_type, blacklist_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='防刷黑名单';

-- 防刷配置（第二阶段）
INSERT INTO settings (`key`, `value`, `description`) VALUES
('antifraud_order_same_shop_days', '30', '同用户同商户订单统计天数'),
('antifraud_order_same_shop_max', '3', '同用户同商户周期内最大订单数'),
('antifraud_new_user_days', '7', '新用户判定天数'),
('antifraud_new_user_order_max', '5', '新用户周期内最大订单数'),
('antifraud_l1_monthly_cap', '100', 'L1 订单每月奖励金封顶（元）'),
('antifraud_l1l2_freeze_days', '0', 'L1-L2 奖励金冻结天数，0=即发'),
('antifraud_l1l2_sample_rate', '5', 'L1-L2 抽检比例（%）'),
('antifraud_content_min_length', '10', '评价内容最小有效字数'),
('antifraud_content_similarity_threshold', '60', '评价重复度阈值(%)'),
('antifraud_water_words', '不错,很好,划算,可以,满意', '无意义水评关键词')
ON DUPLICATE KEY UPDATE `key`=`key`;

-- 违规记录表（第三阶段）
CREATE TABLE IF NOT EXISTS violation_records (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  record_id VARCHAR(32) NOT NULL UNIQUE,
  target_type VARCHAR(20) NOT NULL,
  target_id VARCHAR(32) NOT NULL,
  violation_level TINYINT UNSIGNED NOT NULL,
  violation_type VARCHAR(50) DEFAULT NULL,
  related_order_id VARCHAR(32) DEFAULT NULL,
  related_review_id VARCHAR(32) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  penalty_applied JSON DEFAULT NULL,
  status TINYINT UNSIGNED DEFAULT 0,
  operator_id VARCHAR(32) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME DEFAULT NULL,
  INDEX idx_target (target_type, target_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='违规记录';

-- 竞价分发结果表（按《07-竞价单分发机制》）
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

-- 审计日志表（第三阶段）
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  log_type VARCHAR(50) NOT NULL,
  action VARCHAR(50) NOT NULL,
  target_table VARCHAR(50) DEFAULT NULL,
  target_id VARCHAR(64) DEFAULT NULL,
  old_value JSON DEFAULT NULL,
  new_value JSON DEFAULT NULL,
  operator_id VARCHAR(32) DEFAULT NULL,
  operator_role VARCHAR(32) DEFAULT NULL,
  ip VARCHAR(64) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_type (log_type),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='审计日志';

-- ========================================================
-- 初始化测试数据
-- ========================================================

-- 插入测试维修厂数据
INSERT INTO shops (shop_id, name, address, province, city, district, latitude, longitude, phone, business_hours, categories, rating, is_certified, status) VALUES
('SHOP001', '捷通汽车高级维修中心', '北京市朝阳区建国路88号', '北京市', '北京市', '朝阳区', 39.9042, 116.4074, '010-12345678', '08:00-18:00', '["钣金喷漆", "发动机维修"]', 4.9, 1, 1),
('SHOP002', '盛世品牌钣喷中心', '北京市朝阳区望京街1号', '北京市', '北京市', '朝阳区', 39.9950, 116.4800, '010-87654321', '08:30-19:00', '["钣金喷漆", "电路维修"]', 4.5, 1, 1),
('SHOP003', '平安悦行维修服务部', '北京市海淀区中关村大街1号', '北京市', '北京市', '海淀区', 39.9800, 116.3200, '010-11112222', '09:00-18:00', '["保养服务", "发动机维修"]', 4.2, 0, 1)
ON DUPLICATE KEY UPDATE shop_id=shop_id;

-- 插入测试用户数据（openid为测试值）
INSERT INTO users (user_id, openid, nickname, avatar_url, phone, level, balance, total_rebate, status) VALUES
('USER001', 'test_openid_001', '测试用户', 'https://example.com/avatar.jpg', '13800138000', 3, 1250.40, 2140.00, 1)
ON DUPLICATE KEY UPDATE user_id=user_id;
