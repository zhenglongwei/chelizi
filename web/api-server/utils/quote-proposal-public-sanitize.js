/**
 * 店铺/口碑等公开评价列表：报价历程不下发举证原图；quote_snapshot 内分项价裁剪（保留轮次总价等）
 * 订单详情、商户端仍用 listFormatted 完整结果
 */

/**
 * 深拷贝并移除方案行级金额字段，保留快照级 amount/duration 等
 * @param {object|null} snap
 * @returns {object|null}
 */
function stripLinePricesFromQuoteSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return snap;
  let out;
  try {
    out = JSON.parse(JSON.stringify(snap));
  } catch (_) {
    return snap;
  }
  if (Array.isArray(out.items)) {
    out.items = out.items.map((it) => {
      if (!it || typeof it !== 'object') return it;
      const i = { ...it };
      delete i.price;
      delete i.unit_price;
      delete i.labor_price;
      delete i.parts_price;
      delete i.line_amount;
      delete i.subtotal;
      delete i.line_total;
      delete i.amount;
      return i;
    });
  }
  if (Array.isArray(out.value_added_services)) {
    out.value_added_services = out.value_added_services.map((v) => {
      if (v && typeof v === 'object') {
        const x = { ...v };
        delete x.price;
        delete x.amount;
        return x;
      }
      return v;
    });
  }
  return out;
}

/**
 * @param {Array<{ evidence?: object, quote_snapshot?: object }>} history - listFormatted 或含合成预报价行
 * @returns {Array}
 */
function sanitizeQuoteProposalHistoryForPublicList(history) {
  if (!Array.isArray(history)) return [];
  return history.map((p) => {
    if (!p || typeof p !== 'object') return p;
    const ev = p.evidence && typeof p.evidence === 'object' ? { ...p.evidence } : {};
    ev.photo_urls = [];
    if (ev.loss_assessment_documents && typeof ev.loss_assessment_documents === 'object') {
      ev.loss_assessment_documents = { ...ev.loss_assessment_documents, urls: [] };
    }
    const quote_snapshot = stripLinePricesFromQuoteSnapshot(p.quote_snapshot);
    return { ...p, evidence: ev, quote_snapshot };
  });
}

module.exports = {
  sanitizeQuoteProposalHistoryForPublicList,
  stripLinePricesFromQuoteSnapshot,
};
