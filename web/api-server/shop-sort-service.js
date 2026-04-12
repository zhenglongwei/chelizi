/**
 * 服务商列表排序服务
 * 按《全指标底层逻辑梳理》第五章实现
 * 综合排序分 = 店铺综合得分 × 场景权重 + 距离反向分 + 报价合理性分 + 响应速度分
 */

const shopScore = require('./shop-score');

// 全指标 5.2 场景化权重 { 店铺得分, 距离, 报价合理性, 响应速度 }
const SCENE_WEIGHTS = {
  L1L2: { shop: 0.35, distance: 0.30, price: 0.25, response: 0.10 },
  L3L4: { shop: 0.60, distance: 0.05, price: 0.20, response: 0.15 },
  brand: { shop: 0.50, distance: 0.10, price: 0.20, response: 0.20 },
};

/** 有项目上下文的自费意图：提高报价合理性权重、略降距离权重（与 06 文档付款方维度一致） */
const SCENE_WEIGHTS_SELF_PAY = {
  L1L2: { shop: 0.33, distance: 0.22, price: 0.35, response: 0.10 },
  L3L4: { shop: 0.55, distance: 0.05, price: 0.28, response: 0.12 },
  brand: { shop: 0.45, distance: 0.08, price: 0.30, response: 0.17 },
};

function getSceneWeights(scene, payerIntent) {
  const s = scene === 'L3L4' ? 'L3L4' : scene === 'brand' ? 'brand' : 'L1L2';
  if (payerIntent === 'self_pay') {
    return SCENE_WEIGHTS_SELF_PAY[s] || SCENE_WEIGHTS_SELF_PAY.L1L2;
  }
  return SCENE_WEIGHTS[s] || SCENE_WEIGHTS.L1L2;
}

/**
 * 距离反向分（0-100）
 * 公式：(用户设定最大距离 - 门店实际距离) ÷ 用户设定最大距离 × 100
 * @param {number} distanceKm - 门店实际距离（km）
 * @param {number} maxKm - 用户设定最大距离（km）
 */
function calcDistanceScore(distanceKm, maxKm) {
  if (maxKm == null || maxKm <= 0) return 100;
  if (distanceKm == null || distanceKm < 0) return 0;
  if (distanceKm >= maxKm) return 0;
  return Math.round(((maxKm - distanceKm) / maxKm) * 1000) / 10;
}

/**
 * 报价合理性分（0-100）
 * 全指标 5.3：以平台同区域同项目公允价为基准，±10% 内满分，偏离线性扣分
 * 简化：用 deviation_rate（报价偏差率）近似，≤10% 满分，>30% 0 分
 */
function calcPriceReasonablenessScore(deviationRate) {
  const rate = parseFloat(deviationRate);
  if (rate == null || isNaN(rate)) return 100;
  if (rate <= 10) return 100;
  if (rate >= 30) return 0;
  return Math.round((1 - (rate - 10) / 20) * 1000) / 10;
}

/**
 * 响应速度分（0-100）
 * 全指标 5.3：近 30 天平均响应时长，5 分钟内响应满分
 * 无数据时返回默认 50 分
 */
function calcResponseScore(avgResponseMinutes) {
  if (avgResponseMinutes == null) return 50;
  const m = parseFloat(avgResponseMinutes);
  if (m <= 5) return 100;
  if (m >= 60) return 0;
  return Math.round((1 - (m - 5) / 55) * 1000) / 10;
}

/**
 * 店铺综合得分转 0-100 分（shops.shop_score 已是 100 分制，rating 为 5 星制×20）
 */
function normalizeShopScore(shopScoreVal, rating) {
  if (shopScoreVal != null && !isNaN(parseFloat(shopScoreVal))) {
    return Math.min(100, Math.max(0, parseFloat(shopScoreVal)));
  }
  if (rating != null) return Math.min(100, (parseFloat(rating) || 0) * 20);
  return 50;
}

/**
 * 计算单店综合排序分
 * @param {object} shop - 店铺行 { shop_score, rating, deviation_rate, compliance_rate, qualification_level, created_at }
 * @param {object} opts - { distanceKm, maxKm, scene, avgResponseMinutes }
 */
function calcSortScore(shop, opts = {}) {
  const scene = opts.scene || 'L1L2';
  const weights = getSceneWeights(scene, opts.payerIntent);

  const shopScoreVal = normalizeShopScore(shop.shop_score, shop.rating);
  const distanceScore = opts.distanceKm != null && opts.maxKm != null
    ? calcDistanceScore(opts.distanceKm, opts.maxKm)
    : 100;
  const priceScore = calcPriceReasonablenessScore(shop.deviation_rate);
  const responseScore = calcResponseScore(opts.avgResponseMinutes);

  let score = shopScoreVal * weights.shop
    + distanceScore * weights.distance
    + priceScore * weights.price
    + responseScore * weights.response;

  // 全指标 5.4 特殊倾斜
  if (shop.compliance_rate != null && parseFloat(shop.compliance_rate) >= 95) {
    score *= 1.1;
  }
  const ql = (shop.qualification_level || '').toString();
  if (ql.includes('一类') || ql.includes('4S') || ql.includes('主机厂')) {
    score *= 1.05;
  }
  const created = shop.created_at ? new Date(shop.created_at) : null;
  if (created) {
    const daysSince = (Date.now() - created) / (24 * 60 * 60 * 1000);
    if (daysSince <= 30) score *= 1.05;
  }

  return Math.round(score * 100) / 100;
}

/**
 * 批量获取店铺近 30 天平均报价响应时长（分钟）
 * 06 文档：竞价创建 → 店铺首次报价提交
 * @returns {Promise<Map<string,number>>} shop_id -> avg_response_minutes
 */
async function getAvgResponseMinutesByShopIds(pool, shopIds) {
  if (!shopIds || shopIds.length === 0) return new Map();
  const placeholders = shopIds.map(() => '?').join(',');
  try {
    const [rows] = await pool.execute(
      `SELECT q.shop_id, AVG(TIMESTAMPDIFF(MINUTE, b.created_at, q.first_at)) AS avg_min
       FROM biddings b
       INNER JOIN (
         SELECT bidding_id, shop_id, MIN(created_at) AS first_at
         FROM quotes
         WHERE shop_id IN (${placeholders})
         GROUP BY bidding_id, shop_id
       ) q ON b.bidding_id = q.bidding_id
       WHERE b.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY q.shop_id`,
      [...shopIds]
    );
    const map = new Map();
    for (const r of rows || []) {
      if (r.shop_id && r.avg_min != null) map.set(r.shop_id, parseFloat(r.avg_min));
    }
    return map;
  } catch (err) {
    console.error('[shop-sort] getAvgResponseMinutesByShopIds error:', err?.message);
    return new Map();
  }
}

/**
 * 对店铺列表按综合排序分排序
 * @param {object} pool - 数据库连接池
 * @param {Array} shops - 店铺列表（含 distance 等）
 * @param {object} opts - { maxKm, scene, userLat, userLng }
 */
/**
 * 性价比分：店铺综合得分 + 报价合理性（偏差率），用于有产品上下文的自费比价
 */
function calcValueCompositeScore(shop) {
  const shopScoreVal = normalizeShopScore(shop.shop_score, shop.rating);
  const priceScore = calcPriceReasonablenessScore(shop.deviation_rate);
  return Math.round((shopScoreVal * 0.58 + priceScore * 0.42) * 100) / 100;
}

async function sortShopsByValue(pool, shops) {
  if (!shops || shops.length === 0) return shops;
  await ensureShopScores(pool, shops);
  const scored = shops.map((s) => ({
    ...s,
    _value_score: calcValueCompositeScore(s),
  }));
  scored.sort((a, b) => {
    const diff = (b._value_score || 0) - (a._value_score || 0);
    if (diff !== 0) return diff;
    const oa = a.total_orders || 0;
    const ob = b.total_orders || 0;
    return ob - oa;
  });
  return scored;
}

async function sortShopsByScore(pool, shops, opts = {}) {
  if (!shops || shops.length === 0) return shops;

  const maxKm = opts.maxKm ?? 50;
  const scene = opts.scene || 'L1L2';

  const shopIds = [...new Set(shops.map((s) => s.shop_id).filter(Boolean))];
  const responseMap = await getAvgResponseMinutesByShopIds(pool, shopIds);

  const scored = [];
  for (const s of shops) {
    const distanceKm = s.distance != null ? parseFloat(s.distance) : null;
    const score = calcSortScore(s, {
      distanceKm,
      maxKm,
      scene,
      payerIntent: opts.payerIntent,
      avgResponseMinutes: s.avg_response_minutes ?? responseMap.get(s.shop_id),
    });
    scored.push({ ...s, _sort_score: score });
  }

  scored.sort((a, b) => {
    const diff = (b._sort_score || 0) - (a._sort_score || 0);
    if (diff !== 0) return diff;
    // 06 文档：4S 店/品牌授权同分优先
    const prio = (s) => {
      const ql = (s.qualification_level || '').toString();
      if (ql.includes('一类') || ql.includes('4S') || ql.includes('主机厂')) return 2;
      if (ql.includes('二类')) return 1;
      let certs;
      try {
        certs = typeof s.certifications === 'string' ? JSON.parse(s.certifications || '[]') : s.certifications || [];
      } catch {
        return 0;
      }
      for (const c of certs) {
        if ((c.type || '').toString() === 'oem_4s' || (c.name || '').includes('4S')) return 2;
        if ((c.type || '').toString() === 'parts_brand') return 1;
      }
      return 0;
    };
    return prio(b) - prio(a);
  });
  return scored;
}

/**
 * 补齐店铺 shop_score（若为空则实时计算）
 */
async function ensureShopScores(pool, shops) {
  const needCompute = shops.filter((s) => s.shop_score == null || s.shop_score === '');
  for (const s of needCompute) {
    try {
      const { score } = await shopScore.computeShopScore(pool, s.shop_id);
      s.shop_score = score;
    } catch (_) {
      s.shop_score = s.rating != null ? parseFloat(s.rating) * 20 : 50;
    }
  }
  return shops;
}

module.exports = {
  SCENE_WEIGHTS,
  SCENE_WEIGHTS_SELF_PAY,
  getSceneWeights,
  calcDistanceScore,
  calcPriceReasonablenessScore,
  calcResponseScore,
  getAvgResponseMinutesByShopIds,
  calcSortScore,
  calcValueCompositeScore,
  sortShopsByValue,
  sortShopsByScore,
  ensureShopScores,
};
