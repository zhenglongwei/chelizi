-- 全指标底层逻辑 - 数据库迁移
-- 支撑：评价权重、店铺综合得分（100分制）、分阶管控
-- 执行：mysql -u root -p chelizi < migration-20260219-full-indicator.sql
-- 若列已存在会报错，可忽略或先 DROP COLUMN 再执行

-- 1. shops 增加 100 分制店铺综合得分（全指标第三章）
ALTER TABLE shops ADD COLUMN shop_score DECIMAL(5,2) DEFAULT NULL COMMENT '店铺综合得分 0-100（全指标加权公式）' AFTER rating;

-- 2. reviews 增加单条权重与内容质量缓存（全指标 2.3）
ALTER TABLE reviews ADD COLUMN weight DECIMAL(10,4) DEFAULT NULL COMMENT '单条评价总权重' AFTER status;
ALTER TABLE reviews ADD COLUMN content_quality VARCHAR(20) DEFAULT NULL COMMENT '内容质量 invalid/valid/premium' AFTER weight;

-- 3. orders 增加保险事故车标记（权重×2）
ALTER TABLE orders ADD COLUMN is_insurance_accident TINYINT UNSIGNED DEFAULT 0 COMMENT '是否保险事故车 0-否 1-是' AFTER complexity_level;
