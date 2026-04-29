-- 点赞权重：高权匹配由「同车牌」改为「同品牌+同车型（规范化）」；列名未改，仅更新 COMMENT 以免误导审计。
ALTER TABLE review_likes
  MODIFY COLUMN vehicle_match_by_plate TINYINT UNSIGNED DEFAULT 0
  COMMENT '高权车型匹配:1=点赞者与评价订单车辆同品牌同车型(规范化)一致,0=否;2026-04前历史行可能曾按车牌口径写入';
