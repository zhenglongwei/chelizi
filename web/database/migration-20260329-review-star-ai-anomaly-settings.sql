-- 星级 vs AI 矛盾检测：可选种子（无行时服务端用代码内 DEFAULTS）
INSERT IGNORE INTO settings (`key`, `value`, `description`) VALUES
  ('review_star_ai_anomaly_enabled', '1', '主评价 v3 是否写入 star_ai_anomaly'),
  ('review_star_ai_anomaly_user_low_max', '2', '低星上界：≤此值且 AI 正向则标矛盾'),
  ('review_star_ai_anomaly_user_high_min', '4', '高星下界：≥此值且 AI 负向则标矛盾'),
  ('review_star_ai_anomaly_quote_pct_good_max', '8', '报价偏离度百分数 ≤ 视为与 level=low 同向（好）'),
  ('review_star_ai_anomaly_quote_pct_bad_min', '18', '报价偏离度百分数 > 视为与 level=high 同向（差）'),
  ('review_star_ai_anomaly_repair_good_min', '72', '外观修复度 ≥ 视为 AI 正向'),
  ('review_star_ai_anomaly_repair_bad_max', '45', '外观修复度 ≤ 视为 AI 负向');
