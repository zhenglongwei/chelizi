/**
 * 月度定期结算服务
 * 每月10日结算上月：评价升级差额、常规点赞追加
 * 详见《评价与点赞奖励-定期结算方案》
 */

const crypto = require('crypto');
const rewardCalculator = require('../reward-calculator');
const conversionBonusService = require('./conversion-bonus-service');
const orderRewardCap = require('./order-reward-cap-service');
const referralService = require('./referral-service');
const { preWithholdLaborRemunerationEachPayment } = require('../utils/labor-remuneration-withhold');

/**
 * 结算指定月份
 * @param {object} pool
 * @param {string} month - YYYY-MM
 * @returns {Promise<{ upgradeDiff, likeBonus, conversionBonus, postVerifyBonus, errors }>}
 */
async function settleMonth(pool, month) {
  const errors = [];
  let upgradeDiffCount = 0;
  let upgradeDiffAmount = 0;
  let likeBonusCount = 0;
  let likeBonusAmount = 0;
  let conversionBonusCount = 0;
  let conversionBonusAmount = 0;
  let postVerifyBonusCount = 0;
  let postVerifyBonusAmount = 0;
  let referralCommissionCount = 0;
  let referralCommissionAmount = 0;

  const [startDate, endDate] = getMonthRange(month);

  let rulesForUpgrade = null;
  try {
    rulesForUpgrade = await rewardCalculator.getRewardRules(pool);
  } catch (_) {
    rulesForUpgrade = {};
  }
  const upgradeEnabled = rulesForUpgrade?.platformIncentiveV1?.settleUpgradeDiffEnabled === true;

  try {
    if (upgradeEnabled) {
      const upgradeResult = await settleUpgradeDiff(pool, startDate, endDate);
      upgradeDiffCount = upgradeResult.count;
      upgradeDiffAmount = upgradeResult.amount;
      errors.push(...upgradeResult.errors);
    }
  } catch (e) {
    errors.push(`评价升级差额: ${e.message}`);
  }

  try {
    const likeResult = await settleLikeBonus(pool, startDate, endDate);
    likeBonusCount = likeResult.count;
    likeBonusAmount = likeResult.amount;
    errors.push(...likeResult.errors);
  } catch (e) {
    errors.push(`常规点赞追加: ${e.message}`);
  }

  try {
    const convInsert = await conversionBonusService.computeAndInsertConversionPending(pool, startDate, endDate);
    const convSettle = await settleConversionBonus(pool, startDate, endDate);
    conversionBonusCount = convSettle.count;
    conversionBonusAmount = convSettle.amount;
    errors.push(...convInsert.errors, ...convSettle.errors);
  } catch (e) {
    errors.push(`内容转化追加: ${e.message}`);
  }

  try {
    const pvResult = await settlePostVerifyBonus(pool, startDate, endDate);
    postVerifyBonusCount = pvResult.count;
    postVerifyBonusAmount = pvResult.amount;
    errors.push(...pvResult.errors);
  } catch (e) {
    errors.push(`事后验证补发: ${e.message}`);
  }

  try {
    const refResult = await settleReferralCommission(pool, startDate, endDate);
    referralCommissionCount = refResult.count;
    referralCommissionAmount = refResult.amount;
    errors.push(...refResult.errors);
  } catch (e) {
    errors.push(`推荐佣金: ${e.message}`);
  }

  await pool.execute(
    `INSERT INTO reward_settlement_logs (settlement_month, run_at, upgrade_diff_count, upgrade_diff_amount, like_bonus_count, like_bonus_amount, status, error_msg)
     VALUES (?, NOW(), ?, ?, ?, ?, ?, ?)`,
    [month, upgradeDiffCount, upgradeDiffAmount, likeBonusCount, likeBonusAmount, errors.length ? 'partial' : 'completed', errors.length ? errors.join('; ') : null]
  );

  return {
    upgradeDiff: { count: upgradeDiffCount, amount: upgradeDiffAmount },
    likeBonus: { count: likeBonusCount, amount: likeBonusAmount },
    conversionBonus: { count: conversionBonusCount, amount: conversionBonusAmount },
    postVerifyBonus: { count: postVerifyBonusCount, amount: postVerifyBonusAmount },
    referralCommission: { count: referralCommissionCount, amount: referralCommissionAmount },
    errors
  };
}

function getMonthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0, 23, 59, 59);
  return [start.toISOString().slice(0, 19).replace('T', ' '), end.toISOString().slice(0, 19).replace('T', ' ')];
}

/**
 * 处理评价升级差额：从 reward_settlement_pending 读取 trigger_month=结算月 的记录，发放
 */
async function settleUpgradeDiff(pool, startDate, endDate) {
  const triggerMonth = startDate.slice(0, 7);
  const [pendingRows] = await pool.execute(
    `SELECT id, user_id, review_id, order_id, amount_before_tax, tax_deducted, amount_after_tax, calc_reason
     FROM reward_settlement_pending
     WHERE pending_type = 'upgrade_diff' AND settled_at IS NULL AND trigger_month = ?`,
    [triggerMonth]
  );

  const errors = [];
  let count = 0;
  let amount = 0;

  for (const p of pendingRows) {
    try {
      const [ordRows] = await pool.execute(
        'SELECT o.order_id, o.quoted_amount, o.actual_amount, o.complexity_level, o.shop_id, o.quote_id, o.is_insurance_accident, o.repair_plan, o.bidding_id FROM orders o WHERE o.order_id = ?',
        [p.order_id]
      );
      const orderRow = ordRows[0];
      if (!orderRow) {
        errors.push(`pending ${p.id}: 订单 ${p.order_id} 不存在`);
        continue;
      }
      const capped = await orderRewardCap.clampPayoutToOrderHardCap(
        pool,
        p.order_id,
        orderRow,
        { afterTax: parseFloat(p.amount_after_tax), taxDeducted: parseFloat(p.tax_deducted || 0) },
        p.id,
        { review_id: p.review_id, payout_kind: 'upgrade_diff', pending_id: p.id }
      );
      const payAmt = capped.afterTax;
      const payTax = capped.taxDeducted;
      if (payAmt <= 0) {
        await pool.execute(
          `UPDATE reward_settlement_pending SET settled_at = NOW(), transaction_id = CONCAT('SKIP_', id) WHERE id = ?`,
          [p.id]
        );
        errors.push(`pending ${p.id}: 订单硬帽后金额为 0，已关闭`);
        continue;
      }
      const txnId = 'TXN' + Date.now() + '_' + p.id;
      await pool.execute(
        'UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?',
        [payAmt, payAmt, p.user_id]
      );
      const hasSrc = await orderRewardCap.hasRewardSourceOrderColumn(pool);
      if (hasSrc) {
        await pool.execute(
          `INSERT INTO transactions (transaction_id, user_id, type, amount, description, settlement_month, related_id, reward_source_order_id, tax_deducted, created_at)
           VALUES (?, ?, 'upgrade_diff', ?, ?, ?, ?, ?, ?, NOW())`,
          [txnId, p.user_id, payAmt, p.calc_reason || '评价升级差额补发', triggerMonth, p.review_id, p.order_id, payTax]
        );
      } else {
        await pool.execute(
          `INSERT INTO transactions (transaction_id, user_id, type, amount, description, settlement_month, related_id, tax_deducted, created_at)
           VALUES (?, ?, 'upgrade_diff', ?, ?, ?, ?, ?, NOW())`,
          [txnId, p.user_id, payAmt, p.calc_reason || '评价升级差额补发', triggerMonth, p.review_id, payTax]
        );
      }
      await pool.execute(
        'UPDATE reward_settlement_pending SET settled_at = NOW(), transaction_id = ? WHERE id = ?',
        [txnId, p.id]
      );
      try {
        const auditLogger = require('../reward-audit-logger');
        auditLogger.logUpgradeDiff({
          order_id: p.order_id,
          review_id: p.review_id,
          user_id: p.user_id,
          settlement_month: triggerMonth,
          pending_id: p.id,
          pending_amount_after_tax: parseFloat(p.amount_after_tax),
          settled_pay_after_tax: payAmt,
          settled_tax: payTax,
          old_level: null,
          new_level: null,
          diff_amount: payAmt,
          calc_reason: p.calc_reason,
        });
        auditLogger.log('upgrade_diff_settle', {
          settlement_month: triggerMonth,
          pending_id: p.id,
          review_id: p.review_id,
          order_id: p.order_id,
          user_id: p.user_id,
          settled_pay_after_tax: payAmt,
          settled_tax: payTax,
        });
      } catch (_) {}
      count++;
      amount += payAmt;
    } catch (e) {
      errors.push(`pending ${p.id}: ${e.message}`);
    }
  }

  return { count, amount, errors };
}

/**
 * 常规点赞追加（互动轨）：结算月内完工订单 ΣC × interactionPoolShare 为全站池，
 * 按该月各主评有效赞 weight_coefficient 之和占比分配；**不**经 `clampPayoutToOrderHardCap` 按单压减。
 */
async function settleLikeBonus(pool, startDate, endDate) {
  const monthStr = startDate.slice(0, 7);
  const [y, m] = monthStr.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();

  let interactionPoolShare = 0.1;
  try {
    const rules = await rewardCalculator.getRewardRules(pool);
    const s = rules?.platformIncentiveV1?.interactionPoolShare;
    if (typeof s === 'number' && s > 0 && s <= 1) interactionPoolShare = s;
  } catch (_) {}

  const [monthOrders] = await pool.execute(
    `SELECT o.order_id, o.quoted_amount, o.actual_amount, o.quote_id, o.is_insurance_accident
     FROM orders o
     WHERE o.status = 3 AND o.completed_at >= ? AND o.completed_at <= ?`,
    [startDate, endDate]
  );

  let sigmaC = 0;
  for (const row of monthOrders) {
    const c = await rewardCalculator.computeOrderCommissionAmount(pool, row);
    if (c > 0) sigmaC += c;
  }
  sigmaC = Math.round(sigmaC * 100) / 100;
  const poolPreTax = Math.round(sigmaC * interactionPoolShare * 100) / 100;

  const [likes] = await pool.execute(
    `SELECT rl.review_id, rl.user_id as liker_id, rl.weight_coefficient, rl.is_valid_for_bonus,
            r.user_id as author_id, r.order_id
     FROM review_likes rl
     JOIN reviews r ON rl.review_id = r.review_id AND r.type = 1 AND r.status = 1
     WHERE rl.is_valid_for_bonus = 1
       AND rl.created_at >= ? AND rl.created_at <= ?
       AND rl.like_type = 'normal'`,
    [monthStr + '-01 00:00:00', `${monthStr}-${String(lastDay).padStart(2, '0')} 23:59:59`]
  );

  const byReview = {};
  for (const l of likes) {
    const k = l.review_id;
    if (!byReview[k]) byReview[k] = { author_id: l.author_id, order_id: l.order_id, weightSum: 0 };
    byReview[k].weightSum += parseFloat(l.weight_coefficient || 0);
  }

  const entries = Object.entries(byReview)
    .filter(([, v]) => v.weightSum > 0)
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  let count = 0;
  let amount = 0;
  const errors = [];

  if (poolPreTax <= 0 || entries.length === 0) {
    return { count, amount, errors };
  }

  const totalW = entries.reduce((s, [, v]) => s + v.weightSum, 0);
  if (totalW <= 0) {
    return { count, amount, errors };
  }

  let allocatedBeforeTax = 0;
  let idx = 0;
  for (const [reviewId, info] of entries) {
    idx++;
    try {
      let bonusBeforeTax;
      if (idx === entries.length) {
        bonusBeforeTax = Math.round((poolPreTax - allocatedBeforeTax) * 100) / 100;
      } else {
        bonusBeforeTax = Math.round((poolPreTax * info.weightSum) / totalW * 100) / 100;
        allocatedBeforeTax += bonusBeforeTax;
      }
      if (bonusBeforeTax <= 0) continue;

      const [orders] = await pool.execute(
        'SELECT o.order_id, o.quoted_amount, o.actual_amount, o.complexity_level, o.shop_id, o.quote_id, o.is_insurance_accident FROM orders o WHERE o.order_id = ?',
        [info.order_id]
      );
      if (orders.length === 0) continue;
      const order = orders[0];
      const commission = await getOrderCommission(pool, order);

      const wLike = preWithholdLaborRemunerationEachPayment(bonusBeforeTax);
      const taxDeductedRaw = wLike.taxDeducted;
      const bonusAfterTax = wLike.afterTax;
      const taxDeducted = taxDeductedRaw;
      const proposedBurdenLike = Math.round((bonusAfterTax + taxDeducted) * 100) / 100;
      if (bonusAfterTax <= 0) continue;

      const txnId = 'TXN' + Date.now() + 'L' + crypto.randomBytes(4).toString('hex');
      const desc = `常规点赞追加（全站池·权重和${info.weightSum.toFixed(2)}·月ΣC${sigmaC.toFixed(2)}）`;

      await pool.execute(
        'UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?',
        [bonusAfterTax, bonusAfterTax, info.author_id]
      );
      const hasSrc = await orderRewardCap.hasRewardSourceOrderColumn(pool);
      if (hasSrc) {
        await pool.execute(
          `INSERT INTO transactions (transaction_id, user_id, type, amount, description, settlement_month, related_id, reward_source_order_id, tax_deducted, created_at)
           VALUES (?, ?, 'like_bonus', ?, ?, ?, ?, ?, ?, NOW())`,
          [txnId, info.author_id, bonusAfterTax, desc, monthStr, reviewId, info.order_id, taxDeducted]
        );
      } else {
        await pool.execute(
          `INSERT INTO transactions (transaction_id, user_id, type, amount, description, settlement_month, related_id, tax_deducted, created_at)
           VALUES (?, ?, 'like_bonus', ?, ?, ?, ?, ?, NOW())`,
          [txnId, info.author_id, bonusAfterTax, desc, monthStr, reviewId, taxDeducted]
        );
      }
      try {
        const auditLogger = require('../reward-audit-logger');
        auditLogger.logLikeBonus({
          review_id: reviewId,
          order_id: info.order_id,
          user_id: info.author_id,
          settlement_month: monthStr,
          commission,
          commission_C: commission,
          allocation_mode: 'monthly_global_pool',
          sigma_c_month: sigmaC,
          interaction_pool_share: interactionPoolShare,
          pool_pre_tax_month: poolPreTax,
          total_weight_sum_month: totalW,
          weight_sum: info.weightSum,
          bonus_before_tax: bonusBeforeTax,
          tax_deducted: taxDeducted,
          bonus_after_tax: bonusAfterTax,
          proposed_pre_tax_burden: proposedBurdenLike,
        });
      } catch (_) {}
      count++;
      amount += bonusAfterTax;
    } catch (e) {
      errors.push(`review ${reviewId}: ${e.message}`);
    }
  }

  return { count, amount, errors };
}

async function getOrderCommission(pool, order) {
  return rewardCalculator.computeOrderCommissionAmount(pool, order);
}

/**
 * 处理内容转化追加：从 reward_settlement_pending 读取 conversion_bonus，发放
 */
async function settleConversionBonus(pool, startDate, endDate) {
  const triggerMonth = startDate.slice(0, 7);
  const [pendingRows] = await pool.execute(
    `SELECT id, user_id, review_id, order_id, amount_before_tax, tax_deducted, amount_after_tax, calc_reason
     FROM reward_settlement_pending
     WHERE pending_type = 'conversion_bonus' AND settled_at IS NULL AND trigger_month = ?`,
    [triggerMonth]
  );

  const errors = [];
  let count = 0;
  let amount = 0;

  for (const p of pendingRows) {
    try {
      const [ordRows] = await pool.execute(
        'SELECT o.order_id, o.quoted_amount, o.actual_amount, o.complexity_level, o.shop_id, o.quote_id, o.is_insurance_accident, o.repair_plan, o.bidding_id FROM orders o WHERE o.order_id = ?',
        [p.order_id]
      );
      const orderRow = ordRows[0];
      if (!orderRow) {
        errors.push(`pending ${p.id}: 订单 ${p.order_id} 不存在`);
        continue;
      }
      const capped = await orderRewardCap.clampPayoutToOrderHardCap(
        pool,
        p.order_id,
        orderRow,
        { afterTax: parseFloat(p.amount_after_tax), taxDeducted: parseFloat(p.tax_deducted || 0) },
        p.id,
        { review_id: p.review_id, payout_kind: 'conversion_bonus', pending_id: p.id }
      );
      const payAmt = capped.afterTax;
      const payTax = capped.taxDeducted;
      if (payAmt <= 0) {
        await pool.execute(
          `UPDATE reward_settlement_pending SET settled_at = NOW(), transaction_id = CONCAT('SKIP_', id) WHERE id = ?`,
          [p.id]
        );
        errors.push(`pending ${p.id}: 订单硬帽后金额为 0，已关闭`);
        continue;
      }
      const txnId = 'TXN' + Date.now() + 'C' + crypto.randomBytes(4).toString('hex');
      await pool.execute(
        'UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?',
        [payAmt, payAmt, p.user_id]
      );
      const hasSrc = await orderRewardCap.hasRewardSourceOrderColumn(pool);
      if (hasSrc) {
        await pool.execute(
          `INSERT INTO transactions (transaction_id, user_id, type, amount, description, settlement_month, related_id, reward_source_order_id, tax_deducted, created_at)
           VALUES (?, ?, 'conversion_bonus', ?, ?, ?, ?, ?, ?, NOW())`,
          [txnId, p.user_id, payAmt, p.calc_reason || '内容转化追加', triggerMonth, p.review_id, p.order_id, payTax]
        );
      } else {
        await pool.execute(
          `INSERT INTO transactions (transaction_id, user_id, type, amount, description, settlement_month, related_id, tax_deducted, created_at)
           VALUES (?, ?, 'conversion_bonus', ?, ?, ?, ?, ?, NOW())`,
          [txnId, p.user_id, payAmt, p.calc_reason || '内容转化追加', triggerMonth, p.review_id, payTax]
        );
      }
      await pool.execute(
        'UPDATE reward_settlement_pending SET settled_at = NOW(), transaction_id = ? WHERE id = ?',
        [txnId, p.id]
      );
      try {
        const auditLogger = require('../reward-audit-logger');
        auditLogger.log('conversion_bonus_settle', {
          settlement_month: triggerMonth,
          pending_id: p.id,
          review_id: p.review_id,
          order_id: p.order_id,
          user_id: p.user_id,
          pending_amount_after_tax: parseFloat(p.amount_after_tax),
          settled_pay_after_tax: payAmt,
          settled_tax: payTax,
          calc_reason: p.calc_reason,
        });
      } catch (_) {}
      count++;
      amount += payAmt;
    } catch (e) {
      errors.push(`pending ${p.id}: ${e.message}`);
    }
  }

  return { count, amount, errors };
}

/**
 * 事后验证补发：上月完成订单，存在 post_verify 点赞且该订单未分配内容转化时，从佣金 20% 池补发
 */
async function settlePostVerifyBonus(pool, startDate, endDate) {
  const monthStr = startDate.slice(0, 7);
  const errors = [];
  let count = 0;
  let amount = 0;

  const [orders] = await pool.execute(
    `SELECT o.order_id, o.user_id, o.created_at, o.completed_at, o.actual_amount, o.quoted_amount, o.quote_id, o.is_insurance_accident
     FROM orders o
     WHERE o.status = 3 AND o.completed_at >= ? AND o.completed_at <= ?`,
    [startDate, endDate]
  );

  for (const order of orders) {
    try {
      const [hasConv] = await pool.execute(
        `SELECT 1 FROM reward_settlement_pending WHERE order_id = ? AND pending_type = 'conversion_bonus' LIMIT 1`,
        [order.order_id]
      );
      if (hasConv.length > 0) continue;

      const [hasConvTxn] = await pool.execute(
        `SELECT 1 FROM transactions t JOIN reviews r ON t.related_id = r.review_id
         WHERE r.order_id = ? AND t.type = 'conversion_bonus' LIMIT 1`,
        [order.order_id]
      );
      if (hasConvTxn.length > 0) continue;

      const [hasPostVerify] = await pool.execute(
        'SELECT 1 FROM post_verify_settled_orders WHERE order_id = ? LIMIT 1',
        [order.order_id]
      );
      if (hasPostVerify.length > 0) continue;

      const completedAt = new Date(order.completed_at);
      const likeEnd = new Date(completedAt);
      likeEnd.setDate(likeEnd.getDate() + 30);

      const [postVerifyLikes] = await pool.execute(
        `SELECT rl.review_id, rl.created_at, r.user_id as author_id
         FROM review_likes rl
         JOIN reviews r ON rl.review_id = r.review_id AND r.type = 1 AND r.status = 1
         WHERE rl.user_id = ? AND rl.is_valid_for_bonus = 1 AND rl.like_type = 'post_verify'
           AND rl.created_at >= ? AND rl.created_at <= ?`,
        [order.user_id, order.completed_at, likeEnd.toISOString().slice(0, 19).replace('T', ' ')]
      );

      if (postVerifyLikes.length === 0) continue;

      const like = postVerifyLikes[0];
      const [hasBrowse] = await pool.execute(
        `SELECT 1 FROM review_reading_sessions WHERE review_id = ? AND user_id = ?
         AND saw_at >= DATE_SUB(?, INTERVAL 7 DAY) AND saw_at < ? LIMIT 1`,
        [like.review_id, order.user_id, order.created_at, order.created_at]
      );
      if (hasBrowse.length === 0) continue;

      const [ordFull] = await pool.execute(
        'SELECT o.order_id, o.quoted_amount, o.actual_amount, o.complexity_level, o.shop_id, o.quote_id, o.is_insurance_accident, o.repair_plan, o.bidding_id FROM orders o WHERE o.order_id = ?',
        [order.order_id]
      );
      const orderRow = ordFull[0] || order;
      const commission = await getOrderCommission(pool, orderRow);
      if (commission <= 0) continue;
      const poolShare = await rewardCalculator.getConversionPoolShare(pool);
      const distBuyer = await referralService.isDistributionBuyer(pool, order.user_id);
      let bonusBeforeTax = commission * poolShare;
      if (distBuyer) bonusBeforeTax = Math.round(bonusBeforeTax * 0.5 * 100) / 100;
      const wPv = preWithholdLaborRemunerationEachPayment(bonusBeforeTax);
      const taxDeductedRaw = wPv.taxDeducted;
      let bonusAfterTax = wPv.afterTax;
      const capped = await orderRewardCap.clampPayoutToOrderHardCap(
        pool,
        order.order_id,
        orderRow,
        {
          afterTax: bonusAfterTax,
          taxDeducted: taxDeductedRaw,
        },
        null,
        { review_id: like.review_id, payout_kind: 'post_verify_bonus' }
      );
      bonusAfterTax = capped.afterTax;
      const taxDeducted = capped.taxDeducted;
      if (bonusAfterTax <= 0) continue;

      const txnId = 'TXN' + Date.now() + 'P' + crypto.randomBytes(4).toString('hex');
      const desc = '事后验证补发（修车后回头点赞）';

      await pool.execute(
        'UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?',
        [bonusAfterTax, bonusAfterTax, like.author_id]
      );
      const hasSrc = await orderRewardCap.hasRewardSourceOrderColumn(pool);
      if (hasSrc) {
        await pool.execute(
          `INSERT INTO transactions (transaction_id, user_id, type, amount, description, settlement_month, related_id, reward_source_order_id, tax_deducted, created_at)
           VALUES (?, ?, 'post_verify_bonus', ?, ?, ?, ?, ?, ?, NOW())`,
          [txnId, like.author_id, bonusAfterTax, desc, monthStr, like.review_id, order.order_id, taxDeducted]
        );
      } else {
        await pool.execute(
          `INSERT INTO transactions (transaction_id, user_id, type, amount, description, settlement_month, related_id, tax_deducted, created_at)
           VALUES (?, ?, 'post_verify_bonus', ?, ?, ?, ?, ?, NOW())`,
          [txnId, like.author_id, bonusAfterTax, desc, monthStr, like.review_id, taxDeducted]
        );
      }
      await pool.execute(
        'INSERT INTO post_verify_settled_orders (order_id, settlement_month) VALUES (?, ?)',
        [order.order_id, monthStr]
      );
      try {
        const auditLogger = require('../reward-audit-logger');
        auditLogger.logPostVerifyBonus({
          order_id: order.order_id,
          review_id: like.review_id,
          user_id: like.author_id,
          settlement_month: monthStr,
          commission_C: commission,
          conversion_pool_share: poolShare,
          commission,
          bonus_before_tax: bonusBeforeTax,
          tax_deducted: taxDeducted,
          bonus_after_tax: bonusAfterTax,
          tracks: {
            base: { note: '见 review_submit' },
            interaction: { note: 'post_verify 点赞类型' },
            conversion: { stage: 'post_verify_full_pool', settled: true, pipeline: 'post_verify_bonus' },
          },
        });
      } catch (_) {}
      count++;
      amount += bonusAfterTax;
    } catch (e) {
      errors.push(`order ${order.order_id}: ${e.message}`);
    }
  }

  return { count, amount, errors };
}

/**
 * 推荐佣金：买家已绑定一级推荐人、订单在本窗口完工且未结算过推荐佣金时，
 * 一级 10%·C、二级 2%·C（C 为实收佣金）；不入 80% 车主硬帽（transactions.type 不在 order-reward-cap 枚举内）。
 */
async function settleReferralCommission(pool, startDate, endDate) {
  const monthStr = startDate.slice(0, 7);
  const errors = [];
  let count = 0;
  let amount = 0;
  const { l1: R1, l2: R2 } = referralService.getRates();

  const [orders] = await pool.execute(
    `SELECT o.order_id, o.user_id, o.completed_at, o.actual_amount, o.quoted_amount, o.quote_id,
            o.is_insurance_accident, o.complexity_level, o.shop_id, o.bidding_id, o.repair_plan,
            u.referrer_user_id AS l1_id
     FROM orders o
     INNER JOIN users u ON u.user_id = o.user_id
     WHERE o.status = 3 AND o.completed_at >= ? AND o.completed_at <= ?
       AND u.referrer_user_id IS NOT NULL AND TRIM(u.referrer_user_id) != ''`,
    [startDate, endDate]
  );

  let rulesPreTax = true;
  try {
    const rules = await rewardCalculator.getRewardRules(pool);
    rulesPreTax = rules.platformIncentiveV1?.compliancePreTaxOnly !== false;
  } catch (_) {}

  const hasSrc = await orderRewardCap.hasRewardSourceOrderColumn(pool);

  const payOne = async (toUserId, gross, type, desc, orderId) => {
    if (gross <= 0) return 0;
    const pack = rulesPreTax
      ? { taxDeducted: 0, afterTax: Math.round(gross * 100) / 100 }
      : preWithholdLaborRemunerationEachPayment(gross);
    const taxDeductedRaw = pack.taxDeducted;
    const afterTax = pack.afterTax;
    if (afterTax <= 0) return 0;
    const txnId = 'TXN' + Date.now() + 'R' + crypto.randomBytes(3).toString('hex');
    await pool.execute(
      'UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?',
      [afterTax, afterTax, toUserId]
    );
    if (hasSrc) {
      await pool.execute(
        `INSERT INTO transactions (transaction_id, user_id, type, amount, description, settlement_month, related_id, reward_source_order_id, tax_deducted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [txnId, toUserId, type, afterTax, desc, monthStr, orderId, orderId, taxDeductedRaw]
      );
    } else {
      await pool.execute(
        `INSERT INTO transactions (transaction_id, user_id, type, amount, description, settlement_month, related_id, tax_deducted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [txnId, toUserId, type, afterTax, desc, monthStr, orderId, taxDeductedRaw]
      );
    }
    return afterTax;
  };

  for (const row of orders) {
    try {
      const [done] = await pool.execute(
        'SELECT 1 FROM referral_commission_settled_orders WHERE order_id = ? LIMIT 1',
        [row.order_id]
      );
      if (done.length) continue;

      const orderRow = { ...row };
      delete orderRow.l1_id;
      const commission = await getOrderCommission(pool, orderRow);
      if (commission <= 0) continue;

      const buyerId = row.user_id;
      const l1Id = String(row.l1_id || '').trim();
      if (!l1Id || l1Id === buyerId) continue;

      let l2Id = null;
      const [l1u] = await pool.execute(
        'SELECT referrer_user_id FROM users WHERE user_id = ? LIMIT 1',
        [l1Id]
      );
      if (l1u.length && l1u[0].referrer_user_id) {
        const cand = String(l1u[0].referrer_user_id).trim();
        if (cand && cand !== buyerId && cand !== l1Id) l2Id = cand;
      }

      const payL1Gross = Math.round(commission * R1 * 100) / 100;
      const payL2Gross = l2Id ? Math.round(commission * R2 * 100) / 100 : 0;
      if (payL1Gross <= 0) continue;

      const net1 = await payOne(
        l1Id,
        payL1Gross,
        'referral_l1_bonus',
        `一级推荐佣金（订单${row.order_id}）`,
        row.order_id
      );
      amount += net1;
      if (net1 > 0) count += 1;

      let net2 = 0;
      if (l2Id && payL2Gross > 0) {
        net2 = await payOne(
          l2Id,
          payL2Gross,
          'referral_l2_bonus',
          `二级推荐佣金（订单${row.order_id}）`,
          row.order_id
        );
        amount += net2;
        if (net2 > 0) count += 1;
      }

      if (net1 + net2 > 0) {
        await pool.execute(
          'INSERT INTO referral_commission_settled_orders (order_id, settlement_month) VALUES (?, ?)',
          [row.order_id, monthStr]
        );
      }
    } catch (e) {
      errors.push(`referral order ${row.order_id}: ${e.message}`);
    }
  }

  return { count, amount, errors };
}

/**
 * 插入评价升级差额待结算（由 recomputeHolisticContentQuality 调用）
 */
async function insertUpgradeDiffPending(pool, { userId, reviewId, orderId, amountBeforeTax, taxDeducted, amountAfterTax, calcReason, triggerMonth }) {
  await pool.execute(
    `INSERT INTO reward_settlement_pending (user_id, review_id, order_id, pending_type, amount_before_tax, tax_deducted, amount_after_tax, calc_reason, trigger_month)
     VALUES (?, ?, ?, 'upgrade_diff', ?, ?, ?, ?, ?)`,
    [userId, reviewId, orderId, amountBeforeTax, taxDeducted, amountAfterTax, calcReason, triggerMonth]
  );
}

module.exports = {
  settleMonth,
  settleUpgradeDiff,
  settleLikeBonus,
  settleConversionBonus,
  settlePostVerifyBonus,
  settleReferralCommission,
  insertUpgradeDiffPending,
};
