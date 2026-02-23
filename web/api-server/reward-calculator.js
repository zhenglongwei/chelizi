/**
 * 奖励金计算服务
 * 按《全指标底层逻辑梳理》第四章实现
 * 公式：用户奖励金 = （基础固定奖励 × 车价校准系数 × 维修复杂度校准系数） + 优质内容浮动奖励
 * 双重约束：单订单封顶、70% 佣金红线
 */

// 全指标 4.2 基础固定奖励（元）
const BASE_REWARD = { L1: 10, L2: 30, L3: 100, L4: 300 };

// 全指标 4.3 车价校准系数（车辆官方指导价 万元）
const VEHICLE_COEFF = [
  { max: 10, coeff: 1.0 },
  { max: 20, coeff: 1.2 },
  { max: 30, coeff: 1.5 },
  { max: 50, coeff: 2.0 },
  { max: Infinity, coeff: 3.0 },
];

// 全指标 4.6 单订单封顶（元）
const ORDER_CAP = { L1: 50, L2: 200, L3: 800, L4: 2000 };
const INSURANCE_ACCIDENT_CAP = 3000;

// 全指标 4.5 优质内容浮动奖励：优质评价 = 基础奖励的 50%，爆款标杆 = 100%
const PREMIUM_FLOAT_RATIO = 0.5;
const VIRAL_FLOAT_RATIO = 1.0;

/**
 * 从 repair_complexity_levels、reward_rules 表读取规则（方案 A：admin 配置即生效）
 * 表为空时返回 {}，计算逻辑使用模块内默认值
 */
async function getRewardRules(pool) {
  const rules = {};
  try {
    // 1. repair_complexity_levels：按 level 取 fixed_reward、cap_amount
    const [levelRows] = await pool.execute(
      'SELECT `level`, fixed_reward, cap_amount FROM repair_complexity_levels ORDER BY `level`, id'
    );
    const byLevel = {};
    for (const r of levelRows || []) {
      const L = (r.level || '').toUpperCase();
      if (!L || !['L1', 'L2', 'L3', 'L4'].includes(L)) continue;
      if (!byLevel[L]) {
        byLevel[L] = { fixed_reward: parseFloat(r.fixed_reward) || 0, cap_amount: parseFloat(r.cap_amount) || 0 };
      }
    }
    if (Object.keys(byLevel).length > 0) {
      rules.baseReward = {};
      rules.orderCap = {};
      for (const L of ['L1', 'L2', 'L3', 'L4']) {
        if (byLevel[L]) {
          rules.baseReward[L] = byLevel[L].fixed_reward;
          rules.orderCap[L] = byLevel[L].cap_amount;
        }
      }
    }

    // 2. reward_rules：rule_key -> rule_value 合并
    const [ruleRows] = await pool.execute('SELECT rule_key, rule_value FROM reward_rules');
    for (const r of ruleRows || []) {
      const key = r.rule_key;
      if (!key) continue;
      let val = r.rule_value;
      if (typeof val === 'string') {
        try {
          val = val ? JSON.parse(val) : null;
        } catch {
          val = val;
        }
      }
      rules[key] = val;
    }

    // 3. 兼容旧 settings.rewardRules（若表为空则回退读取，便于迁移过渡）
    if (Object.keys(rules).length === 0) {
      const [settingsRows] = await pool.execute("SELECT `value` FROM settings WHERE `key` = 'rewardRules'");
      if (settingsRows.length > 0 && settingsRows[0].value) {
        const parsed = typeof settingsRows[0].value === 'string' ? JSON.parse(settingsRows[0].value) : settingsRows[0].value;
        return parsed || {};
      }
    }

    return rules;
  } catch {
    return {};
  }
}

/**
 * 车价校准系数（全指标 4.3）
 * @param {number} vehiclePrice - 裸车价（元），null 时返回 1.0
 */
function getVehicleCoeff(vehiclePrice, rules = {}) {
  if (vehiclePrice == null || vehiclePrice <= 0) return 1.0;
  const priceWan = vehiclePrice / 10000;
  const overrides = rules.vehicleCoeff || rules.vehicle_coeff;
  if (overrides && Array.isArray(overrides)) {
    const m = overrides.find((o) => priceWan <= (o.max ?? o.maxWan ?? Infinity));
    if (m) return parseFloat(m.coeff) ?? 1.0;
  }
  const m = VEHICLE_COEFF.find((v) => priceWan <= v.max);
  return m ? m.coeff : 3.0;
}

/**
 * 维修复杂度校准系数（全指标 4.4）
 * 基础项目 1.0；高难度 1.5；保险事故车 2.0
 */
function getComplexityCoeff(isInsuranceAccident, isHighDifficulty, rules = {}) {
  if (isInsuranceAccident) return rules.insuranceAccidentCoeff ?? 2.0;
  if (isHighDifficulty) return rules.highDifficultyCoeff ?? 1.5;
  return 1.0;
}

/**
 * 根据维修金额确定订单分级 1-4（用于分阶段发放）
 * 阈值从 reward_rules 读取，默认 1000/5000/20000
 */
function getOrderTier(amount, rules = {}) {
  const a = parseFloat(amount) || 0;
  const t1 = rules.orderTier1Max ?? 1000;
  const t2 = rules.orderTier2Max ?? 5000;
  const t3 = rules.orderTier3Max ?? 20000;
  if (a <= t1) return 1;
  if (a <= t2) return 2;
  if (a <= t3) return 3;
  return 4;
}

/**
 * 计算平台实收佣金率
 */
function calcCommissionRate(rules, orderAmount, shopComplianceRate, shopComplaintRate, hasViolation) {
  const a = parseFloat(orderAmount) || 0;
  const t1 = rules.commissionTier1Max ?? 5000;
  const t2 = rules.commissionTier2Max ?? 20000;
  let baseRate = (rules.commissionTier3Rate ?? 12) / 100;
  if (a <= t1) baseRate = (rules.commissionTier1Rate ?? 8) / 100;
  else if (a <= t2) baseRate = (rules.commissionTier2Rate ?? 10) / 100;

  const downMin = (rules.commissionDownMinRatio ?? 50) / 100;
  const upMax = (rules.commissionUpMaxRatio ?? 120) / 100;
  const downPct = (rules.commissionDownPercent ?? 1) / 100;
  const upPct = (rules.commissionUpPercent ?? 2) / 100;

  if (hasViolation || (shopComplianceRate != null && shopComplianceRate < 80)) {
    baseRate = Math.min(baseRate * (1 + upPct), baseRate * upMax);
  } else if (shopComplianceRate != null && shopComplianceRate >= 95 && shopComplaintRate != null && shopComplaintRate <= 1) {
    baseRate = Math.max(baseRate * (1 - downPct), baseRate * downMin);
  }
  return baseRate;
}

/**
 * 计算订单税前奖励金（基础部分，不含优质浮动）
 * @param {object} pool - 数据库连接池
 * @param {object} order - { actual_amount, quoted_amount, complexity_level, vehicle_price_tier, order_tier, is_insurance_accident }
 * @param {object} vehicleInfo - { vehicle_price } 裸车价（元）
 * @param {object} quoteItems - 报价项目 [{ name }]
 * @param {object} shop - { compliance_rate, complaint_rate, has_violation }
 * @returns {Promise<{ reward_pre, reward_base, order_tier, complexity_level, vehicle_price_tier, commission_rate, commission_amount, stages, complexity_level }>}
 */
async function calculateReward(pool, order, vehicleInfo = {}, quoteItems = [], shop = {}) {
  const rules = await getRewardRules(pool);
  const M_order = parseFloat(order.actual_amount || order.quoted_amount) || 0;
  const vehiclePrice = vehicleInfo?.vehicle_price != null ? parseFloat(vehicleInfo.vehicle_price) : null;
  const orderTier = order.order_tier ?? getOrderTier(M_order, rules);

  // 复杂度：优先用订单已有值，否则从 repair_complexity_levels 匹配维修项目，未匹配时默认 L2
  let L = (order.complexity_level || '').toUpperCase();
  if (!L || !['L1', 'L2', 'L3', 'L4'].includes(L)) {
    const complexityService = require('./services/complexity-service');
    const { level } = await complexityService.resolveComplexityFromItems(pool, quoteItems);
    L = level;
  }
  const isInsuranceAccident = !!(order.is_insurance_accident);
  const vehicleCoeff = getVehicleCoeff(vehiclePrice, rules);
  const isHighDifficulty = ['L3', 'L4'].includes(L);
  const complexityCoeff = getComplexityCoeff(isInsuranceAccident, isHighDifficulty, rules);

  const baseFixed = rules.baseReward?.[L] ?? BASE_REWARD[L] ?? BASE_REWARD.L2;
  const baseReward = baseFixed * vehicleCoeff * complexityCoeff;

  const capBase = isInsuranceAccident ? INSURANCE_ACCIDENT_CAP : (ORDER_CAP[L] ?? ORDER_CAP.L2);
  const capFromRules = rules.orderCap?.[L] ?? rules[`orderCap${L}`];
  const orderCap = capFromRules ?? capBase;

  const commissionRate = calcCommissionRate(
    rules, M_order,
    shop.compliance_rate,
    shop.complaint_rate,
    shop.has_violation
  );
  const commission = M_order * commissionRate;
  const maxByCommission = commission * ((rules.complianceRedLine ?? 70) / 100);

  let rewardPre = Math.min(baseReward, orderCap, maxByCommission);
  rewardPre = Math.max(0, Math.round(rewardPre * 100) / 100);

  return {
    reward_pre: rewardPre,
    reward_base: rewardPre,
    order_tier: orderTier,
    complexity_level: L,
    vehicle_price_tier: vehiclePrice != null ? (vehiclePrice < 100000 ? 'low' : vehiclePrice < 300000 ? 'mid' : 'high') : 'mid',
    commission_rate: commissionRate,
    commission_amount: Math.round(commission * 100) / 100,
    stages: getReleaseStages(orderTier, rewardPre),
  };
}

/**
 * 优质内容浮动奖励（在 calculateReward 基础上追加）
 * @param {number} rewardBase - 基础奖励
 * @param {boolean} isPremium - 是否优质评价
 * @param {boolean} isViral - 是否爆款标杆（同车型浏览量超1万+大量收藏点赞，暂不实现则 false）
 * @returns {number} 浮动奖励金额
 */
function calcPremiumFloatReward(rewardBase, isPremium, isViral = false) {
  if (isViral) return Math.round(rewardBase * VIRAL_FLOAT_RATIO * 100) / 100;
  if (isPremium) return Math.round(rewardBase * PREMIUM_FLOAT_RATIO * 100) / 100;
  return 0;
}

/**
 * 分阶段发放规则（全指标 4.7）
 */
function getReleaseStages(orderTier, totalReward) {
  if (orderTier <= 2) {
    return [{ stage: 'main', percent: 100, amount: totalReward.toFixed(2) }];
  }
  if (orderTier === 3) {
    return [
      { stage: 'main', percent: 50, amount: (totalReward * 0.5).toFixed(2) },
      { stage: '1m', percent: 50, amount: (totalReward * 0.5).toFixed(2) },
    ];
  }
  return [
    { stage: 'main', percent: 50, amount: (totalReward * 0.5).toFixed(2) },
    { stage: '1m', percent: 30, amount: (totalReward * 0.3).toFixed(2) },
    { stage: '3m', percent: 20, amount: (totalReward * 0.2).toFixed(2) },
  ];
}

module.exports = {
  getRewardRules,
  getVehicleCoeff,
  getComplexityCoeff,
  getOrderTier,
  calcCommissionRate,
  calculateReward,
  calcPremiumFloatReward,
  getReleaseStages,
  BASE_REWARD,
  ORDER_CAP,
  PREMIUM_FLOAT_RATIO,
};
