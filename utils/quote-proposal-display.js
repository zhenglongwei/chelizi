/**
 * 报价公示列表：接口 quote_proposal_history → 小程序展示结构（评价流 / 店铺详情 / 评价页共用）
 */

const { getShopNthQuoteLabel, getShopRoundStageCode, QUOTE_LABELS } = require('./quote-nomenclature');

function formatQuoteTs(str) {
  if (!str) return '';
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return String(str);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${day} ${h}:${mi}`;
}

/**
 * @param {Array} displayList buildQuoteProposalDisplayList 结果
 * @returns {string}
 */
function buildQuoteJourneySummary(displayList) {
  if (!Array.isArray(displayList) || displayList.length === 0) return '';
  const fmt = (a) =>
    a != null && a !== '' && !Number.isNaN(Number(a)) ? Number(a).toFixed(2) : '';
  const firstAmt = fmt(displayList[0].amount);
  const lastAmt = fmt(displayList[displayList.length - 1].amount);
  if (displayList.length === 1) {
    return firstAmt ? `${QUOTE_LABELS.biddingPrequoteShort} ¥${firstAmt}（公示）` : '本单报价历程（公示）';
  }
  const n = displayList.length;
  if (firstAmt && lastAmt && firstAmt !== lastAmt) {
    const up = Number(lastAmt) > Number(firstAmt);
    return `${QUOTE_LABELS.biddingPrequoteShort} ¥${firstAmt} → 末条 ¥${lastAmt}（${up ? '上调' : '下调'}）· 共 ${n} 条`;
  }
  if (firstAmt && lastAmt) {
    return `${QUOTE_LABELS.biddingPrequoteShort} ¥${firstAmt} → 末条 ¥${lastAmt} · 共 ${n} 条`;
  }
  return `本单报价历程共 ${n} 条（公示）`;
}

function buildQuoteProposalDisplayList(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw.map((p) => {
    const snap = p.quote_snapshot || {};
    const ev = p.evidence || {};
    const urls = [...(ev.photo_urls || [])];
    const loss = ev.loss_assessment_documents;
    if (loss && typeof loss === 'object' && Array.isArray(loss.urls)) {
      loss.urls.forEach((u) => {
        if (typeof u === 'string' && urls.indexOf(u) < 0) urls.push(u);
      });
    }
    const subAt = p.submitted_at;
    const resAt = p.resolved_at;
    return {
      proposal_id: p.proposal_id || 'rev_' + String(p.revision_no),
      is_synthetic_pre_quote: !!p.is_synthetic_pre_quote,
      revision_no: p.revision_no,
      display_round_label:
        p.display_round_label ||
        (p.is_synthetic_pre_quote ? QUOTE_LABELS.biddingPrequoteFull : getShopNthQuoteLabel(p.revision_no)),
      quote_stage_code:
        p.quote_stage_code ||
        (p.is_synthetic_pre_quote ? 'bidding_prequote:public' : getShopRoundStageCode(p.revision_no)),
      status: p.status,
      status_text: p.status_text || '',
      submitted_at: subAt,
      resolved_at: resAt,
      submitted_at_display: formatQuoteTs(subAt),
      resolved_at_display: formatQuoteTs(resAt),
      amount: snap.amount,
      duration: snap.duration,
      supplement_note: (ev.supplement_note || '').trim(),
      photo_urls: urls,
    };
  });
}

module.exports = {
  buildQuoteProposalDisplayList,
  buildQuoteJourneySummary,
  formatQuoteTs,
};
