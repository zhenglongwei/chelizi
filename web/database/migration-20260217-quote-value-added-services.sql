-- 报价表增加增值服务字段
ALTER TABLE quotes ADD COLUMN value_added_services JSON DEFAULT NULL COMMENT '增值服务 [{name}] 如代步车、上门接送' AFTER items;
