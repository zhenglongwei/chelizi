-- 历史订单：无 pre_quote_snapshot 的视为旧版流程，final_quote_status=2 以免阻断完工
-- 新订单选厂后会写入 pre_quote_snapshot，保持 final_quote_status=0 直至车主确认最终报价
UPDATE orders SET final_quote_status = 2 WHERE pre_quote_snapshot IS NULL AND final_quote_status = 0;
