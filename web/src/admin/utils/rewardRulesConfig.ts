/**
 * 奖励金规则配置默认值与数据结构
 * 基础轨已简化：复杂度表仅等级+关键词+固定奖励（入库仍带 float_ratio/cap_amount=0）；车价仅分档阈值+系数；订单分级仅金额阈值；合规仅红线%。
 */

/** 维修佣金类目覆盖键，与服务端 repair-commission-category 解析结果一致 */
export const COMMISSION_REPAIR_CATEGORY_OPTIONS = [
  '钣金喷漆',
  '保养服务',
  '发动机维修',
  '电路维修',
  '换胎',
  '美容',
];

const Z = { L1: 0, L2: 0, L3: 0, L4: 0 };

export function getDefaultRewardRulesConfig(): { rewardRules: Record<string, any> } {
  return {
    rewardRules: {
      complexityLevels: [
        { level: 'L1', project_type: '洗车', fixed_reward: 10, float_ratio: 0, cap_amount: 0 },
        { level: 'L2', project_type: '钣金|喷漆|翼子板|车门', fixed_reward: 30, float_ratio: 0, cap_amount: 0 },
        { level: 'L3', project_type: '发动机|变速箱', fixed_reward: 150, float_ratio: 0, cap_amount: 0 },
        { level: 'L4', project_type: '事故车|整车修复|大修', fixed_reward: 450, float_ratio: 0, cap_amount: 0 },
      ],
      baseReward: { L1: 10, L2: 30, L3: 150, L4: 450 },
      baseRewardInsurance: { L1: 20, L2: 60, L3: 300, L4: 900 },
      vehicleTierLowMax: 100000,
      vehicleTierMediumMax: 300000,
      vehicleTierLowCapUp: 0,
      vehicleCoeff: [
        { max: 10, coeff: 1.0 },
        { max: 20, coeff: 1.2 },
        { max: 30, coeff: 1.5 },
        { max: 50, coeff: 2.0 },
        { max: 9999, coeff: 3.0 },
      ],
      lowEndL4Amplify: 1,
      floatCalibration: { low: { ...Z }, medium: { ...Z }, high: { ...Z } },
      orderTier1Max: 1000,
      orderTier2Max: 5000,
      orderTier3Max: 20000,
      orderTier1Cap: 0,
      orderTier2Cap: 0,
      orderTier3Cap: 0,
      orderTier4Cap: 0,
      complianceRedLine: 70,
      upgradeMaxPer3Months: 0,
      upgradeReviewHours: 0,
      commissionRepair: {
        self_pay: { default: 6, byCategory: {} },
        insurance: { default: 12, byCategory: {} },
      },
    },
  };
}
