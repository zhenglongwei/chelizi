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
  // L1 评价不计入店铺得分（评价为核心定位优化）
  if (level === 'L1') return 0;
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
    const hasContentQuality = await hasColumn(pool, 'reviews', 'content_quality');
    const q3Col = hasQ3Excluded ? 'r.q3_weight_excluded,' : '';
    const contentQualityCol = hasContentQuality ? 'r.content_quality,' : '';
    const [rows] = await pool.execute(
      `SELECT r.review_id, r.user_id, r.rating, r.created_at, r.weight, ${contentQualityCol} r.content_quality_level,
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
      const { bonus, majorViolationCount } = await calcHardBonus(pool, shopId);
      const score = majorViolationCount >= 2 ? 0 : Math.max(0, bonus);
      return { score, baseScore: 0, bonus, count: 0, majorViolationCount };
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
        const contentQuality = (r.content_quality_level >= 2 || (hasContentQuality && (r.content_quality === 'premium' || r.content_quality === '维权参考' || r.content_quality === '标杆' || r.content_quality === '爆款'))) ? 'premium' : 'valid';
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
    const { bonus, majorViolationCount } = await calcHardBonus(pool, shopId);
    const score = majorViolationCount >= 2 ? 0 : Math.max(0, Math.min(100, Math.round((baseScore + bonus) * 10) / 10));
    return { score, baseScore, bonus, count: rows.length, majorViolationCount };
  } catch (err) {
    console.error('[shop-score] computeShopScore error:', err.message);
    return { score: 0, baseScore: 0, bonus: 0, count: 0, majorViolationCount: 0 };
  }
}

/**
 * 持证技师加分（05 文档）：高级技师/技师 +8，中级工/初级工/高级工 +3，最高 +20
 */
function calcTechnicianBonus(technicianCerts) {
  if (!technicianCerts) return 0;
  let arr;
  try {
    arr = typeof technicianCerts === 'string' ? JSON.parse(technicianCerts || '[]') : technicianCerts;
  } catch {
    return 0;
  }
  if (!Array.isArray(arr)) return 0;
  const HIGH_LEVEL = ['高级技师', '技师'];
  const MID_LEVEL = ['中级工', '初级工', '高级工'];
  let pts = 0;
  for (const t of arr) {
    const level = (t.level || '').toString().trim();
    if (HIGH_LEVEL.some((l) => level.includes(l))) pts += 8;
    else if (MID_LEVEL.some((l) => level.includes(l))) pts += 3;
  }
  return Math.min(20, pts);
}

/**
 * 品牌授权加分（05 文档）：主机厂 4S +15，配件品牌 +5，可叠加，最高 +20
 */
function calcCertificationBonus(certifications) {
  if (!certifications) return 0;
  let arr;
  try {
    arr = typeof certifications === 'string' ? JSON.parse(certifications || '[]') : certifications;
  } catch {
    return 0;
  }
  if (!Array.isArray(arr)) return 0;
  let hasOem = false;
  let hasParts = false;
  for (const c of arr) {
    const type = (c.type || '').toString();
    const name = (c.name || '').toString();
    if (type === 'oem_4s' || name.includes('4S') || name.includes('主机厂') || name.includes('品牌授权')) hasOem = true;
    if (type === 'parts_brand' || name.includes('配件品牌')) hasParts = true;
  }
  return (hasOem ? 15 : 0) + (hasParts ? 5 : 0);
}

function getQuarterStart() {
  const d = new Date();
  const q = Math.floor(d.getMonth() / 3) + 1;
  const year = d.getFullYear();
  const month = (q - 1) * 3;
  return new Date(year, month, 1);
}

/**
 * 维修时效履约率（05 文档）：本季度完成订单中，实际工期 ≤ 承诺工期的占比
 * 100% +5，<70% -20
 */
async function calcTimelinessRate(pool, shopId) {
  try {
    const quarterStart = getQuarterStart();
    const [rows] = await pool.execute(
      `SELECT o.order_id, o.accepted_at, o.completed_at, o.repair_plan
       FROM orders o
       WHERE o.shop_id = ? AND o.status = 3 AND o.completed_at >= ?`,
      [shopId, quarterStart]
    );
    if (!rows || rows.length === 0) return null;
    let onTime = 0;
    let evaluated = 0;
    for (const r of rows) {
      const accepted = r.accepted_at ? new Date(r.accepted_at) : null;
      const completed = r.completed_at ? new Date(r.completed_at) : null;
      if (!accepted || !completed) continue;
      evaluated++;
      let durationDays = 3;
      try {
        const rp = typeof r.repair_plan === 'string' ? JSON.parse(r.repair_plan || '{}') : (r.repair_plan || {});
        durationDays = parseInt(rp.duration, 10) || 3;
      } catch (_) {}
      const promisedEnd = new Date(accepted);
      promisedEnd.setDate(promisedEnd.getDate() + durationDays);
      if (completed <= new Date(promisedEnd.getTime() + 86400000)) onTime++;
    }
    return evaluated > 0 ? Math.round((onTime / evaluated) * 10000) / 100 : null;
  } catch {
    return null;
  }
}

/**
 * 配件合规匹配率（05 文档，备案制）：本季度完成订单中，无配件不合规记录的占比
 * 100% +10，1 次不合规 -20
 */
async function calcPartsComplianceBonus(pool, shopId) {
  try {
    const quarterStart = getQuarterStart();
    const [completed] = await pool.execute(
      `SELECT COUNT(*) as cnt FROM orders WHERE shop_id = ? AND status = 3 AND completed_at >= ?`,
      [shopId, quarterStart]
    );
    const total = parseInt(completed[0]?.cnt || 0, 10);
    if (total === 0) return null;

    const [violated] = await pool.execute(
      `SELECT COUNT(DISTINCT sv.order_id) as cnt
       FROM shop_violations sv
       INNER JOIN orders o ON sv.order_id = o.order_id AND o.shop_id = ? AND o.status = 3 AND o.completed_at >= ?
       WHERE sv.violation_type = 'parts_non_compliant'`,
      [shopId, quarterStart]
    );
    const violationCount = parseInt(violated[0]?.cnt || 0, 10);
    if (violationCount >= 1) return -20;
    return 10;
  } catch {
    return null;
  }
}

/**
 * 统计重大违规次数（penalty=50，05 文档：服务商不一致等）
 */
async function countMajorViolations(pool, shopId) {
  try {
    const [rows] = await pool.execute(
      `SELECT COUNT(*) as cnt FROM shop_violations WHERE shop_id = ? AND penalty = 50`,
      [shopId]
    );
    return parseInt(rows[0]?.cnt || 0, 10);
  } catch {
    return 0;
  }
}

/**
 * 硬指标加减分（05 文档三、全指标 3.3）
 * @returns {{ bonus: number, majorViolationCount: number }}
 */
async function calcHardBonus(pool, shopId) {
  try {
    const [rows] = await pool.execute(
      `SELECT qualification_level, technician_certs, compliance_rate, deviation_rate, certifications
       FROM shops WHERE shop_id = ?`,
      [shopId]
    );
    if (rows.length === 0) return { bonus: 0, majorViolationCount: 0 };
    const s = rows[0];
    let bonus = 0;

    const majorCount = await countMajorViolations(pool, shopId);
    if (majorCount >= 2) {
      return { bonus: 0, majorViolationCount: majorCount };
    }
    if (majorCount === 1) bonus -= 50;

    const ql = (s.qualification_level || '').toString();
    if (ql.includes('一类')) bonus += 10;
    else if (ql.includes('二类')) bonus += 5;

    bonus += calcTechnicianBonus(s.technician_certs);
    bonus += calcCertificationBonus(s.certifications);

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

    const timeliness = await calcTimelinessRate(pool, shopId);
    if (timeliness != null) {
      if (timeliness >= 100) bonus += 5;
      else if (timeliness < 70) bonus -= 20;
    }

    const partsBonus = await calcPartsComplianceBonus(pool, shopId);
    if (partsBonus != null) bonus += partsBonus;

    return { bonus, majorViolationCount: majorCount };
  } catch {
    return { bonus: 0, majorViolationCount: 0 };
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
    const { score, majorViolationCount } = await computeShopScore(pool, shopId);
    const rating5 = Math.min(5, Math.max(0, score / 20));
    const updates = majorViolationCount >= 2
      ? 'shop_score = 0, rating = 0, status = 0, updated_at = NOW()'
      : 'shop_score = ?, rating = ?, updated_at = NOW()';
    const params = majorViolationCount >= 2 ? [shopId] : [score, rating5, shopId];
    await pool.execute(`UPDATE shops SET ${updates} WHERE shop_id = ?`, params);
    return score;
  } catch (err) {
    console.error('[shop-score] updateShopScoreAfterReview error:', err.message);
    throw err;
  }
}

/**
 * 重新计算并更新店铺得分（用于违规记录后、非评价触发场景）
 */
async function recomputeAndUpdateShopScore(pool, shopId) {
  try {
    const { score, majorViolationCount } = await computeShopScore(pool, shopId);
    const rating5 = Math.min(5, Math.max(0, score / 20));
    const updates = majorViolationCount >= 2
      ? 'shop_score = 0, rating = 0, status = 0, updated_at = NOW()'
      : 'shop_score = ?, rating = ?, updated_at = NOW()';
    const params = majorViolationCount >= 2 ? [shopId] : [score, rating5, shopId];
    await pool.execute(`UPDATE shops SET ${updates} WHERE shop_id = ?`, params);
    return score;
  } catch (err) {
    console.error('[shop-score] recomputeAndUpdateShopScore error:', err.message);
    throw err;
  }
}

module.exports = {
  getTimeDecay,
  calcReviewWeight,
  computeShopScore,
  calcHardBonus,
  updateShopScoreAfterReview,
  recomputeAndUpdateShopScore,
  countMajorViolations,
  ORDER_WEIGHT,
};
