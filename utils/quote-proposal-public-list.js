/**
 * 与 web/api-server/utils/quote-proposal-public-list.js 语义一致（订单详情 diff 后再 prepend）
 */

const { QUOTE_LABELS, QUOTE_STAGE_CODES } = require('./quote-nomenclature');

function planHasDisplayablePreQuote(plan) {
  if (!plan || typeof plan !== 'object') return false;
  const items = plan.items;
  if (Array.isArray(items) && items.length > 0) return true;
  if (plan.amount != null && plan.amount !== '') return true;
  if (plan.duration != null && plan.duration !== '') return true;
  return false;
}

function prependPreQuoteProposalToList(rows, prePlan, submittedAt) {
  if (!planHasDisplayablePreQuote(prePlan)) return Array.isArray(rows) ? rows : [];
  const list = Array.isArray(rows) ? rows : [];
  const head = {
    proposal_id: 'display_pre_quote',
    is_synthetic_pre_quote: true,
    revision_no: 0,
    display_round_label: QUOTE_LABELS.biddingPrequoteFull,
    quote_stage_code: `${QUOTE_STAGE_CODES.BIDDING_PREQUOTE}:public`,
    status: null,
    status_text: QUOTE_LABELS.preQuotePublicStatusText,
    submitted_at: submittedAt || null,
    resolved_at: null,
    amount: prePlan.amount,
    duration: prePlan.duration,
    supplement_note: '',
    photo_urls: [],
    diffFromPrevious: null,
  };
  if (list.length === 0) return [head];
  return [head, ...list];
}

module.exports = {
  planHasDisplayablePreQuote,
  prependPreQuoteProposalToList,
};
