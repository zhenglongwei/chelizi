-- ========================================================
-- 初始化店铺列表排序配置（shopSortWeightsV1）
-- 说明：
-- - 运营后台“系统配置 -> 店铺列表排序配置”读写 settings.shopSortWeightsV1
-- - 车主端店铺列表默认排序（shop-sort-service）与竞价分发匹配分（bidding-distribution）统一读取该配置
-- - 本迁移仅在不存在该 key 时写入默认值，保证线上开箱即用且可回滚
-- 回滚方式：
-- - DELETE FROM settings WHERE `key`='shopSortWeightsV1';
-- ========================================================

USE zhejian;

INSERT INTO settings (`key`, `value`)
SELECT
  'shopSortWeightsV1',
  JSON_OBJECT(
    'version', 1,
    'scenes', JSON_OBJECT(
      'L1L2', JSON_OBJECT(
        'default', JSON_OBJECT('shop', 0.35, 'distance', 0.30, 'price', 0.25, 'response', 0.10),
        'self_pay', JSON_OBJECT('shop', 0.33, 'distance', 0.22, 'price', 0.35, 'response', 0.10)
      ),
      'L3L4', JSON_OBJECT(
        'default', JSON_OBJECT('shop', 0.60, 'distance', 0.05, 'price', 0.20, 'response', 0.15),
        'self_pay', JSON_OBJECT('shop', 0.55, 'distance', 0.05, 'price', 0.28, 'response', 0.12)
      ),
      'brand', JSON_OBJECT(
        'default', JSON_OBJECT('shop', 0.50, 'distance', 0.10, 'price', 0.20, 'response', 0.20),
        'self_pay', JSON_OBJECT('shop', 0.45, 'distance', 0.08, 'price', 0.30, 'response', 0.17)
      )
    )
  )
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE `key`='shopSortWeightsV1');

