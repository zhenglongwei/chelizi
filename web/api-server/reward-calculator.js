/**
 * 奖励金计算服务
 * 按《评价奖励金体系-设计方案》实现，从 settings.rewardRules 读取配置
 */

const DEFAULT_RULES = {
  complexityLevels: [
    { id: 'L1', fixedReward: 10, floatRatio: 1, capAmount: 30 },
    { id: 'L2', fixedReward: 20, floatRatio: 2, capAmount: 150 },
    { id: 'L3', fixedReward: 50, floatRatio: 3, capAmount: 800 },
    { id: 'L4', fixedReward: 100, floatRatio: 4, capAmount: 2000 },
  ],
  vehicleTierLowMax: 100000,
  vehicleTierMediumMax: 300000,
  vehicleTierLowCapUp: 20,
  lowEndL4Amplify: 2.5,
  floatCalibration: {
    low: { L1: 0.5, L2: 0.5, L3: 0.8, L4: 1 },
    medium: { L1: 0, L2: 0, L3: 0, L4: 0 },
    high: { L1: -0.5, L2: -0.5, L3: -0.8, L4: -1 },
  },
  orderTier1Max: 1000,
  orderTier2Max: 5000,
  orderTier3Max: 20000,
  orderTier1Cap: 30,
  orderTier2Cap: 150,
  orderTier3Cap: 800,
  orderTier4Cap: 2000,
  complianceRedLine: 70,
  commissionTier1Max: 5000,
  commissionTier2Max: 20000,
  commissionTier1Rate: 8,
  commissionTier2Rate: 10,
  commissionTier3Rate: 12,
};

/**
 * 从 settings 表读取 rewardRules 配置
 */
async function getRewardRules(pool) {
  try {
    const [rows] = await pool.execute("SELECT `value` FROM settings WHERE `key` = 'rewardRules'");
    if (rows.length === 0 || !rows[0].value) return DEFAULT_RULES;
    const parsed = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
    return { ...DEFAULT_RULES, ...parsed };
  } catch {
    return DEFAULT_RULES;
  }
}

/**
 * 根据裸车价（元）确定车型分级：low / mid / high
 */
function getVehicleTier(vehiclePrice, rules) {
  if (vehiclePrice == null || vehiclePrice <= 0) return 'mid';
  const lowMax = rules.vehicleTierLowMax ?? 100000;
  const midMax = rules.vehicleTierMediumMax ?? 300000;
  if (vehiclePrice < lowMax) return 'low';
  if (vehiclePrice < midMax) return 'mid';
  return 'high';
}

/**
 * 根据维修金额确定订单分级 1-4
 */
function getOrderTier(amount, rules) {
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
 * 根据报价 items 推断最高复杂度（简化：按金额占比或默认 L2）
 * 若无明细则按订单分级反推：一级 L1-L2，二级 L2-L3，三级 L3-L4，四级 L4
 */
function inferComplexityLevel(orderTier, quoteItems) {
  if (quoteItems && Array.isArray(quoteItems) && quoteItems.length > 0) {
    // 简化：按项目名称关键词匹配，无则取 L2
    const names = quoteItems.map(i => (i.name || '').toLowerCase()).join(' ');
    if (names.includes('大修') || names.includes('变速箱') || names.includes('发动机') || names.includes('事故')) return 'L4';
    if (names.includes('底盘') || names.includes('故障')) return 'L3';
    if (names.includes('保养') || names.includes('喷漆') || names.includes('钣金')) return 'L2';
  }
  if (orderTier === 1) return 'L1';
  if (orderTier === 2) return 'L2';
  if (orderTier === 3) return 'L3';
  return 'L4';
}

/**
 * 计算单个项目税前奖励金（订单简化为单项目时，M_item = M_order）
 */
function calcItemReward(rules, L, S, M_item, isUpgraded = false) {
  const levels = rules.complexityLevels || DEFAULT_RULES.complexityLevels;
  const levelConfig = levels.find(l => l.id === L) || levels[0];
  const fixed = parseFloat(levelConfig.fixedReward) || 0;
  const baseRatio = (parseFloat(levelConfig.floatRatio) || 0) / 100;
  const capBase = parseFloat(levelConfig.capAmount) || 30;

  const cal = rules.floatCalibration || DEFAULT_RULES.floatCalibration;
  const delta = (cal[S] && cal[S][L]) != null ? (cal[S][L] / 100) : 0;
  const ratio = baseRatio + delta;

  let itemReward = fixed + M_item * ratio;

  if (S === 'low' && L === 'L4' && !isUpgraded) {
    const amp = parseFloat(rules.lowEndL4Amplify) || 2.5;
    itemReward *= amp;
  }

  const capUp = S === 'low' ? ((rules.vehicleTierLowCapUp ?? 20) / 100 + 1) : 1;
  const cap = capBase * capUp;
  itemReward = Math.max(0, Math.min(itemReward, cap));
  return itemReward;
}

/**
 * 计算订单税前总奖励金（简化：单项目模式，M_order = 单项目金额）
 */
function calcOrderRewardPre(rules, L, S, M_order, isUpgraded = false) {
  const itemReward = calcItemReward(rules, L, S, M_order, isUpgraded);
  const orderTier = getOrderTier(M_order, rules);
  const caps = [
    rules.orderTier1Cap ?? 30,
    rules.orderTier2Cap ?? 150,
    rules.orderTier3Cap ?? 800,
    rules.orderTier4Cap ?? 2000,
  ];
  let orderCap = caps[orderTier - 1] ?? 30;
  if (S === 'low') orderCap *= ((rules.vehicleTierLowCapUp ?? 20) / 100 + 1);
  return Math.min(itemReward, orderCap);
}

/**
 * 计算平台实收佣金（按订单金额分级 + 合规率浮动）
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
  } else if (shopComplianceRate != null && shopComplaintRate != null && shopComplianceRate >= 95 && shopComplaintRate <= 1) {
    baseRate = Math.max(baseRate * (1 - downPct), baseRate * downMin);
  }
  return baseRate;
}

/**
 * 计算订单税前奖励金（含合规红线约束）
 * @param {object} pool - 数据库连接池
 * @param {object} order - { actual_amount, quoted_amount, complexity_level, vehicle_price_tier, order_tier }
 * @param {object} vehicleInfo - { vehicle_price } 裸车价（元）
 * @param {object} quoteItems - 报价项目 [{ name }]
 * @param {object} shop - { compliance_rate, complaint_rate } 可选
 */
async function calculateReward(pool, order, vehicleInfo = {}, quoteItems = [], shop = {}) {
  const rules = await getRewardRules(pool);
  const M_order = parseFloat(order.actual_amount || order.quoted_amount) || 0;
  const vehiclePrice = vehicleInfo?.vehicle_price != null ? parseFloat(vehicleInfo.vehicle_price) : null;
  const S = order.vehicle_price_tier || getVehicleTier(vehiclePrice, rules);
  const orderTier = order.order_tier || getOrderTier(M_order, rules);
  const L = order.complexity_level || inferComplexityLevel(orderTier, quoteItems);
  const isUpgraded = false; // 破格升级需查 complexity_upgrade_requests

  let rewardPre = calcOrderRewardPre(rules, L, S, M_order, isUpgraded);

  const commissionRate = calcCommissionRate(
    rules, M_order,
    shop.compliance_rate,
    shop.complaint_rate,
    shop.has_violation
  );
  const commission = M_order * commissionRate;
  const redLine = (rules.complianceRedLine ?? 70) / 100;
  const maxByCommission = commission * redLine;
  rewardPre = Math.min(rewardPre, maxByCommission);

  return {
    reward_pre: Math.round(rewardPre * 100) / 100,
    order_tier: orderTier,
    complexity_level: L,
    vehicle_price_tier: S,
    commission_rate: commissionRate,
    commission_amount: Math.round(commission * 100) / 100,
    stages: getReleaseStages(orderTier, rewardPre),
  };
}

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
  getVehicleTier,
  getOrderTier,
  inferComplexityLevel,
  calcOrderRewardPre,
  calcCommissionRate,
  calculateReward,
  getReleaseStages,
};
