-- 预报价拆解检测费（知情权披露；到店后线下支付，平台不代收）
-- 执行：mysql ... < migration-20260502-quotes-disassembly-fee.sql

ALTER TABLE quotes
  ADD COLUMN disassembly_fee DECIMAL(10, 2) NULL DEFAULT NULL COMMENT '拆解检测费（元）；与维修总价分离；免费承诺时为 0' AFTER amount,
  ADD COLUMN disassembly_fee_waived TINYINT(1) UNSIGNED NOT NULL DEFAULT 0 COMMENT '1=承诺本次到店拆解检测免费' AFTER disassembly_fee,
  ADD COLUMN disassembly_fee_note VARCHAR(600) NULL DEFAULT NULL COMMENT '费用说明（必填项内容）：检测项目或免费原因' AFTER disassembly_fee_waived;
