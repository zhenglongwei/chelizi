-- 辙见：关键表/列存在性自检（在目标库上执行，全部为「存在」即通过）
-- 用法：mysql -u用户 -p zhejian < web/database/verify-schema.sql

USE zhejian;

SELECT '=== 核心表 ===' AS section;
SELECT t.TABLE_NAME AS missing_table
FROM (
  SELECT 'users' AS TABLE_NAME UNION SELECT 'shops' UNION SELECT 'orders' UNION SELECT 'reviews'
  UNION SELECT 'user_verification' UNION SELECT 'user_vehicles' UNION SELECT 'violation_records'
  UNION SELECT 'review_likes' UNION SELECT 'blacklist'
) AS expect
LEFT JOIN information_schema.TABLES t
  ON t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME = expect.TABLE_NAME
WHERE t.TABLE_NAME IS NULL;

SELECT '=== reviews 关键列（API 常用）===' AS section;
SELECT c.COLUMN_NAME AS missing_column
FROM (
  SELECT 'content_quality' AS COLUMN_NAME
  UNION SELECT 'content_quality_level'
  UNION SELECT 'vehicle_model_key'
  UNION SELECT 'review_images_public'
  UNION SELECT 'review_public_media'
  UNION SELECT 'review_system_checks'
) AS expect
LEFT JOIN information_schema.COLUMNS c
  ON c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = 'reviews' AND c.COLUMN_NAME = expect.COLUMN_NAME
WHERE c.COLUMN_NAME IS NULL;

SELECT '=== users 关键列 ===' AS section;
SELECT c.COLUMN_NAME AS missing_column
FROM (
  SELECT 'phone' AS COLUMN_NAME UNION SELECT 'level' UNION SELECT 'openid'
) AS expect
LEFT JOIN information_schema.COLUMNS c
  ON c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = 'users' AND c.COLUMN_NAME = expect.COLUMN_NAME
WHERE c.COLUMN_NAME IS NULL;

SELECT '=== 完成：若上面各段无行输出，表示检查的表/列均存在 ===' AS done;
