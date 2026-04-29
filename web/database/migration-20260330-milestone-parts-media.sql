-- 修中节点：可选零配件照片 + 验真方式说明（与小程序、repair-milestone-service 一致）
ALTER TABLE order_repair_milestones
  ADD COLUMN parts_photo_urls JSON DEFAULT NULL COMMENT '修中：零配件/包装等补充照片 URL' AFTER photo_urls,
  ADD COLUMN parts_verify_note VARCHAR(500) DEFAULT NULL COMMENT '修中：零配件验真方式（选填）' AFTER note;
