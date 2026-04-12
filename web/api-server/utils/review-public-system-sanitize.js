/**
 * 评价公示：系统校验子集 + 按 review_public_media 过滤图片类 URL
 * review_public_media 为 NULL 时回退为「仅 review_images_public」一刀切（与旧版一致）
 */

function parseJson(v, fb = null) {
  if (v == null || v === '') return fb;
  try {
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch (_) {
    return fb;
  }
}

function reviewAllowsPublicImages(row) {
  const v = row.review_images_public;
  if (v == null || v === '') return true;
  return Number(v) === 1;
}

function truthyFlag(v) {
  return v === true || v === 1 || v === '1';
}

/**
 * @param {object} row - reviews 行（含 review_public_media、review_images_public、objective_answers）
 * @param {object} buckets
 * @param {string[]=} buckets.before_images
 * @param {string[]=} buckets.after_images
 * @param {string[]=} buckets.completion_images
 * @param {string[]=} buckets.material_photos
 * @param {string[]=} buckets.fault_evidence_images
 * @param {string|null=} buckets.settlement_list_image
 */
function applyGranularPublicImages(row, buckets) {
  const b = buckets || {};
  const oa = parseJson(row.objective_answers, {});
  const ownerAlways = Array.isArray(oa.owner_always_public_urls)
    ? oa.owner_always_public_urls.map((u) => String(u || '').trim()).filter(Boolean)
    : [];
  const ownerSet = new Set(ownerAlways);

  const allow = reviewAllowsPublicImages(row);
  let beforeOut = [];
  let afterOut = [];
  let completionOut = [];
  let materialOut = [];
  let settlementOut = null;

  if (!allow) {
    beforeOut = [];
    afterOut = [];
    completionOut = [];
    materialOut = [];
    settlementOut = null;
  } else {
    const rpm = parseJson(row.review_public_media, null);
    if (rpm == null || typeof rpm !== 'object') {
      beforeOut = b.before_images || [];
      afterOut = b.after_images || [];
      completionOut = b.completion_images || [];
      materialOut = b.material_photos || [];
      settlementOut = b.settlement_list_image != null ? b.settlement_list_image : null;
    } else {
      const ext = truthyFlag(rpm.exterior_before_after);
      const parts = truthyFlag(rpm.parts_contrast);
      const settle = truthyFlag(rpm.settlement_docs);
      const other = truthyFlag(rpm.other);
      beforeOut = ext ? b.before_images || [] : [];
      afterOut = ext ? b.after_images || [] : [];
      materialOut = parts ? b.material_photos || [] : [];
      settlementOut = settle ? b.settlement_list_image || null : null;
      completionOut = other ? b.completion_images || [] : [];
    }
  }

  const compBucket = b.completion_images || [];
  for (const u of compBucket) {
    const s = String(u || '').trim();
    if (s && ownerSet.has(s) && !completionOut.includes(s)) completionOut.push(s);
  }
  const settleRaw = b.settlement_list_image != null ? String(b.settlement_list_image).trim() : '';
  if (settleRaw && ownerSet.has(settleRaw)) {
    settlementOut = b.settlement_list_image;
  }
  const faultBucket = b.fault_evidence_images || [];
  for (const u of faultBucket) {
    const s = String(u || '').trim();
    if (s && ownerSet.has(s) && !completionOut.includes(s)) completionOut.push(s);
  }

  return {
    before_images: beforeOut,
    after_images: afterOut,
    completion_images: completionOut,
    material_photos: materialOut,
    settlement_list_image: settlementOut,
  };
}

function buildQuoteFlowSubset(qf) {
  if (!qf || typeof qf !== 'object') return null;
  return {
    disclaimer: qf.disclaimer,
    nodes: Array.isArray(qf.nodes)
      ? qf.nodes.map((n) => ({
          index: n.index,
          revision_no: n.revision_no,
          display_round_label: n.display_round_label,
          amount: n.amount,
          submitted_at: n.submitted_at,
          status_text: n.status_text,
          change_note: n.change_note,
        }))
      : [],
    chart_spec: qf.chart_spec && typeof qf.chart_spec === 'object' ? qf.chart_spec : undefined,
  };
}

/**
 * 车主端 / 公示：仅订单留痕事实（报价节点、店方验真方式等），不含 AI 结论、报价偏离归纳、配件归纳文案。
 * 不含 star_ai_anomaly、user_ai_alignment（仅库内全量 JSON 保留）。
 * @param {object|string|null} raw - review_system_checks 列
 */
function sanitizeSystemChecksForUserFacing(raw) {
  const o = parseJson(raw, {});
  if (!o || typeof o !== 'object') return {};
  const out = {};
  const qfSub = buildQuoteFlowSubset(o.quote_flow);
  if (qfSub) out.quote_flow = qfSub;

  if (o.parts_delivery && typeof o.parts_delivery === 'object') {
    const x = o.parts_delivery;
    const pd = {};
    if (x.status != null && x.status !== '') pd.status = x.status;
    if (Array.isArray(x.merchant_methods) && x.merchant_methods.length) {
      pd.merchant_methods = x.merchant_methods;
    }
    const mvn = x.merchant_verify_note != null ? String(x.merchant_verify_note).trim() : '';
    if (mvn) pd.merchant_verify_note = mvn;
    if (Object.keys(pd).length) out.parts_delivery = pd;
  }

  for (const k of ['warranty', 'loss_vs_settlement']) {
    if (o[k] && typeof o[k] === 'object') {
      const x = o[k];
      out[k] = {
        status: x.status,
        reason: x.reason,
        note: x.note,
      };
    }
  }
  return out;
}

/**
 * 与 {@link sanitizeSystemChecksForUserFacing} 一致（历史命名：公示 API）。
 */
function sanitizeSystemChecksForPublic(raw) {
  return sanitizeSystemChecksForUserFacing(raw);
}

module.exports = {
  parseJson,
  reviewAllowsPublicImages,
  applyGranularPublicImages,
  sanitizeSystemChecksForPublic,
  sanitizeSystemChecksForUserFacing,
};
