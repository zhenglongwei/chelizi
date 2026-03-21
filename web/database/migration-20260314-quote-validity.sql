-- 报价有效期：服务商可自定义，默认 3 天
-- 竞价 2h 过期后，已报价仍有效，用户可随时接受；报价在 quote_valid_until 到期后才失效
ALTER TABLE quotes ADD COLUMN quote_valid_until DATETIME DEFAULT NULL COMMENT '报价有效期截止时间，默认 created_at+3天' AFTER quote_status;
