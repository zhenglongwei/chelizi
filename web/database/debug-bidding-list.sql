-- 竞价列表诊断 SQL
-- 在 MariaDB 中执行

SET @shop_id = 'S1771423494111';

-- 1. 查看所有进行中的竞价（未加距离筛选）
SELECT b.bidding_id, b.user_id, b.report_id, b.range_km, b.status, b.expire_at,
       u.latitude as u_lat, u.longitude as u_lng,
       (SELECT COUNT(*) FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.shop_id = @shop_id) as quote_count
FROM biddings b
INNER JOIN users u ON b.user_id = u.user_id
WHERE b.status = 0 AND b.expire_at > NOW();

-- 2. 查看是否有 damage_reports 关联
SELECT b.bidding_id, b.report_id, dr.report_id as dr_exists
FROM biddings b
LEFT JOIN damage_reports dr ON b.report_id = dr.report_id
WHERE b.status = 0 AND b.expire_at > NOW();

-- 3. 完整 count 查询（与代码一致）
SELECT COUNT(DISTINCT b.bidding_id) as cnt
FROM biddings b
INNER JOIN damage_reports dr ON b.report_id = dr.report_id
INNER JOIN users u ON b.user_id = u.user_id
INNER JOIN shops s ON s.shop_id = @shop_id
WHERE b.status = 0 AND b.expire_at > NOW()
  AND u.latitude IS NOT NULL AND u.longitude IS NOT NULL
  AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
  AND (6371 * acos(LEAST(1, GREATEST(-1,
    cos(radians(u.latitude)) * cos(radians(s.latitude)) * cos(radians(s.longitude) - radians(u.longitude))
    + sin(radians(u.latitude)) * sin(radians(s.latitude))
  )))) <= b.range_km
  AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.shop_id = @shop_id);

-- 4. 完整 list 查询（与代码完全一致，使用变量）
SELECT * FROM (
  SELECT b.bidding_id, b.report_id, b.vehicle_info, b.range_km, b.expire_at, b.created_at, b.status as bidding_status, b.selected_shop_id,
    dr.analysis_result,
    u.latitude as user_lat, u.longitude as user_lng,
    s.latitude as shop_lat, s.longitude as shop_lng,
    (SELECT COUNT(*) FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.shop_id = @shop_id) as quoted,
    (SELECT q.quote_status FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.shop_id = @shop_id LIMIT 1) as my_quote_status
   FROM biddings b
   INNER JOIN damage_reports dr ON b.report_id = dr.report_id
   INNER JOIN users u ON b.user_id = u.user_id
   INNER JOIN shops s ON s.shop_id = @shop_id
   WHERE b.status = 0 AND b.expire_at > NOW()
     AND u.latitude IS NOT NULL AND u.longitude IS NOT NULL
     AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
     AND (6371 * acos(LEAST(1, GREATEST(-1,
       cos(radians(u.latitude)) * cos(radians(s.latitude)) * cos(radians(s.longitude) - radians(u.longitude))
       + sin(radians(u.latitude)) * sin(radians(s.latitude))
     )))) <= b.range_km
     AND (SELECT COUNT(*) FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.shop_id = @shop_id) = 0
) t ORDER BY created_at DESC LIMIT 10 OFFSET 0;
