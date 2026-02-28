/**
 * 内容转化追加奖金 - 决策权重计算与分配
 * 按《04-点赞追加奖金体系》3.2 实现
 * 7 天窗口内点赞 → 用户成交 → 按四维决策权重分配奖金池（佣金 50%）
 */

const rewardCalculator = require('../reward-calculator');

// 决策时间权重：点赞时间与订单创建时间间隔
function getDecisionTimeWeight(likeAt, orderCreatedAt) {
  const diffMs = new Date(orderCreatedAt) - new Date(likeAt);
  const diffHours = diffMs / (1000 * 60 * 60);
  if (diffHours <= 24) return 4.0;
  if (diffHours <= 72) return 2.0;
  if (diffHours <= 168) return 1.0; // 7 天
  return 0;
}

// 内容停留权重：有效阅读时长（秒）
function getContentStayWeight(totalSeconds) {
  if (totalSeconds >= 180) return 3.0;
  if (totalSeconds >= 60) return 2.0;
  if (totalSeconds >= 30) return 1.0;
  return 0;
}

// 内容匹配权重（简化）：车牌一致 3.0，同品牌 2.0，其他 1.0
function getContentMatchWeight(orderPlate, reviewOrderPlate, orderBrand, reviewBrand) {
  const op = (orderPlate || '').trim().toUpperCase();
  const rp = (reviewOrderPlate || '').trim().toUpperCase();
  const ob = (orderBrand || '').trim();
  const rb = (reviewBrand || '').trim();
  if (op && rp && op === rp) return 3.0;
  if (ob && rb && ob === rb) return 2.0;
  return 1.0;
}

// 内容价值权重：content_quality_level 1-4
function getContentValueWeight(level) {
  const L = parseInt(level, 10);
  if (L >= 4) return 3.0;
  if (L >= 3) return 2.0;
  if (L >= 2) return 1.0;
  if (L >= 1) return 0.5;
  return 0;
}

/**
 * 计算单条点赞的决策权重（四维相乘）
 */
function calcDecisionWeight({ likeAt, orderCreatedAt, readingSeconds, orderPlate, reviewOrderPlate, orderBrand, reviewBrand, contentQualityLevel }) {
  const t = getDecisionTimeWeight(likeAt, orderCreatedAt);
  const s = getContentStayWeight(readingSeconds || 0);
  const m = getContentMatchWeight(orderPlate, reviewOrderPlate, orderBrand, reviewBrand);
  const v = getContentValueWeight(contentQualityLevel);
  return t * s * m * v;
}

/** 返回权重及四维明细，供审计日志 */
function calcDecisionWeightWithBreakdown(params) {
  const t = getDecisionTimeWeight(params.likeAt, params.orderCreatedAt);
  const s = getContentStayWeight(params.readingSeconds || 0);
  const m = getContentMatchWeight(params.orderPlate, params.reviewOrderPlate, params.orderBrand, params.reviewBrand);
  const v = getContentValueWeight(params.contentQualityLevel);
  return { weight: t * s * m * v, breakdown: { decision_time: t, content_stay: s, content_match: m, content_value: v } };
}

/**
 * 为指定月份已完成订单计算内容转化奖金，写入 reward_settlement_pending
 * @param {object} pool
 * @param {string} startDate - 月份开始 YYYY-MM-DD HH:mm:ss
 * @param {string} endDate - 月份结束
 * @returns {{ count, amount, errors }}
 */
async function computeAndInsertConversionPending(pool, startDate, endDate) {
  const monthStr = startDate.slice(0, 7);
  const errors = [];
  let count = 0;
  let amount = 0;

  const [orders] = await pool.execute(
    `SELECT o.order_id, o.user_id, o.bidding_id, o.quote_id, o.created_at, o.completed_at, o.actual_amount, o.quoted_amount
     FROM orders o
     WHERE o.status = 3 AND o.completed_at >= ? AND o.completed_at <= ?
       AND o.user_id IS NOT NULL`,
    [startDate, endDate]
  );

  for (const order of orders) {
    try {
      const commission = await getOrderCommission(pool, order);
      if (commission <= 0) continue;
      const poolAmount = commission * 0.5;

      const orderCreated = new Date(order.created_at);
      const sevenDaysBefore = new Date(orderCreated);
      sevenDaysBefore.setDate(sevenDaysBefore.getDate() - 7);

      const [existingConv] = await pool.execute(
        `SELECT 1 FROM reward_settlement_pending WHERE order_id = ? AND pending_type = 'conversion_bonus' LIMIT 1`,
        [order.order_id]
      );
      if (existingConv.length > 0) continue;

      const [orderBid] = await pool.execute('SELECT vehicle_info FROM biddings WHERE bidding_id = ?', [order.bidding_id]);
      const orderVi = orderBid[0]?.vehicle_info ? (typeof orderBid[0].vehicle_info === 'string' ? JSON.parse(orderBid[0].vehicle_info) : orderBid[0].vehicle_info) : {};
      const orderPlate = orderVi.plate_number || orderVi.plateNumber || '';
      const orderBrand = orderVi.brand || '';

      const [likes] = await pool.execute(
        `SELECT rl.review_id, rl.created_at as like_at,
                r.user_id as author_id, r.order_id as review_order_id, r.content_quality_level
         FROM review_likes rl
         JOIN reviews r ON rl.review_id = r.review_id AND r.type = 1 AND r.status = 1
         WHERE rl.user_id = ? AND rl.is_valid_for_bonus = 1
           AND rl.created_at >= ? AND rl.created_at < ?
           AND rl.like_type = 'normal'`,
        [order.user_id, sevenDaysBefore.toISOString().slice(0, 19).replace('T', ' '), order.created_at]
      );

      if (likes.length === 0) continue;

      const candidates = [];
      for (const like of likes) {
        const [readingRows] = await pool.execute(
          `SELECT COALESCE(SUM(effective_seconds), 0) as total FROM review_reading_sessions WHERE review_id = ? AND user_id = ?`,
          [like.review_id, order.user_id]
        );
        const readingSeconds = parseInt(readingRows[0]?.total || 0, 10);
        if (readingSeconds < 30) continue;

        const [revOrderBid] = await pool.execute(
          `SELECT b.vehicle_info FROM orders o JOIN biddings b ON o.bidding_id = b.bidding_id WHERE o.order_id = ?`,
          [like.review_order_id]
        );
        const revVi = revOrderBid[0]?.vehicle_info ? (typeof revOrderBid[0].vehicle_info === 'string' ? JSON.parse(revOrderBid[0].vehicle_info) : revOrderBid[0].vehicle_info) : {};
        const reviewPlate = revVi.plate_number || revVi.plateNumber || '';
        const reviewBrand = revVi.brand || '';

        const { weight, breakdown } = calcDecisionWeightWithBreakdown({
          likeAt: like.like_at,
          orderCreatedAt: order.created_at,
          readingSeconds,
          orderPlate,
          reviewOrderPlate: reviewPlate,
          orderBrand,
          reviewBrand,
          contentQualityLevel: like.content_quality_level
        });
        if (weight <= 0) continue;
        candidates.push({ ...like, weight, readingSeconds, breakdown });
      }

      if (candidates.length === 0) continue;

      candidates.sort((a, b) => b.weight - a.weight);
      const top10 = candidates.slice(0, 10);
      const totalWeight = top10.reduce((s, c) => s + c.weight, 0);
      if (totalWeight <= 0) continue;

      for (const c of top10) {
        const share = (c.weight / totalWeight) * poolAmount;
        const taxDeducted = share > 800 ? Math.round((share - 800) * 0.2 * 100) / 100 : 0;
        const afterTax = Math.round((share - taxDeducted) * 100) / 100;
        if (afterTax <= 0) continue;

        const [dup] = await pool.execute(
          `SELECT 1 FROM reward_settlement_pending WHERE order_id = ? AND review_id = ? AND pending_type = 'conversion_bonus' LIMIT 1`,
          [order.order_id, c.review_id]
        );
        if (dup.length > 0) continue;

        const calcReason = `内容转化（决策权重${c.weight.toFixed(2)}，占比${((c.weight / totalWeight) * 100).toFixed(1)}%）`;
        await pool.execute(
          `INSERT INTO reward_settlement_pending (user_id, review_id, order_id, pending_type, amount_before_tax, tax_deducted, amount_after_tax, calc_reason, trigger_month)
           VALUES (?, ?, ?, 'conversion_bonus', ?, ?, ?, ?, ?)`,
          [c.author_id, c.review_id, order.order_id, share, taxDeducted, afterTax, calcReason, monthStr]
        );
        try {
          const auditLogger = require('../reward-audit-logger');
          auditLogger.logConversionBonus({
            order_id: order.order_id,
            review_id: c.review_id,
            user_id: c.author_id,
            commission,
            pool_amount: poolAmount,
            decision_weight: c.weight,
            weight_share_pct: (c.weight / totalWeight) * 100,
            share_before_tax: share,
            tax_deducted: taxDeducted,
            share_after_tax: afterTax,
            weight_breakdown: c.breakdown,
          });
        } catch (_) {}
        count++;
        amount += afterTax;
      }
    } catch (e) {
      errors.push(`order ${order.order_id}: ${e.message}`);
    }
  }

  return { count, amount, errors };
}

async function getOrderCommission(pool, order) {
  const amt = parseFloat(order.actual_amount || order.quoted_amount) || 0;
  const rules = await rewardCalculator.getRewardRules(pool);
  const rate = rewardCalculator.calcCommissionRate(rules, amt, null, null, false);
  return amt * rate;
}

module.exports = {
  calcDecisionWeight,
  calcDecisionWeightWithBreakdown,
  getDecisionTimeWeight,
  getContentStayWeight,
  getContentMatchWeight,
  getContentValueWeight,
  computeAndInsertConversionPending,
};
