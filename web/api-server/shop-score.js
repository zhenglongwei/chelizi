/**
 * 店铺综合得分服务
 * 按《全指标底层逻辑梳理》第二、三章实现
 * 单条评价权重、时间衰减、店铺加权得分、硬指标加减分
 */

const antifraud = require('./antifraud');

async function hasColumn(pool, table, col) {
  try {
    const [rows] = await pool.execute(
      `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, col]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

// 订单含金量权重 L1:0.2 L2:1.0 L3:3.0 L4:6.0，保险事故车×2
const ORDER_WEIGHT = { L1: 0.2, L2: 1.0, L3: 3.0, L4: 6.0 };

/**
 * 时间衰减系数（全指标 3.2）
 * 近3月 1.0，3-6月 0.5，6-12月 0.2，12月以上 0
 */
function getTimeDecay(createdAt) {
  const now = new Date();
  const created = new Date(createdAt);
  const monthsAgo = (now - created) / (30 * 24 * 60 * 60 * 1000);
  if (monthsAgo < 3) return 1.0;
  if (monthsAgo < 6) return 0.5;
  if (monthsAgo < 12) return 0.2;
  return 0;
}

/**
 * 计算单条评价总权重（全指标 2.3）
 * 权重 = 订单含金量 × 评价内容质量 × 用户账号可信度 × 合规特殊系数
 * @param {object} params - { complexityLevel, isInsuranceAccident, contentQuality, isNegative, userTrustWeight, complianceCoeff }
 */
function calcReviewWeight(params) {
  const level = (params.complexityLevel || 'L2').toUpperCase();
  let orderWeight = ORDER_WEIGHT[level] ?? 1.0;
  if (params.isInsuranceAccident) orderWeight *= 2;

  let contentWeight = params.contentQuality === 'premium' ? 3.0 : 1.0;
  if (params.isNegative) {
    contentWeight *= (level === 'L1' || level === 'L2') ? 1.5 : 2.0;
  }

  const trustWeight = params.userTrustWeight ?? 1.0;
  const complianceCoeff = params.complianceCoeff ?? 1.0;
  return orderWeight * contentWeight * trustWeight * complianceCoeff;
}

/**
 * 计算店铺综合得分（全指标 3.1 + 3.3 硬指标加减分）
 * @param {object} pool - 数据库连接池
 * @param {string} shopId - 店铺ID
 * @returns {Promise<{ score: number, baseScore: number, bonus: number, count: number }>}
 */
async function computeShopScore(pool, shopId) {
  try {
    const hasQ3Excluded = await hasColumn(pool, 'reviews', 'q3_weight_excluded');
    const q3Col = hasQ3Excluded ? 'r.q3_weight_excluded,' : '';
    const [rows] = await pool.execute(
      `SELECT r.review_id, r.user_id, r.rating, r.created_at, r.weight, r.content_quality, r.content_quality_level,
              ${q3Col}
              o.complexity_level, o.is_insurance_accident,
              s.compliance_rate
       FROM reviews r
       JOIN orders o ON r.order_id = o.order_id
       JOIN shops s ON r.shop_id = s.shop_id
       WHERE r.shop_id = ? AND r.type = 1 AND r.status = 1`,
      [shopId]
    );
    if (rows.length === 0) {
      const bonus = await calcHardBonus(pool, shopId);
      return { score: Math.max(0, bonus), baseScore: 0, bonus, count: 0 };
    }

    const [shopRows] = await pool.execute(
      'SELECT qualification_level, technician_certs, compliance_rate, deviation_rate, certifications FROM shops WHERE shop_id = ?',
      [shopId]
    );
    const shop = shopRows[0] || {};
    const complianceRate = shop.compliance_rate != null ? parseFloat(shop.compliance_rate) : null;

    let sumWeightedRating = 0;
    let sumWeight = 0;

    for (const r of rows) {
      // q3_weight_excluded=1：商户申诉有效，该评价不计入店铺得分（02/05 文档）
      if (hasQ3Excluded && r.q3_weight_excluded === 1) continue;

      const decay = getTimeDecay(r.created_at);
      if (decay <= 0) continue;

      let weight;
      if (r.weight != null && r.weight > 0) {
        weight = parseFloat(r.weight) * decay;
      } else {
        const trust = await antifraud.getUserTrustLevel(pool, r.user_id);
        const isNegative = (parseFloat(r.rating) || 5) <= 2;
        const contentQuality = (r.content_quality_level >= 2 || r.content_quality === 'premium' || r.content_quality === '维权参考' || r.content_quality === '标杆' || r.content_quality === '爆款') ? 'premium' : 'valid';
        weight = calcReviewWeight({
          complexityLevel: r.complexity_level,
          isInsuranceAccident: !!r.is_insurance_accident,
          contentQuality,
          isNegative,
          userTrustWeight: trust.weight,
          complianceCoeff: complianceRate >= 95 ? 1.2 : 1.0,
        }) * decay;
      }

      const rating = parseFloat(r.rating) || 5;
      sumWeightedRating += rating * weight;
      sumWeight += weight;
    }

    const baseScore = sumWeight > 0 ? (sumWeightedRating / sumWeight) * 20 : 0;
    const bonus = await calcHardBonus(pool, shopId);
    const score = Math.max(0, Math.min(100, Math.round((baseScore + bonus) * 10) / 10));
    return { score, baseScore, bonus, count: rows.length };
  } catch (err) {
    console.error('[shop-score] computeShopScore error:', err.message);
    return { score: 0, baseScore: 0, bonus: 0, count: 0 };
  }
}

/**
 * 硬指标加减分（全指标 3.3，简化版）
 */
async function calcHardBonus(pool, shopId) {
  try {
    const [rows] = await pool.execute(
      `SELECT qualification_level, technician_certs, compliance_rate, deviation_rate, certifications
       FROM shops WHERE shop_id = ?`,
      [shopId]
    );
    if (rows.length === 0) return 0;
    const s = rows[0];
    let bonus = 0;

    const ql = (s.qualification_level || '').toString();
    if (ql.includes('一类')) bonus += 10;
    else if (ql.includes('二类')) bonus += 5;

    const compliance = s.compliance_rate != null ? parseFloat(s.compliance_rate) : null;
    if (compliance != null) {
      if (compliance >= 95) bonus += 10;
      else if (compliance < 80) bonus -= 20;
    }

    const deviation = s.deviation_rate != null ? parseFloat(s.deviation_rate) : null;
    if (deviation != null) {
      if (deviation <= 10) bonus += 5;
      else if (deviation > 30) bonus -= 20;
    }

    return bonus;
  } catch {
    return 0;
  }
}

/**
 * 评价通过后更新店铺得分，并写入 reviews.weight、content_quality
 * @param {object} pool - 数据库连接池
 * @param {string} shopId - 店铺ID
 * @param {string} reviewId - 评价ID（可选，用于更新单条 weight）
 */
async function updateShopScoreAfterReview(pool, shopId, reviewId) {
  try {
    const { score } = await computeShopScore(pool, shopId);
    const rating5 = Math.min(5, Math.max(0, score / 20));
    await pool.execute(
      'UPDATE shops SET shop_score = ?, rating = ?, updated_at = NOW() WHERE shop_id = ?',
      [score, rating5, shopId]
    );
    return score;
  } catch (err) {
    console.error('[shop-score] updateShopScoreAfterReview error:', err.message);
    throw err;
  }
}

module.exports = {
  getTimeDecay,
  calcReviewWeight,
  computeShopScore,
  calcHardBonus,
  updateShopScoreAfterReview,
  ORDER_WEIGHT,
};
