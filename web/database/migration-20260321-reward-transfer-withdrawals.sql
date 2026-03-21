-- 奖励金提现：商家转账到零钱（用户确认模式）扩展字段
ALTER TABLE withdrawals
  ADD COLUMN wx_transfer_bill_no VARCHAR(64) NULL COMMENT '微信转账单号 transfer_bill_no' AFTER remark,
  ADD COLUMN wx_bill_state VARCHAR(32) NULL COMMENT '微信单据状态 SUCCESS/FAIL/CANCELLED/WAIT_USER_CONFIRM 等' AFTER wx_transfer_bill_no;
