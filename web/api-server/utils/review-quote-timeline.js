/**
 * 评价页「报价/方案时间线」摘要（for-review 专用）
 */

const { QUOTE_LABELS, getProposalRoundsSummaryLabel } = require('./quote-nomenclature');
const { countShopQuoteProposalRows } = require('./quote-proposal-public-list');

function fmtMoney(n) {
  if (n == null || n === '' || Number.isNaN(parseFloat(n))) return null;
  return Number(parseFloat(n)).toFixed(2);
}

/**
 * @param {object} opts
 * @param {object} opts.order - 订单行（quoted_amount, actual_amount, bidding_id）
 * @param {object|null} opts.quotePlan - 选中报价快照 { amount, ... }
 * @param {object|null} opts.repairPlan
 * @param {object|null} opts.preQuotePlan - 双阶段预报价
 * @param {object|null} opts.finalQuotePlanSnap - 双阶段终报快照
 * @param {Array} opts.proposalHistoryFormatted - listFormatted 结果（含 revision_no 等）
 * @param {number|null} opts.biddingQuotesTotal - 该竞价下报价商户数
 */
function buildQuoteTimelineForReview(opts) {
  const { order, quotePlan, repairPlan, preQuotePlan, finalQuotePlanSnap, proposalHistoryFormatted, biddingQuotesTotal } = opts;

  const selectAmt =
    quotePlan && quotePlan.amount != null ? parseFloat(quotePlan.amount) : null;
  const preAmt =
    preQuotePlan && preQuotePlan.amount != null ? parseFloat(preQuotePlan.amount) : selectAmt;
  const finalAmtRaw =
    finalQuotePlanSnap && finalQuotePlanSnap.amount != null
      ? parseFloat(finalQuotePlanSnap.amount)
      : repairPlan && repairPlan.amount != null
        ? parseFloat(repairPlan.amount)
        : null;
  const quotedOrder = order.quoted_amount != null ? parseFloat(order.quoted_amount) : null;
  const finalAmt = finalAmtRaw != null && !Number.isNaN(finalAmtRaw) ? finalAmtRaw : quotedOrder;

  const settleRaw = order.actual_amount != null ? parseFloat(order.actual_amount) : null;
  const settleAmt =
    settleRaw != null && !Number.isNaN(settleRaw) ? settleRaw : finalAmt;

  const rounds = countShopQuoteProposalRows(proposalHistoryFormatted);

  const parts = [];
  if (selectAmt != null && !Number.isNaN(selectAmt)) {
    parts.push(`${QUOTE_LABELS.biddingPrequoteShort} ¥${fmtMoney(selectAmt)}（无实物·未到店）`);
  }
  if (rounds > 0) {
    const rLabel = getProposalRoundsSummaryLabel(rounds);
    if (rLabel) parts.push(rLabel);
  }
  if (finalAmt != null && !Number.isNaN(finalAmt)) {
    parts.push(`确认报价 ¥${fmtMoney(finalAmt)}`);
  }
  if (settleAmt != null && !Number.isNaN(settleAmt)) {
    parts.push(`结算 ¥${fmtMoney(settleAmt)}`);
  }

  let summary = parts.length ? parts.join(' · ') : '暂无结构化金额节点，详见下方方案对比';

  let highlight = null;
  if (selectAmt != null && selectAmt > 0 && finalAmt != null && !Number.isNaN(finalAmt)) {
    const ratio = Math.abs(finalAmt - selectAmt) / selectAmt;
    if (ratio >= 0.01) {
      const pct = Math.round(ratio * 10000) / 100;
      highlight =
        finalAmt > selectAmt
          ? `较${QUOTE_LABELS.biddingPrequoteShort}上调约 ${pct}%`
          : `较${QUOTE_LABELS.biddingPrequoteShort}下调约 ${pct}%`;
    }
  }

  let bidding_snapshot = null;
  if (biddingQuotesTotal != null && biddingQuotesTotal >= 0 && order.bidding_id) {
    bidding_snapshot = {
      total_quotes_at_bidding: biddingQuotesTotal,
      selected_quote_amount: selectAmt,
      selected_quote_amount_text: fmtMoney(selectAmt),
    };
  }

  return {
    summary,
    highlight,
    bidding_snapshot,
    proposal_rounds: rounds,
    bidding_prequote_caption:
      selectAmt != null && !Number.isNaN(selectAmt) ? QUOTE_LABELS.biddingPrequoteCaption : null,
  };
}

module.exports = { buildQuoteTimelineForReview, fmtMoney };
