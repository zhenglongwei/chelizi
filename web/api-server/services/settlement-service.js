/**
 * 月度定期结算服务
 * 每月10日结算上月：评价升级差额、常规点赞追加
 * 详见《评价与点赞奖励-定期结算方案》
 */

const crypto = require('crypto');
const rewardCalculator = require('../reward-calculator');
const conversionBonusService = require('./conversion-bonus-service');

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

  const [startDate, endDate] = getMonthRange(month);

  try {
    const upgradeResult = await settleUpgradeDiff(pool, startDate, endDate);
    upgradeDiffCount = upgradeResult.count;
    upgradeDiffAmount = upgradeResult.amount;
    errors.push(...upgradeResult.errors);
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
      const txnId = 'TXN' + Date.now() + '_' + p.id;
      await pool.execute(
        'UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?',
        [p.amount_after_tax, p.amount_after_tax, p.user_id]
      );
      await pool.execute(
        `INSERT INTO transactions (transaction_id, user_id, type, amount, description, settlement_month, related_id, tax_deducted, created_at)
         VALUES (?, ?, 'upgrade_diff', ?, ?, ?, ?, ?, NOW())`,
        [txnId, p.user_id, p.amount_after_tax, p.calc_reason || '评价升级差额补发', triggerMonth, p.review_id, p.tax_deducted]
      );
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
          old_level: null,
          new_level: null,
          diff_amount: p.amount_after_tax,
          calc_reason: p.calc_reason,
        });
      } catch (_) {}
      count++;
      amount += parseFloat(p.amount_after_tax);
    } catch (e) {
      errors.push(`pending ${p.id}: ${e.message}`);
    }
  }

  return { count, amount, errors };
}

/**
 * 常规点赞追加：查结算月 review_likes 有效点赞，按评价汇总，计算并发放
 */
async function settleLikeBonus(pool, startDate, endDate) {
  const monthStr = startDate.slice(0, 7);
  const [y, m] = monthStr.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();

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

  let count = 0;
  let amount = 0;
  const errors = [];

  for (const [reviewId, info] of Object.entries(byReview)) {
    if (info.weightSum <= 0) continue;
    try {
      const [orders] = await pool.execute(
        'SELECT o.order_id, o.quoted_amount, o.actual_amount, o.complexity_level, o.shop_id FROM orders o WHERE o.order_id = ?',
        [info.order_id]
      );
      if (orders.length === 0) continue;
      const order = orders[0];
      const commission = await getOrderCommission(pool, order);
      if (commission <= 0) continue;

      const cap80 = commission * 0.8;
      const [sumRows] = await pool.execute(
        `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE related_id = ? AND type IN ('rebate', 'upgrade_diff', 'like_bonus')`,
        [reviewId]
      );
      const existingTotal = parseFloat(sumRows[0]?.total || 0);
      const remainingCap = Math.max(0, cap80 - existingTotal);
      if (remainingCap <= 0) continue;

      let bonusBeforeTax = commission * 0.005 * info.weightSum;
      bonusBeforeTax = Math.min(bonusBeforeTax, remainingCap);
      const taxDeducted = bonusBeforeTax > 800 ? Math.round((bonusBeforeTax - 800) * 0.2 * 100) / 100 : 0;
      let bonusAfterTax = Math.round((bonusBeforeTax - taxDeducted) * 100) / 100;
      if (bonusAfterTax <= 0) continue;

      const txnId = 'TXN' + Date.now() + 'L' + crypto.randomBytes(4).toString('hex');
      const desc = `常规点赞追加（${info.weightSum.toFixed(2)}权重和）`;

      await pool.execute(
        'UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?',
        [bonusAfterTax, bonusAfterTax, info.author_id]
      );
      await pool.execute(
        `INSERT INTO transactions (transaction_id, user_id, type, amount, description, settlement_month, related_id, tax_deducted, created_at)
         VALUES (?, ?, 'like_bonus', ?, ?, ?, ?, ?, NOW())`,
        [txnId, info.author_id, bonusAfterTax, desc, monthStr, reviewId, taxDeducted]
      );
      try {
        const auditLogger = require('../reward-audit-logger');
        auditLogger.logLikeBonus({
          review_id: reviewId,
          order_id: info.order_id,
          user_id: info.author_id,
          commission,
          cap80: cap80,
          existing_total: existingTotal,
          remaining_cap: remainingCap,
          weight_sum: info.weightSum,
          bonus_before_tax: bonusBeforeTax,
          tax_deducted: taxDeducted,
          bonus_after_tax: bonusAfterTax,
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
  const amt = parseFloat(order.actual_amount || order.quoted_amount) || 0;
  const rules = await rewardCalculator.getRewardRules(pool);
  const rate = rewardCalculator.calcCommissionRate(rules, amt, null, null, false);
  return amt * rate;
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
      const txnId = 'TXN' + Date.now() + 'C' + crypto.randomBytes(4).toString('hex');
      await pool.execute(
        'UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?',
        [p.amount_after_tax, p.amount_after_tax, p.user_id]
      );
      await pool.execute(
        `INSERT INTO transactions (transaction_id, user_id, type, amount, description, settlement_month, related_id, tax_deducted, created_at)
         VALUES (?, ?, 'conversion_bonus', ?, ?, ?, ?, ?, NOW())`,
        [txnId, p.user_id, p.amount_after_tax, p.calc_reason || '内容转化追加', triggerMonth, p.review_id, p.tax_deducted]
      );
      await pool.execute(
        'UPDATE reward_settlement_pending SET settled_at = NOW(), transaction_id = ? WHERE id = ?',
        [txnId, p.id]
      );
      count++;
      amount += parseFloat(p.amount_after_tax);
    } catch (e) {
      errors.push(`pending ${p.id}: ${e.message}`);
    }
  }

  return { count, amount, errors };
}

/**
 * 事后验证补发：上月完成订单，存在 post_verify 点赞且该订单未分配内容转化时，从奖金池 50% 补发
 */
async function settlePostVerifyBonus(pool, startDate, endDate) {
  const monthStr = startDate.slice(0, 7);
  const errors = [];
  let count = 0;
  let amount = 0;

  const [orders] = await pool.execute(
    `SELECT o.order_id, o.user_id, o.created_at, o.completed_at, o.actual_amount, o.quoted_amount
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

      const commission = await getOrderCommission(pool, order);
      if (commission <= 0) continue;
      const bonusBeforeTax = commission * 0.5;
      const taxDeducted = bonusBeforeTax > 800 ? Math.round((bonusBeforeTax - 800) * 0.2 * 100) / 100 : 0;
      const bonusAfterTax = Math.round((bonusBeforeTax - taxDeducted) * 100) / 100;
      if (bonusAfterTax <= 0) continue;

      const txnId = 'TXN' + Date.now() + 'P' + crypto.randomBytes(4).toString('hex');
      const desc = '事后验证补发（修车后回头点赞）';

      await pool.execute(
        'UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?',
        [bonusAfterTax, bonusAfterTax, like.author_id]
      );
      await pool.execute(
        `INSERT INTO transactions (transaction_id, user_id, type, amount, description, settlement_month, related_id, tax_deducted, created_at)
         VALUES (?, ?, 'post_verify_bonus', ?, ?, ?, ?, ?, NOW())`,
        [txnId, like.author_id, bonusAfterTax, desc, monthStr, like.review_id, taxDeducted]
      );
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
          commission,
          bonus_before_tax: bonusBeforeTax,
          tax_deducted: taxDeducted,
          bonus_after_tax: bonusAfterTax,
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
  insertUpgradeDiffPending,
};
