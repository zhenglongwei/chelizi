-- 商户申诉：增加 status=4 待人工复核
-- 执行：mysql -u root -p chelizi < migration-20260226-appeal-status4.sql

ALTER TABLE merchant_evidence_requests
  MODIFY COLUMN status TINYINT UNSIGNED DEFAULT 0
  COMMENT '0=待申诉 1=已申诉待审核 2=申诉有效 3=申诉无效/超时 4=待人工复核';
