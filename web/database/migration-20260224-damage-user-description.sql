-- 定损报告增加用户文字描述字段（泡水、异响等非可见损伤）
-- 执行：mysql -u root -p zhejian < migration-20260224-damage-user-description.sql

ALTER TABLE damage_reports
  ADD COLUMN user_description TEXT DEFAULT NULL COMMENT '用户文字描述（泡水、异响等无法通过照片体现的问题）' AFTER images;
