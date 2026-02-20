/**
 * 奖励金规则配置默认值与数据结构
 * 对应《评价奖励金体系-设计方案》
 */

export function getDefaultRewardRulesConfig(): { rewardRules: Record<string, any> } {
  return {
    rewardRules: {
      // 模块 1：复杂度等级
      complexityLevels: [
        { id: 'L1', name: '极低复杂度', projectTypes: '标准化换件、补胎、基础车辆检测等', fixedReward: 10, floatRatio: 1, capAmount: 30 },
        { id: 'L2', name: '低复杂度', projectTypes: '常规小保养、钣金喷漆、易损件更换等', fixedReward: 20, floatRatio: 2, capAmount: 150 },
        { id: 'L3', name: '中复杂度', projectTypes: '常规故障维修、底盘整备、发动机局部维修等', fixedReward: 50, floatRatio: 3, capAmount: 800 },
        { id: 'L4', name: '高复杂度', projectTypes: '疑难故障排查、发动机/变速箱大修、事故车整车修复等', fixedReward: 100, floatRatio: 4, capAmount: 2000 },
      ],
      // 模块 2：车价分级
      vehicleTierLowMax: 100000,
      vehicleTierMediumMax: 300000,
      vehicleTierLowCapUp: 20,
      lowEndL4Amplify: 2.5,
      floatCalibration: {
        low: { L1: 0.5, L2: 0.5, L3: 0.8, L4: 1 },
        medium: { L1: 0, L2: 0, L3: 0, L4: 0 },
        high: { L1: -0.5, L2: -0.5, L3: -0.8, L4: -1 },
      },
      // 模块 3：订单分级
      orderTier1Max: 1000,
      orderTier2Max: 5000,
      orderTier3Max: 20000,
      orderTier1Cap: 30,
      orderTier2Cap: 150,
      orderTier3Cap: 800,
      orderTier4Cap: 2000,
      // 模块 4：合规规则
      complianceRedLine: 70,
      upgradeMaxPer3Months: 2,
      upgradeReviewHours: 24,
      // 模块 5：佣金配置
      commissionTier1Max: 5000,
      commissionTier2Max: 20000,
      commissionTier1Rate: 8,
      commissionTier2Rate: 10,
      commissionTier3Rate: 12,
      commissionDownMinRatio: 50,
      commissionUpMaxRatio: 120,
      commissionDownPercent: 1,
      commissionUpPercent: 2,
    },
  };
}
