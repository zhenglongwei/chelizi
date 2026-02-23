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
  const weights = SCENE_WEIGHTS[scene] || SCENE_WEIGHTS.L1L2;

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
 * 对店铺列表按综合排序分排序
 * @param {object} pool - 数据库连接池
 * @param {Array} shops - 店铺列表（含 distance 等）
 * @param {object} opts - { maxKm, scene, userLat, userLng }
 */
async function sortShopsByScore(pool, shops, opts = {}) {
  if (!shops || shops.length === 0) return shops;

  const maxKm = opts.maxKm ?? 50;
  const scene = opts.scene || 'L1L2';

  const scored = [];
  for (const s of shops) {
    const distanceKm = s.distance != null ? parseFloat(s.distance) : null;
    const score = calcSortScore(s, {
      distanceKm,
      maxKm,
      scene,
      avgResponseMinutes: s.avg_response_minutes,
    });
    scored.push({ ...s, _sort_score: score });
  }

  scored.sort((a, b) => (b._sort_score || 0) - (a._sort_score || 0));
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
  calcDistanceScore,
  calcPriceReasonablenessScore,
  calcResponseScore,
  calcSortScore,
  sortShopsByScore,
  ensureShopScores,
};
