/**
 * 主评价客观题与星级联动（《重构评价体系》+ 现网 reviews 五维字段映射）
 * general：5 题；accident：6 题
 */

const GENERAL_KEYS = [
  'q_pay_match',
  'q_process_transparent',
  'q_parts_match_quote',
  'q_fault_resolved',
  'q_warranty_provided'
];

const ACCIDENT_KEYS = [
  'q_no_fraud_inducement',
  'q_loss_explained',
  'q_repair_matches_loss',
  'q_insurance_smooth',
  'q_fault_resolved',
  'q_warranty_provided'
];

/** 选「否」时最多 10 字说明的题（通用第 1 题） */
const PAY_MISMATCH_NOTE_MAX = 10;

function isInsuranceOrder(order) {
  return order && (order.is_insurance_accident === 1 || order.is_insurance_accident === '1');
}

function reviewScene(order) {
  return isInsuranceOrder(order) ? 'accident' : 'general';
}

function requiredKeysForScene(scene) {
  return scene === 'accident' ? [...ACCIDENT_KEYS] : [...GENERAL_KEYS];
}

/**
 * 根据客观题计算各星级维度上限（1–5），键为 API 用的 price/quality/parts/speed/service
 */
function computeRatingMaxByAnswers(scene, answers) {
  const a = answers || {};
  const max = { price: 5, quality: 5, parts: 5, speed: 5, service: 5 };
  if (scene === 'general') {
    if (a.q_pay_match === false) max.price = Math.min(max.price, 2);
    if (a.q_process_transparent === false || a.q_warranty_provided === false) max.speed = Math.min(max.speed, 2);
    if (a.q_parts_match_quote === false) max.parts = Math.min(max.parts, 2);
    if (a.q_fault_resolved === false) max.quality = Math.min(max.quality, 2);
  } else {
    if (a.q_no_fraud_inducement === false) {
      max.quality = Math.min(max.quality, 2);
      max.parts = Math.min(max.parts, 2);
    }
    if (a.q_loss_explained === false) max.quality = Math.min(max.quality, 2);
    if (a.q_repair_matches_loss === false) max.parts = Math.min(max.parts, 2);
    if (a.q_insurance_smooth === false) max.service = Math.min(max.service, 2);
    if (a.q_fault_resolved === false) max.quality = Math.min(max.quality, 2);
    if (a.q_warranty_provided === false) max.speed = Math.min(max.speed, 2);
  }
  return max;
}

/**
 * 将前端 ratings 按上限裁剪，并保证 general 场景 service 有值（沿用 speed）
 */
function clampRatings(scene, ratingsIn, answers) {
  const caps = computeRatingMaxByAnswers(scene, answers);
  const r = { ...(ratingsIn || {}) };
  const clamp = (k) => {
    const v = parseInt(r[k], 10);
    const c = caps[k] != null ? caps[k] : 5;
    if (Number.isNaN(v) || v < 1) return null;
    return Math.min(v, c);
  };
  const out = {
    price: clamp('price'),
    quality: clamp('quality'),
    parts: clamp('parts'),
    speed: clamp('speed'),
    service: clamp('service')
  };
  if (scene === 'general') {
    if (out.service == null && out.speed != null) out.service = out.speed;
    if (out.speed == null && out.service != null) out.speed = out.service;
  }
  return out;
}

/**
 * 校验客观题完整性与第 1 题说明
 */
function validateObjectiveAnswers(scene, m3) {
  const keys = requiredKeysForScene(scene);
  for (const k of keys) {
    if (m3[k] === undefined || m3[k] === null) {
      return { ok: false, error: '请完成全部必答客观题' };
    }
  }
  if (scene === 'general' && m3.q_pay_match === false) {
    const note = String(m3.q_pay_mismatch_note || '').trim();
    if (!note.length || note.length > PAY_MISMATCH_NOTE_MAX) {
      return { ok: false, error: `第 1 题选「否」时，请填写 ${PAY_MISMATCH_NOTE_MAX} 字以内说明` };
    }
  }
  return { ok: true };
}

/**
 * 从旧版 3 题映射到新键（过渡兼容，仅当新键全空时）
 */
function legacyMergeObjectives(m3) {
  const out = { ...m3 };
  const hasNew = GENERAL_KEYS.some((k) => out[k] !== undefined && out[k] !== null);
  if (hasNew) return out;
  if (out.q1_progress_synced != null) {
    out.q_process_transparent = out.q1_progress_synced;
  }
  if (out.q2_parts_shown != null) {
    out.q_parts_match_quote = out.q2_parts_shown;
  }
  if (out.q3_fault_resolved != null) {
    out.q_fault_resolved = out.q3_fault_resolved;
  }
  return out;
}

function buildObjectiveAnswersPayload(scene, m3) {
  const keys = requiredKeysForScene(scene);
  const obj = { scene, version: 2 };
  for (const k of keys) {
    obj[k] = m3[k];
  }
  if (scene === 'general' && m3.q_pay_match === false && m3.q_pay_mismatch_note) {
    obj.q_pay_mismatch_note = String(m3.q_pay_mismatch_note).trim();
  }
  return obj;
}

/**
 * 用于商户申诉：哪些题选否
 */
function falseObjectiveKeysForAppeals(scene, m3) {
  const keys = requiredKeysForScene(scene);
  return keys.filter((k) => m3[k] === false);
}

const QUESTION_LABELS = {
  q_pay_match: '最终支付金额是否与系统结算金额一致',
  q_process_transparent: '维修过程是否按规则同步核心节点记录/录像',
  q_parts_match_quote: '更换配件是否与报价承诺一致',
  q_fault_resolved: '报修故障是否完全解决、无新增问题',
  q_warranty_provided: '是否在订单方案/报价明细中提供明确分项质保约定（质保月数，店端作出）',
  q_no_fraud_inducement: '商家是否无诱导虚增定损/过度维修返现',
  q_loss_explained: '定损方案与维修明细是否充分解释并获您确认',
  q_repair_matches_loss: '最终维修是否与确认的定损方案一致',
  q_insurance_smooth: '是否配合保险定损理赔、无不合理垫付'
};

const PENALTIES = {
  q_pay_match: 20,
  q_process_transparent: 5,
  q_parts_match_quote: 15,
  q_fault_resolved: 0,
  q_warranty_provided: 5,
  q_no_fraud_inducement: 30,
  q_loss_explained: 10,
  q_repair_matches_loss: 15,
  q_insurance_smooth: 10
};

/** 入库用：未填星视为 5，再按客观题封顶 */
function finalizeRatingsForDb(scene, ratingsIn, answers) {
  const caps = computeRatingMaxByAnswers(scene, answers);
  const pick = (k) => {
    const raw = ratingsIn && ratingsIn[k];
    let v = parseInt(raw, 10);
    if (Number.isNaN(v) || v < 1) v = 5;
    const cap = caps[k] != null ? caps[k] : 5;
    return Math.min(Math.max(v, 1), cap);
  };
  let price = pick('price');
  let quality = pick('quality');
  let parts = pick('parts');
  let speed = pick('speed');
  let service = pick('service');
  if (scene === 'general') {
    const rawS = ratingsIn && ratingsIn.service;
    const rawSp = ratingsIn && ratingsIn.speed;
    if (rawS == null || Number.isNaN(parseInt(rawS, 10))) service = speed;
    if (rawSp == null || Number.isNaN(parseInt(rawSp, 10))) speed = service;
  }
  return { price, quality, parts, speed, service };
}

function averageRatingValue(ratingsObj) {
  if (!ratingsObj || typeof ratingsObj !== 'object') return 5;
  const vals = [ratingsObj.price, ratingsObj.quality, ratingsObj.parts, ratingsObj.speed, ratingsObj.service]
    .map((x) => parseInt(x, 10))
    .filter((n) => !Number.isNaN(n) && n >= 1);
  if (!vals.length) return 5;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/** ---------- 极简评价 v3（双星 + 配件核验；兼容历史 fault_fix_effect + overall_star） ---------- */
const V3_FAULT_EFFECTS = new Set(['full', 'partial', 'none']);
const V3_PARTS_AUTH = new Set(['verified_ok', 'not_verified', 'mismatch']);
const V3_OWNER_VERIFY = new Set(['verified_match', 'verified_mismatch', 'skipped']);

function star15(v) {
  const n = parseInt(v, 10);
  return !Number.isNaN(n) && n >= 1 && n <= 5 ? n : NaN;
}

/** 五星序表单：报价透明度、配件溯源、整体修复、服务态度 */
function hasV3FiveStarAnswers(m3) {
  const q = star15(m3?.quote_transparency_star);
  const p = star15(m3?.parts_traceability_star);
  const r = star15(m3?.repair_effect_star);
  const s = star15(m3?.service_experience_star);
  return !Number.isNaN(q) && !Number.isNaN(p) && !Number.isNaN(r) && !Number.isNaN(s);
}

function validateObjectiveAnswersV3(m3) {
  const resStar = star15(m3?.repair_effect_star);
  const svcStar = star15(m3?.service_experience_star);
  const hasFive = hasV3FiveStarAnswers(m3);

  if (hasFive) {
    const ovr = m3?.owner_verify_result;
    if (ovr != null && ovr !== '' && !V3_OWNER_VERIFY.has(ovr)) {
      return { ok: false, error: '验真结果选项无效' };
    }
    return { ok: true };
  }

  const parts = m3?.parts_authenticity_check;
  if (!V3_PARTS_AUTH.has(parts)) {
    return { ok: false, error: '请选择配件正品核验情况' };
  }
  const hasNew =
    !Number.isNaN(resStar) &&
    resStar >= 1 &&
    resStar <= 5 &&
    !Number.isNaN(svcStar) &&
    svcStar >= 1 &&
    svcStar <= 5;
  const legacyFault = m3?.fault_fix_effect;
  const legacyStar = parseInt(m3?.overall_star ?? m3?.overall_rating, 10);
  const hasLegacy =
    V3_FAULT_EFFECTS.has(legacyFault) &&
    !Number.isNaN(legacyStar) &&
    legacyStar >= 1 &&
    legacyStar <= 5;
  if (!hasNew && !hasLegacy) {
    return { ok: false, error: '请完成故障修复效果与服务体验星级（各 1～5 星）' };
  }
  const ovr = m3?.owner_verify_result;
  if (ovr != null && ovr !== '' && !V3_OWNER_VERIFY.has(ovr)) {
    return { ok: false, error: '验真结果选项无效' };
  }
  return { ok: true };
}

function buildObjectiveAnswersPayloadV3(order, m3) {
  const scene = reviewScene(order);
  const resStar = parseInt(m3.repair_effect_star, 10);
  const svcStar = parseInt(m3.service_experience_star, 10);
  const hasFive = hasV3FiveStarAnswers(m3);
  const hasNew =
    !Number.isNaN(resStar) &&
    resStar >= 1 &&
    resStar <= 5 &&
    !Number.isNaN(svcStar) &&
    svcStar >= 1 &&
    svcStar <= 5;
  if (hasFive) {
    const out = {
      version: 3,
      v3_form: 'five_star',
      scene,
      quote_transparency_star: star15(m3.quote_transparency_star),
      parts_traceability_star: star15(m3.parts_traceability_star),
      repair_effect_star: resStar,
      service_experience_star: svcStar,
    };
    if (m3.parts_authenticity_check && V3_PARTS_AUTH.has(m3.parts_authenticity_check)) {
      out.parts_authenticity_check = m3.parts_authenticity_check;
    }
    if (m3.owner_verify_result && V3_OWNER_VERIFY.has(m3.owner_verify_result)) {
      out.owner_verify_result = m3.owner_verify_result;
    }
    if (Array.isArray(m3.owner_always_public_urls) && m3.owner_always_public_urls.length) {
      out.owner_always_public_urls = m3.owner_always_public_urls.map((u) => String(u || '').trim()).filter(Boolean);
    }
    return out;
  }
  if (hasNew) {
    const out = {
      version: 3,
      scene,
      repair_effect_star: resStar,
      service_experience_star: svcStar,
      parts_authenticity_check: m3.parts_authenticity_check,
    };
    if (m3.owner_verify_result && V3_OWNER_VERIFY.has(m3.owner_verify_result)) {
      out.owner_verify_result = m3.owner_verify_result;
    }
    if (Array.isArray(m3.owner_always_public_urls) && m3.owner_always_public_urls.length) {
      out.owner_always_public_urls = m3.owner_always_public_urls.map((u) => String(u || '').trim()).filter(Boolean);
    }
    return out;
  }
  return {
    version: 3,
    scene,
    fault_fix_effect: m3.fault_fix_effect,
    parts_authenticity_check: m3.parts_authenticity_check,
    overall_star: parseInt(m3.overall_star, 10),
  };
}

/** v3 → 商户申诉用键（映射到既有 question_key 语义） */
function falseObjectiveKeysForAppealsV3(m3) {
  const keys = [];
  const resStar = parseInt(m3?.repair_effect_star, 10);
  const quoteStar = parseInt(m3?.quote_transparency_star, 10);
  const partsStar = parseInt(m3?.parts_traceability_star, 10);
  if (!Number.isNaN(resStar) && resStar <= 2) keys.push('q_fault_resolved');
  else if (m3?.fault_fix_effect === 'none') keys.push('q_fault_resolved');
  if (!Number.isNaN(quoteStar) && quoteStar <= 2) keys.push('q_process_transparent');
  if (!Number.isNaN(partsStar) && partsStar <= 2) keys.push('q_parts_match_quote');
  if (m3?.parts_authenticity_check === 'mismatch') keys.push('q_parts_match_quote');
  return [...new Set(keys)];
}

function flattenObjectivesForStorage(scene, m3) {
  const keys = [
    ...GENERAL_KEYS,
    ...ACCIDENT_KEYS.filter((k) => !GENERAL_KEYS.includes(k)),
    'q1_progress_synced',
    'q2_parts_shown',
    'q3_fault_resolved'
  ];
  const o = { scene, version: 2 };
  for (const k of keys) {
    if (m3[k] !== undefined && m3[k] !== null) o[k] = m3[k];
  }
  if (m3.q_pay_mismatch_note) o.q_pay_mismatch_note = String(m3.q_pay_mismatch_note).trim();
  return o;
}

module.exports = {
  GENERAL_KEYS,
  ACCIDENT_KEYS,
  PAY_MISMATCH_NOTE_MAX,
  isInsuranceOrder,
  reviewScene,
  requiredKeysForScene,
  computeRatingMaxByAnswers,
  clampRatings,
  finalizeRatingsForDb,
  averageRatingValue,
  validateObjectiveAnswers,
  legacyMergeObjectives,
  buildObjectiveAnswersPayload,
  flattenObjectivesForStorage,
  falseObjectiveKeysForAppeals,
  QUESTION_LABELS,
  PENALTIES,
  validateObjectiveAnswersV3,
  buildObjectiveAnswersPayloadV3,
  falseObjectiveKeysForAppealsV3,
  hasV3FiveStarAnswers,
};
