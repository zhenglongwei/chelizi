-- 同用户同商户滚动周期内最大订单数：3 → 5（选厂下单防刷）
UPDATE `settings`
SET `value` = '5'
WHERE `key` = 'antifraud_order_same_shop_max';
