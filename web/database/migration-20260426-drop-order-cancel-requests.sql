-- ========================================================
-- 删除已废弃的撤单申请表（order_cancel_requests）
-- 变更背景：
-- - 订单取消口径已迁移为“取消交易”，并以 order_offline_fee_proofs 作为拆检留痕锚点
-- - 撤单申请/人工通道旧链路已从前后端移除
-- 回滚方式：
-- - 如需回滚，请从历史迁移 migration-20260223-order-cancel-evidence.sql 恢复建表语句
-- ========================================================

USE zhejian;

DROP TABLE IF EXISTS order_cancel_requests;

