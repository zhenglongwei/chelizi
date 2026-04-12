/**
 * 奖励金计算服务
 * 按《全链路激励驱动体系》实现
 * 公式：用户奖励金 = 复杂度基础固定奖励 × 车价校准系数 + 优质内容浮动奖励
 * 双重约束：单订单封顶、70% 佣金红线
 * 注：维修复杂度校准系数已并入基础固定奖励（方案A）
 */

// 基础固定奖励（元）：L3/L4 已并入原 1.5 倍，保险事故车单独档位
const BASE_REWARD = { L1: 10, L2: 30, L3: 150, L4: 450 };
const BASE_REWARD_INSURANCE = { L1: 20, L2: 60, L3: 300, L4: 900 };

// 全指标 4.3 车价校准系数（车辆官方指导价 万元）
const VEHICLE_COEFF = [
  { max: 10, coeff: 1.0 },
  { max: 20, coeff: 1.2 },
  { max: 30, coeff: 1.5 },
  { max: 50, coeff: 2.0 },
  { max: Infinity, coeff: 3.0 },
];

// 全指标 4.6 按复杂度单订单封顶（元）
const ORDER_CAP = { L1: 50, L2: 200, L3: 800, L4: 2000 };
const INSURANCE_ACCIDENT_CAP = 3000;

// 03-全链路激励 按订单分级封顶（元）：一级≤1000/二级150/三级800/四级2000
const ORDER_TIER_CAP = { 1: 30, 2: 150, 3: 800, 4: 2000 };

// 全指标 4.5 优质内容浮动奖励：优质评价 = 基础奖励的 50%，爆款标杆 = 100%
const PREMIUM_FLOAT_RATIO = 0.5;
const VIRAL_FLOAT_RATIO = 1.0;

const { resolveRepairCommissionCategory } = require('./utils/repair-commission-category');

function defaultCommissionRepair() {
  return {
    self_pay: { default: 6, byCategory: {} },
    insurance: { default: 12, byCategory: {} },
  };
}

/**
 * 合并维修固定佣金配置（付款方 × 可选类目覆盖）
 */
function mergeCommissionRepair(raw) {
  const base = defaultCommissionRepair();
  if (!raw || typeof raw !== 'object') return base;
  const sp = raw.self_pay || raw.selfPay || {};
  const ins = raw.insurance || raw.insurance_accident || {};
  return {
    self_pay: {
      default: parseFloat(sp.default) >= 0 ? parseFloat(sp.default) : base.self_pay.default,
      byCategory: { ...base.self_pay.byCategory, ...(typeof sp.byCategory === 'object' && sp.byCategory ? sp.byCategory : {}) },
    },
    insurance: {
      default: parseFloat(ins.default) >= 0 ? parseFloat(ins.default) : base.insurance.default,
      byCategory: { ...base.insurance.byCategory, ...(typeof ins.byCategory === 'object' && ins.byCategory ? ins.byCategory : {}) },
    },
  };
}

/**
 * 维修订单固定佣金比例（小数，如 0.06）
 * @param {object} rules - getRewardRules 结果（须含 commissionRepair）
 * @param {{ isInsuranceAccident?: boolean|number|string, repairCategory?: string|null }} opts
 */
function calcRepairCommissionRate(rules, opts = {}) {
  const cr = rules.commissionRepair || defaultCommissionRepair();
  const ins =
    opts.isInsuranceAccident === true
    || opts.isInsuranceAccident === 1
    || opts.isInsuranceAccident === '1';
  const branch = ins ? cr.insurance : cr.self_pay;
  let pct = parseFloat(branch.default);
  if (isNaN(pct) || pct < 0) pct = ins ? 12 : 6;
  pct = Math.min(pct, 100);
  const cat = opts.repairCategory;
  if (cat && branch.byCategory && branch.byCategory[cat] != null) {
    const p = parseFloat(branch.byCategory[cat]);
    if (!isNaN(p) && p >= 0) pct = Math.min(p, 100);
  }
  return Math.round(pct * 100) / 10000;
}

/**
 * 从 quotes 拉取报价行项目（供结算侧无 quoteItems 时）
 */
async function loadQuoteItemsByQuoteId(pool, quoteId) {
  if (!quoteId) return [];
  try {
    const [rows] = await pool.execute('SELECT items FROM quotes WHERE quote_id = ?', [quoteId]);
    if (!rows.length || !rows[0].items) return [];
    const raw = rows[0].items;
    const arr = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

/**
 * 单笔订单平台佣金金额（维修单；标品不走此函数）
 */
async function computeOrderCommissionAmount(pool, order) {
  const rules = await getRewardRules(pool);
  let items = [];
  if (order.quote_id) {
    items = await loadQuoteItemsByQuoteId(pool, order.quote_id);
  }
  const repairCategory = resolveRepairCommissionCategory(items);
  const ins = order.is_insurance_accident === 1 || order.is_insurance_accident === '1';
  const rate = calcRepairCommissionRate(rules, { isInsuranceAccident: ins, repairCategory });
  const amt = parseFloat(order.actual_amount || order.quoted_amount) || 0;
  return Math.round(amt * rate * 100) / 100;
}

/**
 * 从 reward_rules 表读取规则（唯一数据源）
 * 配置缺失时直接报错，不兼容 settings 或 repair_complexity_levels
 */
async function getRewardRules(pool) {
  const rewardRulesLoader = require('./services/reward-rules-loader');
  const config = await rewardRulesLoader.getRewardRulesConfig(pool);

  const rules = { ...config };
  if (config.baseReward && typeof config.baseReward === 'object') {
    rules.baseReward = config.baseReward;
  }
  if (config.baseRewardInsurance && typeof config.baseRewardInsurance === 'object') {
    rules.baseRewardInsurance = config.baseRewardInsurance;
  }

  // 从 complexityLevels 聚合 orderCap（按 level 取首条）；baseReward 缺失时从 complexityLevels 兜底
  const levels = config.complexityLevels;
  if (Array.isArray(levels) && levels.length > 0) {
    const byLevel = {};
    for (const r of levels) {
      const L = (r.level || '').toUpperCase();
      if (!L || !['L1', 'L2', 'L3', 'L4'].includes(L)) continue;
      if (!byLevel[L]) {
        byLevel[L] = {
          fixed_reward: parseFloat(r.fixed_reward) || 0,
          cap_amount: parseFloat(r.cap_amount) || 0,
        };
      }
    }
    rules.orderCap = {};
    for (const L of ['L1', 'L2', 'L3', 'L4']) {
      if (byLevel[L]) {
        rules.orderCap[L] = byLevel[L].cap_amount;
      }
    }
    if (!config.baseReward || typeof config.baseReward !== 'object') {
      rules.baseReward = {};
      for (const L of ['L1', 'L2', 'L3', 'L4']) {
        if (byLevel[L]) rules.baseReward[L] = byLevel[L].fixed_reward;
      }
    }
    if (!config.baseRewardInsurance || typeof config.baseRewardInsurance !== 'object') {
      rules.baseRewardInsurance = {};
      for (const L of ['L1', 'L2', 'L3', 'L4']) {
        if (byLevel[L]) rules.baseRewardInsurance[L] = (byLevel[L].fixed_reward || 0) * 2;
      }
    }
  }

  rules.commissionRepair = mergeCommissionRepair(config.commissionRepair);

  return rules;
}

/**
 * 车价校准系数（全指标 4.3）
 * @param {number} vehiclePrice - 裸车价（元），null 时尝试用 vehicle_price_tier
 * @param {object} rules - 规则配置
 * @param {string} vehiclePriceTier - 车型档次 low/mid/high（大模型根据品牌推断），无价格时使用
 * @param {string} brand - 品牌名，用于无 tier 时的兜底推断（如沃尔沃→mid）
 */
function getVehicleCoeff(vehiclePrice, rules = {}, vehiclePriceTier = null, brand = null) {
  if (vehiclePrice != null && vehiclePrice > 0) {
    const priceWan = vehiclePrice / 10000;
    const overrides = rules.vehicleCoeff || rules.vehicle_coeff;
    if (overrides && Array.isArray(overrides)) {
      const m = overrides.find((o) => priceWan <= (o.max ?? o.maxWan ?? Infinity));
      if (m) return parseFloat(m.coeff) ?? 1.0;
    }
    const m = VEHICLE_COEFF.find((v) => priceWan <= v.max);
    return m ? m.coeff : 3.0;
  }
  const tier = (vehiclePriceTier || '').toLowerCase();
  if (['low', 'mid', 'high'].includes(tier)) {
    return { low: 1.0, mid: 1.3, high: 1.5 }[tier];
  }
  if (brand) {
    const b = String(brand).toLowerCase();
    if (/沃尔沃|奔驰|宝马|奥迪|特斯拉|蔚来|理想|保时捷|路虎|雷克萨斯|凯迪拉克|林肯/i.test(b)) return 1.3;
    if (/丰田|本田|日产|大众|吉利|比亚迪|长安|哈弗/i.test(b)) return 1.0;
  }
  return 1.0;
}

/**
 * 配件数量升级：L1/L2 项目数 > 3 时升级 1 级（L2→L3, L1→L2）
 * @param {string} L - 当前复杂度 L1|L2|L3|L4
 * @param {Array} items - 维修项目 [{ name, repair_type }]
 */
function applyComplexityUpgrade(L, items = []) {
  if (!['L1', 'L2'].includes(L)) return L;
  const count = (items || []).filter((i) => {
    const n = String(i.name || i.damage_part || i.item || '').trim();
    return n.length > 0;
  }).length;
  if (count > 3) return L === 'L1' ? 'L2' : 'L3';
  return L;
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
 * 计算订单税前奖励金（基础部分，不含优质浮动）
 * @param {object} pool - 数据库连接池
 * @param {object} order - { actual_amount, quoted_amount, complexity_level, vehicle_price_tier, order_tier, is_insurance_accident }
 * @param {object} vehicleInfo - { vehicle_price, vehicle_price_max } 裸车价（元），vehicle_price_max 为大模型推断的车型指导价上限
 * @param {object} quoteItems - 报价项目 [{ name }]
 * @param {object} shop - 保留入参兼容；佣金率不再依赖合规浮动
 * @returns {Promise<{ reward_pre, reward_base, order_tier, complexity_level, vehicle_price_tier, commission_rate, commission_amount, stages, complexity_level }>}
 */
async function calculateReward(pool, order, vehicleInfo = {}, quoteItems = [], shop = {}) {
  const rules = await getRewardRules(pool);
  const M_order = parseFloat(order.actual_amount || order.quoted_amount) || 0;
  const vehiclePrice = vehicleInfo?.vehicle_price != null
    ? parseFloat(vehicleInfo.vehicle_price)
    : (vehicleInfo?.vehicle_price_max != null ? parseFloat(vehicleInfo.vehicle_price_max) : null);
  const vehiclePriceTier = vehicleInfo?.vehicle_price_tier || null;
  const brand = vehicleInfo?.brand || null;
  const orderTier = order.order_tier ?? getOrderTier(M_order, rules);

  // 复杂度：优先用订单已有值，否则从 repair_complexity_levels 匹配维修项目，未匹配时默认 L2；配件数>3 时升级 1 级
  let L = (order.complexity_level || '').toUpperCase();
  if (!L || !['L1', 'L2', 'L3', 'L4'].includes(L)) {
    const complexityService = require('./services/complexity-service');
    const { level } = await complexityService.resolveComplexityFromItems(pool, quoteItems);
    L = level;
  }
  L = applyComplexityUpgrade(L, quoteItems);
  const isInsuranceAccident = !!(order.is_insurance_accident);
  const vehicleCoeff = getVehicleCoeff(vehiclePrice, rules, vehiclePriceTier, brand);

  const baseFixed = isInsuranceAccident
    ? (rules.baseRewardInsurance?.[L] ?? BASE_REWARD_INSURANCE[L] ?? BASE_REWARD_INSURANCE.L2)
    : (rules.baseReward?.[L] ?? BASE_REWARD[L] ?? BASE_REWARD.L2);
  const baseReward = baseFixed * vehicleCoeff;

  const capBase = isInsuranceAccident ? INSURANCE_ACCIDENT_CAP : (ORDER_CAP[L] ?? ORDER_CAP.L2);
  const capFromRules = rules.orderCap?.[L] ?? rules[`orderCap${L}`];
  let capByComplexity = capFromRules ?? capBase;
  const lowMax = rules.vehicleTierLowMax ?? 100000;
  const isLowEndVehicle = vehiclePrice != null && vehiclePrice <= lowMax;
  const lowCapUp = rules.vehicleTierLowCapUp ?? 20;
  const lowEndCapBoost = rules.lowEndCapBoost ?? (1 + lowCapUp / 100);
  if (isLowEndVehicle) capByComplexity *= lowEndCapBoost;

  const capByOrderTier = rules[`orderTier${orderTier}Cap`] ?? ORDER_TIER_CAP[orderTier] ?? ORDER_TIER_CAP[2];

  const repairCategory = resolveRepairCommissionCategory(quoteItems);
  const commissionRate = calcRepairCommissionRate(rules, { isInsuranceAccident, repairCategory });
  const commission = M_order * commissionRate;
  const maxByCommission = commission * ((rules.complianceRedLine ?? 70) / 100);

  // 双重约束：min(按订单分级封顶, 按复杂度封顶, 实收佣金×70%)
  const effectiveCap = Math.min(capByComplexity, capByOrderTier);
  let rewardPre = Math.min(baseReward, effectiveCap, maxByCommission);
  rewardPre = Math.max(0, Math.round(rewardPre * 100) / 100);

  const tierFromPrice =
    vehiclePrice != null
      ? vehiclePrice <= (rules.vehicleTierLowMax ?? 100000)
        ? 'low'
        : vehiclePrice <= (rules.vehicleTierMediumMax ?? 300000)
          ? 'mid'
          : 'high'
      : null;

  return {
    reward_pre: rewardPre,
    reward_base: rewardPre,
    order_tier: orderTier,
    complexity_level: L,
    vehicle_coeff: vehicleCoeff,
    vehicle_price_tier: tierFromPrice != null ? tierFromPrice : vehiclePriceTier || 'mid',
    commission_rate: commissionRate,
    commission_amount: Math.round(commission * 100) / 100,
    stages: getReleaseStages(orderTier, rewardPre),
  };
}

/**
 * 从订单行解析用于奖励计算的维修明细与有效报价金额（与 recalculateOrderRewardPreview 一致）
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ repair_plan?: unknown, quote_id?: string|null, quoted_amount?: unknown }} orderRow
 */
async function resolveRepairItemsAndQuotedAmount(pool, orderRow) {
  let quoteItems = [];
  let quotedForCalc = parseFloat(orderRow.quoted_amount) || 0;
  if (orderRow.repair_plan) {
    try {
      const plan =
        typeof orderRow.repair_plan === 'string' ? JSON.parse(orderRow.repair_plan) : orderRow.repair_plan;
      if (plan && Array.isArray(plan.items) && plan.items.length > 0) {
        quoteItems = plan.items;
      }
      const pa = plan && parseFloat(plan.amount);
      if (!Number.isNaN(pa) && pa > 0) quotedForCalc = pa;
    } catch (_) {}
  }
  if (quoteItems.length === 0 && orderRow.quote_id) {
    quoteItems = await loadQuoteItemsByQuoteId(pool, orderRow.quote_id);
  }
  return { quoteItems, quotedForCalc };
}

/**
 * 按当前订单的 repair_plan（或回退 quote.items）与金额重算复杂度、奖励金预览、佣金率并写回 orders
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} orderId
 */
async function recalculateOrderRewardPreview(pool, orderId) {
  if (!orderId) return { ok: false };
  try {
    const [rows] = await pool.execute(
      `SELECT o.order_id, o.bidding_id, o.quote_id, o.quoted_amount, o.actual_amount, o.repair_plan, o.is_insurance_accident
       FROM orders o WHERE o.order_id = ?`,
      [orderId]
    );
    if (!rows.length) return { ok: false };

    const o = rows[0];
    let vehicleInfo = {};
    if (o.bidding_id) {
      const [bid] = await pool.execute('SELECT vehicle_info FROM biddings WHERE bidding_id = ? LIMIT 1', [o.bidding_id]);
      if (bid.length && bid[0].vehicle_info) {
        try {
          vehicleInfo =
            typeof bid[0].vehicle_info === 'string' ? JSON.parse(bid[0].vehicle_info) : bid[0].vehicle_info || {};
        } catch (_) {
          vehicleInfo = {};
        }
      }
    }

    const { quoteItems, quotedForCalc } = await resolveRepairItemsAndQuotedAmount(pool, o);

    const orderForCalc = {
      quoted_amount: quotedForCalc,
      actual_amount: o.actual_amount,
      complexity_level: null,
      order_tier: null,
      is_insurance_accident: o.is_insurance_accident === 1 || o.is_insurance_accident === '1',
    };

    const result = await calculateReward(pool, orderForCalc, vehicleInfo, quoteItems, {});
    await pool.execute(
      `UPDATE orders SET order_tier = ?, complexity_level = ?, vehicle_price_tier = ?,
       reward_preview = ?, commission_rate = ? WHERE order_id = ?`,
      [
        result.order_tier,
        result.complexity_level,
        result.vehicle_price_tier,
        result.reward_pre,
        result.commission_rate * 100,
        orderId,
      ]
    );
    return { ok: true, result };
  } catch (e) {
    console.error('[reward-calculator] recalculateOrderRewardPreview', orderId, e && e.message);
    return { ok: false, error: e.message };
  }
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
 * 发放规则：主评价全额发放，追评整体评估后若升级则差额补发（不再分阶段）
 */
function getReleaseStages(orderTier, totalReward) {
  return [{ stage: 'main', percent: 100, amount: totalReward.toFixed(2) }];
}

module.exports = {
  getRewardRules,
  getVehicleCoeff,
  applyComplexityUpgrade,
  getOrderTier,
  calcRepairCommissionRate,
  mergeCommissionRepair,
  computeOrderCommissionAmount,
  loadQuoteItemsByQuoteId,
  calculateReward,
  resolveRepairItemsAndQuotedAmount,
  recalculateOrderRewardPreview,
  calcPremiumFloatReward,
  getReleaseStages,
  BASE_REWARD,
  BASE_REWARD_INSURANCE,
  ORDER_CAP,
  ORDER_TIER_CAP,
  PREMIUM_FLOAT_RATIO,
};
