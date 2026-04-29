/**
 * 单笔订单实收佣金 C 上的用户侧奖励硬帽（默认 0.8·C，税前负担口径 amount+tax_deducted）
 * 与 reward_rules.platformIncentiveV1.maxUserRewardPctOfCommission 一致
 *
 * 说明：`like_bonus` 仍计入 sumChargedAgainstOrderCommission（转化扣减、总支出审计），
 * 但 `settlement-service.settleLikeBonus` 入账前**不再**调用 clampPayoutToOrderHardCap；
 * 转化 pending 发放等路径若仍 clamp，在高互动月可能更易触顶，联调时对照产品预期。
 */

const rewardCalculator = require('../reward-calculator');

const TYPES_IN_CAP = "('rebate','like_bonus','upgrade_diff','conversion_bonus','post_verify_bonus')";

let cachedHasSourceCol = null;

async function hasRewardSourceOrderColumn(pool) {
  if (cachedHasSourceCol != null) return cachedHasSourceCol;
  try {
    const [rows] = await pool.execute(
      `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'reward_source_order_id'`
    );
    cachedHasSourceCol = rows.length > 0;
  } catch {
    cachedHasSourceCol = false;
  }
  return cachedHasSourceCol;
}

async function getHardCapPct(pool) {
  let pct = 0.8;
  try {
    const rules = await rewardCalculator.getRewardRules(pool);
    const m = rules.platformIncentiveV1?.maxUserRewardPctOfCommission;
    if (typeof m === 'number' && m > 0 && m <= 1) pct = m;
  } catch (_) {}
  return pct;
}

/**
 * 已入账 + 未结算 pending 对该笔订单佣金锚点的累计负担（元）
 */
/**
 * @param {string|null} excludePendingId - 结算本条 pending 时排除自身，避免把待入账算进已占用
 */
async function sumChargedAgainstOrderCommission(pool, orderId, excludePendingId = null) {
  const oid = String(orderId || '').trim();
  if (!oid) return 0;

  const hasCol = await hasRewardSourceOrderColumn(pool);

  let txnSum = 0;
  if (hasCol) {
    const [rows] = await pool.execute(
      `SELECT COALESCE(SUM(COALESCE(t.amount, 0) + COALESCE(t.tax_deducted, 0)), 0) AS s
       FROM transactions t
       WHERE t.type IN ${TYPES_IN_CAP}
         AND (
           t.reward_source_order_id = ?
           OR (
             (t.reward_source_order_id IS NULL OR t.reward_source_order_id = '')
             AND EXISTS (SELECT 1 FROM reviews r WHERE r.review_id = t.related_id AND r.order_id = ?)
             AND t.type IN ('rebate', 'like_bonus', 'upgrade_diff', 'post_verify_bonus')
           )
           OR (
             (t.reward_source_order_id IS NULL OR t.reward_source_order_id = '')
             AND t.type = 'conversion_bonus'
             AND EXISTS (
               SELECT 1 FROM reward_settlement_pending p
               WHERE p.transaction_id = t.transaction_id AND p.order_id = ?
             )
           )
         )`,
      [oid, oid, oid]
    );
    txnSum = parseFloat(rows[0]?.s || 0);
  } else {
    const [rows] = await pool.execute(
      `SELECT COALESCE(SUM(COALESCE(t.amount, 0) + COALESCE(t.tax_deducted, 0)), 0) AS s
       FROM transactions t
       WHERE t.type IN ${TYPES_IN_CAP}
         AND (
           (
             EXISTS (SELECT 1 FROM reviews r WHERE r.review_id = t.related_id AND r.order_id = ?)
             AND t.type IN ('rebate', 'like_bonus', 'upgrade_diff', 'post_verify_bonus')
           )
           OR (
             t.type = 'conversion_bonus'
             AND EXISTS (
               SELECT 1 FROM reward_settlement_pending p
               WHERE p.transaction_id = t.transaction_id AND p.order_id = ?
             )
           )
         )`,
      [oid, oid]
    );
    txnSum = parseFloat(rows[0]?.s || 0);
  }

  let pendingSum = 0;
  try {
    const pendParams = [oid];
    let pendEx = '';
    if (excludePendingId) {
      pendEx = ' AND id != ?';
      pendParams.push(excludePendingId);
    }
    const [pRows] = await pool.execute(
      `SELECT COALESCE(SUM(COALESCE(amount_after_tax, 0) + COALESCE(tax_deducted, 0)), 0) AS s
       FROM reward_settlement_pending
       WHERE order_id = ? AND settled_at IS NULL AND pending_type IN ('conversion_bonus', 'upgrade_diff')${pendEx}`,
      pendParams
    );
    pendingSum = parseFloat(pRows[0]?.s || 0);
  } catch (_) {}

  return Math.round((txnSum + pendingSum) * 100) / 100;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function emitHardCapAudit(payload) {
  try {
    const auditLogger = require('../reward-audit-logger');
    auditLogger.logHardCapClamp(payload);
  } catch (_) {}
}

/**
 * 将本次拟发放额压到「剩余硬帽」内（比较口径：入账 amount + tax_deducted）
 * @param {{ review_id?: string, payout_kind?: string, pending_id?: string|number }} [auditCtx] 可选，REWARD_AUDIT_LOG=1 时写入硬帽审计
 */
async function clampPayoutToOrderHardCap(pool, orderId, orderRow, { afterTax, taxDeducted }, excludePendingId = null, auditCtx = null) {
  const at = round2(Math.max(0, Number(afterTax) || 0));
  const td = round2(Math.max(0, Number(taxDeducted) || 0));
  const proposed = round2(at + td);
  if (proposed <= 0) return { afterTax: 0, taxDeducted: 0 };

  const hasCol = await hasRewardSourceOrderColumn(pool);
  if (!hasCol || !orderRow) {
    if (auditCtx) {
      emitHardCapAudit({
        order_id: orderId,
        review_id: auditCtx.review_id,
        payout_kind: auditCtx.payout_kind,
        pending_id: auditCtx.pending_id,
        skipped_no_anchor_column: !hasCol,
        skipped_no_order_row: !orderRow,
        proposed_pre_tax_burden: proposed,
        result_after_tax: at,
        result_tax_deducted: td,
      });
    }
    return { afterTax: at, taxDeducted: td };
  }

  const commission = await rewardCalculator.computeOrderCommissionAmount(pool, orderRow);
  if (commission <= 0) {
    if (auditCtx) {
      emitHardCapAudit({
        order_id: orderId,
        review_id: auditCtx.review_id,
        payout_kind: auditCtx.payout_kind,
        pending_id: auditCtx.pending_id,
        commission_C: commission,
        proposed_pre_tax_burden: proposed,
        result_after_tax: at,
        result_tax_deducted: td,
      });
    }
    return { afterTax: at, taxDeducted: td };
  }

  const capPct = await getHardCapPct(pool);
  const capTotal = round2(commission * capPct);
  const used = await sumChargedAgainstOrderCommission(pool, orderId, excludePendingId);
  const remaining = round2(Math.max(0, capTotal - used));
  if (proposed <= remaining) {
    if (auditCtx) {
      emitHardCapAudit({
        order_id: orderId,
        review_id: auditCtx.review_id,
        payout_kind: auditCtx.payout_kind,
        pending_id: auditCtx.pending_id,
        commission_C: commission,
        max_cap_pct: capPct,
        cap_total_pre_tax_burden: capTotal,
        used_pre_tax_burden_before: used,
        remaining_pre_tax_burden: remaining,
        proposed_pre_tax_burden: proposed,
        result_after_tax: at,
        result_tax_deducted: td,
      });
    }
    return { afterTax: at, taxDeducted: td };
  }

  const newCharge = remaining;
  const newTd = round2(Math.min(td, newCharge));
  const newAt = round2(Math.max(0, newCharge - newTd));
  if (auditCtx) {
    emitHardCapAudit({
      order_id: orderId,
      review_id: auditCtx.review_id,
      payout_kind: auditCtx.payout_kind,
      pending_id: auditCtx.pending_id,
      commission_C: commission,
      max_cap_pct: capPct,
      cap_total_pre_tax_burden: capTotal,
      used_pre_tax_burden_before: used,
      remaining_pre_tax_burden: remaining,
      proposed_pre_tax_burden: proposed,
      result_after_tax: newAt,
      result_tax_deducted: newTd,
    });
  }
  return { afterTax: newAt, taxDeducted: newTd };
}

module.exports = {
  hasRewardSourceOrderColumn,
  getHardCapPct,
  sumChargedAgainstOrderCommission,
  clampPayoutToOrderHardCap,
};
