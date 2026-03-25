-- 奖励金规则统一到 reward_rules 表
-- 1. 将 repair_complexity_levels 种子数据 + 其他模块配置写入 reward_rules
-- 2. 从 settings 删除 rewardRules（本应在 reward_rules 中的配置）
--
-- 执行：mysql -u root -p zhejian < web/database/migration-20260309-reward-rules-unified.sql

INSERT INTO reward_rules (rule_key, rule_value, description) VALUES (
  'rewardRules',
  '{
    "complexityLevels": [
      {"level":"L1","project_type":"洗车","fixed_reward":10,"float_ratio":0,"cap_amount":50},
      {"level":"L1","project_type":"内饰清洁","fixed_reward":10,"float_ratio":0,"cap_amount":50},
      {"level":"L1","project_type":"打蜡|封釉","fixed_reward":10,"float_ratio":0,"cap_amount":50},
      {"level":"L1","project_type":"轮胎补气|动平衡","fixed_reward":10,"float_ratio":0,"cap_amount":50},
      {"level":"L1","project_type":"空调滤芯|空气滤芯","fixed_reward":10,"float_ratio":0,"cap_amount":50},
      {"level":"L1","project_type":"雨刮片|灯泡|保险丝","fixed_reward":10,"float_ratio":0,"cap_amount":50},
      {"level":"L1","project_type":"基础检测|故障码","fixed_reward":10,"float_ratio":0,"cap_amount":50},
      {"level":"L2","project_type":"保养|机油|机油滤","fixed_reward":30,"float_ratio":0,"cap_amount":200},
      {"level":"L2","project_type":"刹车片|刹车盘|刹车油","fixed_reward":30,"float_ratio":0,"cap_amount":200},
      {"level":"L2","project_type":"火花塞|燃油滤|变速箱油","fixed_reward":30,"float_ratio":0,"cap_amount":200},
      {"level":"L2","project_type":"电瓶|轮胎更换|四轮定位","fixed_reward":30,"float_ratio":0,"cap_amount":200},
      {"level":"L2","project_type":"钣金|喷漆|翼子板|车门","fixed_reward":30,"float_ratio":0,"cap_amount":200},
      {"level":"L2","project_type":"易损件|胶套|稳定杆","fixed_reward":30,"float_ratio":0,"cap_amount":200},
      {"level":"L3","project_type":"发动机|气门室盖|正时|水泵|节温器|喷油嘴|节气门","fixed_reward":100,"float_ratio":0,"cap_amount":800},
      {"level":"L3","project_type":"变速箱|阀体|油封","fixed_reward":100,"float_ratio":0,"cap_amount":800},
      {"level":"L3","project_type":"底盘|减震器|下摆臂|转向机|元宝梁","fixed_reward":100,"float_ratio":0,"cap_amount":800},
      {"level":"L3","project_type":"ABS|刹车总泵|刹车分泵","fixed_reward":100,"float_ratio":0,"cap_amount":800},
      {"level":"L3","project_type":"车身电脑|空调压缩机|发电机|起动机","fixed_reward":100,"float_ratio":0,"cap_amount":800},
      {"level":"L3","project_type":"三电|电池包均衡|车载充电机|DC-DC","fixed_reward":100,"float_ratio":0,"cap_amount":800},
      {"level":"L4","project_type":"大修|缸体|重组","fixed_reward":300,"float_ratio":0,"cap_amount":2000},
      {"level":"L4","project_type":"变速箱拆解|变矩器","fixed_reward":300,"float_ratio":0,"cap_amount":2000},
      {"level":"L4","project_type":"事故车|整车修复|纵梁|ABC柱","fixed_reward":300,"float_ratio":0,"cap_amount":2000},
      {"level":"L4","project_type":"泡水|电路重构","fixed_reward":300,"float_ratio":0,"cap_amount":2000},
      {"level":"L4","project_type":"疑难故障|隐性故障","fixed_reward":300,"float_ratio":0,"cap_amount":2000},
      {"level":"L4","project_type":"电池包拆解|电芯更换|驱动电机大修|电机控制器","fixed_reward":300,"float_ratio":0,"cap_amount":2000}
    ],
    "vehicleTierLowMax":100000,
    "vehicleTierMediumMax":300000,
    "vehicleTierLowCapUp":20,
    "lowEndL4Amplify":2.5,
    "floatCalibration":{"low":{"L1":0.5,"L2":0.5,"L3":0.8,"L4":1},"medium":{"L1":0,"L2":0,"L3":0,"L4":0},"high":{"L1":-0.5,"L2":-0.5,"L3":-0.8,"L4":-1}},
    "orderTier1Max":1000,
    "orderTier2Max":5000,
    "orderTier3Max":20000,
    "orderTier1Cap":30,
    "orderTier2Cap":150,
    "orderTier3Cap":800,
    "orderTier4Cap":2000,
    "complianceRedLine":70,
    "upgradeMaxPer3Months":2,
    "upgradeReviewHours":24,
    "commissionTier1Max":5000,
    "commissionTier2Max":20000,
    "commissionTier1Rate":8,
    "commissionTier2Rate":10,
    "commissionTier3Rate":12,
    "commissionDownMinRatio":50,
    "commissionUpMaxRatio":120,
    "commissionDownPercent":1,
    "commissionUpPercent":2
  }',
  '奖励金规则配置（模块1-5：复杂度/车价/订单分级/合规/佣金）'
)
ON DUPLICATE KEY UPDATE rule_value = VALUES(rule_value), description = VALUES(description);

-- 从 settings 删除本应在 reward_rules 中的配置
DELETE FROM settings WHERE `key` = 'rewardRules';
