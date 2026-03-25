-- 服务商按 openid 查询（微信登录/校验）
ALTER TABLE merchant_users ADD INDEX idx_openid (openid);
