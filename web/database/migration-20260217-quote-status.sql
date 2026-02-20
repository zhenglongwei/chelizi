-- 报价表增加报价状态字段
-- 0=有效 1=成交 2=已失效(客户未选直接结束)
ALTER TABLE quotes ADD COLUMN quote_status TINYINT UNSIGNED DEFAULT 0 COMMENT '0-有效 1-成交 2-已失效' AFTER value_added_services;
