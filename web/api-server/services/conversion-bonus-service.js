/**
 * 内容转化追加奖金 - 决策权重计算与分配
 * 按《04-点赞追加奖金体系》3.2 实现
 * 7 天窗口内点赞 → 用户成交 → 按四维决策权重分配奖金池（佣金比例见 reward_rules.platformIncentiveV1.conversionPoolShare，默认 10%，与事后验证共享）
 */

const rewardCalculator = require('../reward-calculator');
const antifraud = require('../antifraud');
// 内容转化权重的最低停留档位按“30秒-1分钟”为 1.0（与点赞有效赞门槛可不同）
const PLATFORM_DEFAULTS = require('../constants/platform-reward-v1');
const { allocateConversionPoolByTheta, pickTable } = require('../utils/conversion-pool-allocate');
const referralService = require('./referral-service');
const { preWithholdLaborRemunerationEachPayment } = require('../utils/labor-remuneration-withhold');

// 决策时间权重：点赞时间与订单创建时间间隔
function getDecisionTimeWeight(likeAt, orderCreatedAt) {
  const diffMs = new Date(orderCreatedAt) - new Date(likeAt);
  const diffHours = diffMs / (1000 * 60 * 60);
  if (diffHours <= 24) return 4.0;
  if (diffHours <= 72) return 2.0;
  if (diffHours <= 168) return 1.0; // 7 天
  return 0;
}

// 内容停留权重：有效阅读时长（秒）；最低非零档与有效赞门槛一致
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

// 内容价值权重：content_quality_level 1-4（平台化后可中性化为 1，与 AI 档脱钩）
function getContentValueWeight(level, neutralize) {
  if (neutralize) return 1.0;
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
function calcDecisionWeight({ likeAt, orderCreatedAt, readingSeconds, orderPlate, reviewOrderPlate, orderBrand, reviewBrand, contentQualityLevel, neutralizeContentQuality }) {
  const t = getDecisionTimeWeight(likeAt, orderCreatedAt);
  const s = getContentStayWeight(readingSeconds || 0);
  const m = getContentMatchWeight(orderPlate, reviewOrderPlate, orderBrand, reviewBrand);
  const v = getContentValueWeight(contentQualityLevel, neutralizeContentQuality);
  return t * s * m * v;
}

/** 返回权重及四维明细，供审计日志 */
function calcDecisionWeightWithBreakdown(params) {
  const t = getDecisionTimeWeight(params.likeAt, params.orderCreatedAt);
  const s = getContentStayWeight(params.readingSeconds || 0);
  const m = getContentMatchWeight(params.orderPlate, params.reviewOrderPlate, params.orderBrand, params.reviewBrand);
  const v = getContentValueWeight(params.contentQualityLevel, params.neutralizeContentQuality);
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

  let poolShare = 0.1;
  let neutralizeContentQuality = true;
  let pv1 = {};
  try {
    poolShare = await rewardCalculator.getConversionPoolShare(pool);
    const rules = await rewardCalculator.getRewardRules(pool);
    pv1 = rules.platformIncentiveV1 || {};
    neutralizeContentQuality = pv1.neutralizeContentQualityInConversionWeight !== false;
  } catch (_) {}
  const thetaCap = typeof pv1.thetaCap === 'number' ? pv1.thetaCap : 0.65;
  const phiTableEff =
    Array.isArray(pv1.phi) && pv1.phi.length >= 5 ? pv1.phi : PLATFORM_DEFAULTS.platformIncentiveV1.phi;
  const psiTableEff =
    Array.isArray(pv1.psi) && pv1.psi.length >= 5 ? pv1.psi : PLATFORM_DEFAULTS.platformIncentiveV1.psi;
  const preTaxOnly = pv1.compliancePreTaxOnly !== false;

  const [orders] = await pool.execute(
    `SELECT o.order_id, o.user_id, o.bidding_id, o.quote_id, o.created_at, o.completed_at, o.actual_amount, o.quoted_amount, o.is_insurance_accident
     FROM orders o
     WHERE o.status = 3 AND o.completed_at >= ? AND o.completed_at <= ?
       AND o.user_id IS NOT NULL`,
    [startDate, endDate]
  );

  for (const order of orders) {
    try {
      const commission = await getOrderCommission(pool, order);
      if (commission <= 0) continue;
      const distBuyer = await referralService.isDistributionBuyer(pool, order.user_id);
      const poolAmount = commission * poolShare;

      const buyerTrust = await antifraud.getUserTrustLevel(pool, order.user_id);
      const phi = pickTable(phiTableEff, buyerTrust.level);
      if (phi <= 0) continue;
      const pPrime = Math.round(poolAmount * phi * 100) / 100;
      if (pPrime <= 0) continue;

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
        `SELECT rl.review_id, rl.created_at as like_at, rl.weight_coefficient,
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
        if (readingSeconds < MIN_EFFECTIVE_READING_SECONDS_FOR_BONUS) continue;

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
          contentQualityLevel: like.content_quality_level,
          neutralizeContentQuality,
        });
        if (weight <= 0) continue;
        candidates.push({ ...like, weight, readingSeconds, breakdown });
      }

      if (candidates.length === 0) continue;

      /** 同一主评合并 S（决策权重和），保留权重最大的一条点赞作 like_bonus 扣减参照 */
      const byReview = new Map();
      for (const c of candidates) {
        const prev = byReview.get(c.review_id);
        if (!prev) {
          byReview.set(c.review_id, { weightSum: c.weight, best: c });
        } else {
          prev.weightSum += c.weight;
          if (c.weight > prev.best.weight) prev.best = c;
        }
      }
      const merged = [...byReview.values()]
        .map((v) => ({ ...v.best, weight: v.weightSum }))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 10);
      if (merged.length === 0) continue;

      const allocMap = allocateConversionPoolByTheta(
        pPrime,
        merged.map((m) => ({ key: m.review_id, S: m.weight })),
        thetaCap
      );

      for (const c of merged) {
        const authorTrust = await antifraud.getUserTrustLevel(pool, c.author_id);
        const psi = pickTable(psiTableEff, authorTrust.level);
        let allocBeforePsi = Math.round((allocMap[c.review_id] || 0) * 100) / 100;
        if (distBuyer) allocBeforePsi = Math.round(allocBeforePsi * 0.5 * 100) / 100;
        let share = Math.round(allocBeforePsi * psi * 100) / 100;
        const wConv = preTaxOnly ? { taxDeducted: 0, afterTax: share } : preWithholdLaborRemunerationEachPayment(share);
        const taxDeducted = wConv.taxDeducted;
        let afterTax = wConv.afterTax;

        // 扣除已通过常规点赞发放的金额（点赞先于订单产生、跨结算周期时可能已发过 like_bonus）。
        // 与「全站月度池」分配兼容：该评当月通常一条 like_bonus 总额 ×（本赞权重/当月该评权重和）作分摊扣减。
        const likeMonth = c.like_at ? String(c.like_at).slice(0, 7) : null;
        if (likeMonth) {
          const [likeBonusTxns] = await pool.execute(
            `SELECT amount FROM transactions WHERE related_id = ? AND type = 'like_bonus' AND settlement_month = ?`,
            [c.review_id, likeMonth]
          );
          if (likeBonusTxns.length > 0) {
            const [y, m] = likeMonth.split('-').map(Number);
            const lastDay = new Date(y, m, 0).getDate();
            const monthEnd = `${likeMonth}-${String(lastDay).padStart(2, '0')} 23:59:59`;
            const [weightRows] = await pool.execute(
              `SELECT COALESCE(SUM(weight_coefficient), 0) as total FROM review_likes
               WHERE review_id = ? AND is_valid_for_bonus = 1 AND like_type = 'normal'
                 AND created_at >= ? AND created_at <= ?`,
              [c.review_id, likeMonth + '-01 00:00:00', monthEnd]
            );
            const totalW = parseFloat(weightRows[0]?.total || 0);
            const thisW = parseFloat(c.weight_coefficient || 0);
            if (totalW > 0 && thisW > 0) {
              const likeBonusShare = parseFloat(likeBonusTxns[0].amount || 0) * (thisW / totalW);
              afterTax = Math.round(Math.max(0, afterTax - likeBonusShare) * 100) / 100;
            }
          }
        }
        if (afterTax <= 0) continue;

        const [dup] = await pool.execute(
          `SELECT 1 FROM reward_settlement_pending WHERE order_id = ? AND review_id = ? AND pending_type = 'conversion_bonus' LIMIT 1`,
          [order.order_id, c.review_id]
        );
        if (dup.length > 0) continue;

        const adjustedTax = preTaxOnly ? 0 : afterTax < share - taxDeducted ? 0 : taxDeducted;
        const adjustedShare = preTaxOnly ? afterTax : afterTax + adjustedTax;
        const likeMonthStr = c.like_at ? String(c.like_at).slice(0, 7) : '';
        const calcReason = `内容转化（名义份额${allocBeforePsi.toFixed(2)}×作者系数${psi}，决策权重和${c.weight.toFixed(2)}，Θ=${thetaCap}，买家φ=${phi}${likeMonthStr ? '，已扣常规点赞' : ''}）`;
        await pool.execute(
          `INSERT INTO reward_settlement_pending (user_id, review_id, order_id, pending_type, amount_before_tax, tax_deducted, amount_after_tax, calc_reason, trigger_month)
           VALUES (?, ?, ?, 'conversion_bonus', ?, ?, ?, ?, ?)`,
          [c.author_id, c.review_id, order.order_id, adjustedShare, adjustedTax, afterTax, calcReason, monthStr]
        );
        try {
          const auditLogger = require('../reward-audit-logger');
          auditLogger.logConversionBonus({
            order_id: order.order_id,
            review_id: c.review_id,
            user_id: c.author_id,
            settlement_month: monthStr,
            commission_C: commission,
            conversion_pool_share: poolShare,
            theta_cap: thetaCap,
            neutralize_content_quality: neutralizeContentQuality,
            commission,
            pool_amount: poolAmount,
            pool_prime: pPrime,
            phi_buyer: phi,
            psi_author: psi,
            decision_weight: c.weight,
            alloc_before_psi: allocBeforePsi,
            share_before_tax: share,
            tax_deducted: taxDeducted,
            share_after_tax: afterTax,
            weight_breakdown: c.breakdown,
            tracks: {
              base: { note: '首评 rebate 已在此前 review_submit 日志' },
              interaction: { settled: false, note: '转化 pending 与 like_bonus 月结顺序见结算任务' },
              conversion: {
                settled: false,
                stage: 'pending_insert',
                alloc_before_psi: allocBeforePsi,
                psi_author: psi,
                share_after_tax_pending: afterTax,
              },
            },
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
  return rewardCalculator.computeOrderCommissionAmount(pool, order);
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
