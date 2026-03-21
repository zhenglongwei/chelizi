-- 提现实名、身份证（选填）、微信 package 缓存（用于补拉确认页）
ALTER TABLE users
  ADD COLUMN withdraw_real_name VARCHAR(64) DEFAULT NULL COMMENT '提现收款实名（须与微信实名一致）' AFTER phone,
  ADD COLUMN id_card_no VARCHAR(18) DEFAULT NULL COMMENT '身份证号，选填留存' AFTER withdraw_real_name;

ALTER TABLE withdrawals
  ADD COLUMN wx_package_info TEXT NULL COMMENT '用户确认模式 package，查询接口不返回时用于补拉' AFTER wx_bill_state;
