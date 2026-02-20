-- ========================================================
-- 汽修资质：AI 未识别时允许用户手动选择，需人工审核
-- 新增 qualification_ai_recognized、qualification_ai_result
-- 执行前请备份数据
-- 依赖：migration-20260216-qualification-audit.sql、migration-20260216-qualification-audit-reason.sql
-- ========================================================

USE chelizi;

-- 若列已存在会报 Duplicate column，可忽略或先 DROP COLUMN 再执行
-- 1. qualification_ai_recognized：AI 识别的资质等级（null 表示未识别）
ALTER TABLE shops
  ADD COLUMN qualification_ai_recognized VARCHAR(20) DEFAULT NULL
  COMMENT 'AI 识别的资质等级，null 表示未识别'
  AFTER qualification_level;

-- 2. qualification_ai_result：区分识别失败与未识别到资质
-- recognized=识别成功 recognition_failed=识别失败 no_qualification_found=未识别到资质
ALTER TABLE shops
  ADD COLUMN qualification_ai_result VARCHAR(32) DEFAULT NULL
  COMMENT 'AI 识别结果：recognized/recognition_failed/no_qualification_found'
  AFTER qualification_ai_recognized;
