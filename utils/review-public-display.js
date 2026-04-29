/**
 * 公开评价列表：默认摘要 + 展开验真（店铺详情、口碑流共用）
 */

function parseObjectiveBool(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '1' || s === 'true') return true;
    if (s === '0' || s === 'false') return false;
  }
  return null;
}

/** 与店铺详情「车主核验」展开区三道题含义一致，便于用户对照实拍 */
const OBJECTIVE_SUMMARY_TOPICS = [
  '方案与进度是否透明',
  '配件是否当面核对',
  '本次送修问题是否修好'
];

/**
 * 列表/折叠态一句话摘要：避免「三项核验」等内部用语，写清「问卷问什么 + 车主选什么」
 * @param {boolean|null} q1 q1_progress_synced
 * @param {boolean|null} q2 q2_parts_shown
 * @param {boolean|null} q3 q3_fault_resolved
 */
function buildObjectiveSummary(q1, q2, q3) {
  const qs = [q1, q2, q3];
  const answered = qs.filter((x) => x !== null);
  if (!answered.length) return '';

  const allThree = qs.every((x) => x !== null);
  const yesCount = qs.filter((x) => x === true).length;

  if (allThree) {
    if (yesCount === 3) {
      return '车主问卷三项均选「是」：方案进度透明、配件已当面核对、送修问题已修好。点「展开验真详情」可看每题说明及本单实拍（若有展示）';
    }
    if (yesCount === 0) {
      return '车主在问卷中对「方案透明度」「配件当面核对」「送修是否修好」三项均未选「是」。请展开查看各题说明，并结合正文与图片综合判断';
    }
    const parts = qs.map((v, i) => `${OBJECTIVE_SUMMARY_TOPICS[i]}「${v ? '是' : '否'}」`);
    return '车主问卷：' + parts.join('；');
  }

  const n = answered.length;
  return `本单问卷已答 ${n} 项，其中 ${yesCount} 项为「是」（完整三项见「展开验真详情」）`;
}

function computeTotalImageCount(r) {
  const b = (r.before_images || []).length;
  const a = (r.after_images || []).length;
  const c = (r.completion_images || []).length;
  const m = (r.material_photos || []).length;
  return b + a + c + m;
}

function computePrimaryThumbs(r) {
  const before = (r.before_images && r.before_images[0]) || '';
  const after =
    (r.after_images && r.after_images[0]) ||
    (r.completion_images && r.completion_images[0]) ||
    '';
  return { primaryBeforeThumb: before, primaryAfterThumb: after };
}

/**
 * @param {object} r - 已含 repair_items、part_promise_lines、material_photos、amountText
 * @param {Array} quoteProposalDisplay - buildQuoteProposalDisplayList 结果
 */
function buildReviewDigestLine(r, quoteProposalDisplay) {
  const parts = [];
  const items = r.repair_items || [];
  if (items.length > 0) parts.push(`${items.length} 个维修项目`);
  if ((r.part_promise_lines || []).length > 0) parts.push('含配件等级');
  if ((r.material_photos || []).length > 0) parts.push('店端配件留档');
  const qd = quoteProposalDisplay || [];
  if (qd.length > 1) parts.push(`报价 ${qd.length} 次`);
  else if (qd.length === 1 && qd[0] && !qd[0].is_synthetic_pre_quote) parts.push('含到店报价');
  if (r.amountText) parts.push('已结算');
  return parts.join(' · ');
}

/** objective_answers.version === 3（极简评价） */
function isObjectiveAnswersV3(oa) {
  return oa && (oa.version === 3 || oa.version === '3');
}

const V3_FAULT_SUMMARY = {
  full: '送修问题：已解决',
  partial: '送修问题：部分解决',
  none: '送修问题：未解决',
};

const V3_PARTS_SUMMARY = {
  verified_ok: '配件核验：已当面/凭证一致',
  not_verified: '配件核验：未核验',
  mismatch: '配件核验：与承诺不一致',
};

/**
 * v3 问卷一句话（列表折叠区）
 */
function buildV3ObjectiveSummary(oa) {
  if (!isObjectiveAnswersV3(oa)) return '';
  const a = [];
  const proc = parseInt(oa.process_transparency_star, 10);
  const qt = parseInt(oa.quote_transparency_star, 10);
  const pt = parseInt(oa.parts_traceability_star, 10);
  const res = parseInt(oa.repair_effect_star, 10);
  const svc = parseInt(oa.service_experience_star, 10);
  if (!Number.isNaN(proc) && proc >= 1 && proc <= 5) {
    a.push(`流程透明 ${proc} 星`);
  }
  if (!Number.isNaN(qt) && qt >= 1 && qt <= 5) {
    a.push(`报价透明 ${qt} 星`);
  }
  if (!Number.isNaN(res) && res >= 1 && res <= 5) {
    a.push(`整体修复 ${res} 星`);
  } else if (oa.fault_fix_effect) {
    a.push(V3_FAULT_SUMMARY[oa.fault_fix_effect] || '');
  }
  if (!Number.isNaN(pt) && pt >= 1 && pt <= 5) {
    a.push(`配件溯源 ${pt} 星`);
  }
  if (!Number.isNaN(svc) && svc >= 1 && svc <= 5) {
    a.push(`服务态度 ${svc} 星`);
  } else if (oa.overall_star != null) {
    a.push(`综合 ${oa.overall_star} 星`);
  }
  if (oa.parts_authenticity_check) a.push(V3_PARTS_SUMMARY[oa.parts_authenticity_check] || '');
  return a.filter(Boolean).join(' · ');
}

/**
 * 顶栏短标签（✅/⚠️/⭐；不含外观 AI，与对用户下发的 system_checks 口径一致）
 * @param {object} oa - objective_answers
 * @param {number|string} rating
 * @param {object|null} _systemChecks - 已脱敏的 review_system_checks（预留）
 */
function buildMinimalReviewTags(oa, rating, _systemChecks) {
  const tags = [];
  const v3 = isObjectiveAnswersV3(oa);
  if (v3) {
    const proc = parseInt(oa.process_transparency_star, 10);
    if (!Number.isNaN(proc) && proc >= 1 && proc <= 5) {
      tags.push({ text: `流程 ${proc}★`, kind: proc >= 4 ? 'ok' : proc <= 2 ? 'warn' : 'muted' });
    }
    const qt = parseInt(oa.quote_transparency_star, 10);
    if (!Number.isNaN(qt) && qt >= 1 && qt <= 5) {
      tags.push({ text: `报价 ${qt}★`, kind: qt >= 4 ? 'ok' : qt <= 2 ? 'warn' : 'muted' });
    }
    const res = parseInt(oa.repair_effect_star, 10);
    if (!Number.isNaN(res) && res >= 1 && res <= 5) {
      tags.push({ text: `修复 ${res}★`, kind: res >= 4 ? 'ok' : res <= 2 ? 'warn' : 'muted' });
    } else {
      const fe = oa.fault_fix_effect;
      if (fe === 'full') tags.push({ text: '✅ 已修好', kind: 'ok' });
      else if (fe === 'partial') tags.push({ text: '⚠️ 部分修好', kind: 'warn' });
      else if (fe === 'none') tags.push({ text: '⚠️ 未修好', kind: 'warn' });
    }
    const pt = parseInt(oa.parts_traceability_star, 10);
    if (!Number.isNaN(pt) && pt >= 1 && pt <= 5) {
      tags.push({ text: `配件 ${pt}★`, kind: pt >= 4 ? 'ok' : pt <= 2 ? 'warn' : 'muted' });
    } else {
      const pa = oa.parts_authenticity_check;
      if (pa === 'verified_ok') tags.push({ text: '✅ 配件一致', kind: 'ok' });
      else if (pa === 'mismatch') tags.push({ text: '⚠️ 配件不符', kind: 'warn' });
      else if (pa === 'not_verified') tags.push({ text: '配件未核验', kind: 'muted' });
    }
    const r = parseInt(rating, 10);
    if (!Number.isNaN(r) && r >= 1 && r <= 5) {
      tags.push({ text: '★'.repeat(r) + '☆'.repeat(5 - r), kind: 'star' });
    }
  }
  return tags;
}

function systemChecksHasPublicDetail(sc) {
  if (!sc || typeof sc !== 'object') return false;
  if (sc.quote_flow && Array.isArray(sc.quote_flow.nodes) && sc.quote_flow.nodes.length) return true;
  const pd = sc.parts_delivery;
  if (pd && typeof pd === 'object') {
    if (Array.isArray(pd.merchant_methods) && pd.merchant_methods.length) return true;
    if (pd.merchant_verify_note && String(pd.merchant_verify_note).trim()) return true;
    if (pd.status) return true;
  }
  for (const k of ['warranty', 'loss_vs_settlement']) {
    if (sc[k] && sc[k].status) return true;
  }
  return false;
}

/**
 * @param {object} r - 评价展示行
 * @param {boolean} hasObjectives
 * @param {Array} quoteProposalDisplay
 * @param {object} [review_system_checks]
 */
function computeHasExpandableEvidence(r, hasObjectives, quoteProposalDisplay, review_system_checks) {
  const imgCount = computeTotalImageCount(r);
  const { primaryBeforeThumb, primaryAfterThumb } = computePrimaryThumbs(r);
  const primarySlots = (primaryBeforeThumb ? 1 : 0) + (primaryAfterThumb ? 1 : 0);
  const moreImages = imgCount > primarySlots;

  if (systemChecksHasPublicDetail(review_system_checks)) return true;
  if ((r.repair_items || []).length) return true;
  if ((r.part_promise_lines || []).length) return true;
  if ((quoteProposalDisplay || []).length) return true;
  if (r.amountText) return true;
  if (hasObjectives) return true;
  if (moreImages) return true;
  if (imgCount > 0 && primarySlots === 0) return true;
  return false;
}

module.exports = {
  parseObjectiveBool,
  buildObjectiveSummary,
  computeTotalImageCount,
  computePrimaryThumbs,
  buildReviewDigestLine,
  computeHasExpandableEvidence,
  isObjectiveAnswersV3,
  buildV3ObjectiveSummary,
  buildMinimalReviewTags,
  systemChecksHasPublicDetail,
};
