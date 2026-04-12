/**
 * 奖励金规则配置默认值与数据结构
 * 对应《全指标底层逻辑梳理》第四章
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

export function getDefaultRewardRulesConfig(): { rewardRules: Record<string, any> } {
  return {
    rewardRules: {
      // 模块 1：复杂度等级（level + project_type 关键词 + fixed_reward/float_ratio/cap_amount）
      complexityLevels: [
        { level: 'L1', project_type: '洗车', fixed_reward: 10, float_ratio: 0, cap_amount: 50 },
        { level: 'L2', project_type: '钣金|喷漆|翼子板|车门', fixed_reward: 30, float_ratio: 0, cap_amount: 200 },
        { level: 'L3', project_type: '发动机|变速箱', fixed_reward: 150, float_ratio: 0, cap_amount: 800 },
        { level: 'L4', project_type: '事故车|整车修复|大修', fixed_reward: 450, float_ratio: 0, cap_amount: 2000 },
      ],
      baseReward: { L1: 10, L2: 30, L3: 150, L4: 450 },
      baseRewardInsurance: { L1: 20, L2: 60, L3: 300, L4: 900 },
      // 模块 2：车价分级
      vehicleTierLowMax: 100000,
      vehicleTierMediumMax: 300000,
      vehicleTierLowCapUp: 20,
      // 车价校准系数 5 档（单位万元，max 为区间上限，coeff 为系数）
      vehicleCoeff: [
        { max: 10, coeff: 1.0 },
        { max: 20, coeff: 1.2 },
        { max: 30, coeff: 1.5 },
        { max: 50, coeff: 2.0 },
        { max: 9999, coeff: 3.0 },
      ],
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
      // 模块 5：维修订单固定佣金（付款方 default + 可选类目覆盖；标品走 settings product_order_platform_fee_rate）
      commissionRepair: {
        self_pay: { default: 6, byCategory: {} },
        insurance: { default: 12, byCategory: {} },
      },
    },
  };
}
