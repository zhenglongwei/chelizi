-- F10 轻量变现：预约线索可选平台线索费字段（与 ZHEJIAN_LEAD_FEE_YUAN 配合）
SET NAMES utf8mb4;

ALTER TABLE shop_appointment_leads
  ADD COLUMN lead_fee_yuan DECIMAL(10,2) DEFAULT NULL COMMENT '平台线索费(元)，标记 done 时写入' AFTER status,
  ADD COLUMN fee_note VARCHAR(200) DEFAULT NULL COMMENT '费用说明' AFTER lead_fee_yuan;
