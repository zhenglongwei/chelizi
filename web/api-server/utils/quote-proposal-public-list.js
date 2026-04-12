/**
 * 报价公示列表：在 order_quote_proposals 之前插入「预报价」展示行（无 DB 行，quotes/快照语义）
 */

const { QUOTE_LABELS, QUOTE_STAGE_CODES } = require('./quote-nomenclature');

const SYNTHETIC_PRE_QUOTE_PROPOSAL_ID = 'display_pre_quote';

function planHasDisplayablePreQuote(plan) {
  if (!plan || typeof plan !== 'object') return false;
  const items = plan.items;
  if (Array.isArray(items) && items.length > 0) return true;
  if (plan.amount != null && plan.amount !== '') return true;
  if (plan.duration != null && plan.duration !== '') return true;
  return false;
}

/** 与 order_quote_proposals listFormatted 单条形状对齐 */
function buildSyntheticPreQuoteProposalRow(prePlan, acceptedAt) {
  const snap = {
    items: prePlan.items || [],
    value_added_services: prePlan.value_added_services || [],
    amount: prePlan.amount,
    duration: prePlan.duration,
  };
  return {
    proposal_id: SYNTHETIC_PRE_QUOTE_PROPOSAL_ID,
    is_synthetic_pre_quote: true,
    revision_no: 0,
    display_round_label: QUOTE_LABELS.biddingPrequoteFull,
    quote_stage_code: `${QUOTE_STAGE_CODES.BIDDING_PREQUOTE}:public`,
    quote_snapshot: snap,
    evidence: { photo_urls: [] },
    status: null,
    status_text: QUOTE_LABELS.preQuotePublicStatusText,
    submitted_at: acceptedAt || null,
    resolved_at: null,
  };
}

function prependPreQuoteProposalToList(proposals, prePlan, acceptedAt) {
  const list = Array.isArray(proposals) ? proposals : [];
  if (!planHasDisplayablePreQuote(prePlan)) return list;
  const head = buildSyntheticPreQuoteProposalRow(prePlan, acceptedAt);
  if (list.length === 0) return [head];
  return [head, ...list];
}

/** 列表首条可能为合成预报价行；本函数只计 order_quote_proposals 对应条数，供时间线「含二次…」与轮次展示 */
function countShopQuoteProposalRows(proposals) {
  if (!Array.isArray(proposals)) return 0;
  return proposals.filter((p) => p && p.is_synthetic_pre_quote !== true).length;
}

module.exports = {
  planHasDisplayablePreQuote,
  buildSyntheticPreQuoteProposalRow,
  prependPreQuoteProposalToList,
  countShopQuoteProposalRows,
  SYNTHETIC_PRE_QUOTE_PROPOSAL_ID,
};
