-- 第 3 题用户举证 + q3 权重剔除
-- 执行：mysql -u root -p chelizi < migration-20260226-q3-fault-evidence.sql
-- 若列已存在会报错，可忽略

-- 1. reviews 表：用户故障凭证
ALTER TABLE reviews ADD COLUMN fault_evidence_images JSON DEFAULT NULL COMMENT '用户举证故障未解决（q3选否时选填）' AFTER completion_images;

-- 2. q3 权重剔除标记（商户申诉有效时置 1）
ALTER TABLE reviews ADD COLUMN q3_weight_excluded TINYINT UNSIGNED DEFAULT 0 COMMENT '商户申诉有效时剔除q3权重 0-否 1-是' AFTER content_quality_level;
