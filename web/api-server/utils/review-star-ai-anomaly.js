/**
 * 评价星级 vs 系统/AI 归纳：自动矛盾检测，写入 review_system_checks.star_ai_anomaly（仅后台使用，公示 sanitize 不下发）
 * 阈值由 settings + getStarAiAnomalyConfig 提供，见 review-star-ai-anomaly-config.js
 */

const { mergeStarAiAnomalyConfig } = require('./review-star-ai-anomaly-config');

/** @deprecated 使用 getStarAiAnomalyConfig 返回值 */
const USER_LOW_MAX = 2;
/** @deprecated 使用 getStarAiAnomalyConfig 返回值 */
const USER_HIGH_MIN = 4;

/** @typedef {{ enabled: boolean, userLowMax: number, userHighMin: number, quotePctGoodMax: number, quotePctBadMin: number, repairGoodMin: number, repairBadMax: number }} StarAiAnomalyConfig */

function parseStar(v) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n < 1 || n > 5) return null;
  return n;
}

/** @returns {'good'|'bad'|'neutral'} */
function aiQuoteAssessment(qd, cfg) {
  if (!qd || typeof qd !== 'object' || qd.status !== 'ok') return 'neutral';
  const pct = qd.percent != null ? Number(qd.percent) : null;
  const level = qd.level;
  const g = cfg.quotePctGoodMax;
  const b = cfg.quotePctBadMin;
  if (level === 'low' || (pct != null && pct <= g)) return 'good';
  if (level === 'high' || (pct != null && pct > b)) return 'bad';
  return 'neutral';
}

/** 外观修复度：高分为 AI 正向，极低分为负向 */
function aiRepairAssessment(ap, cfg) {
  if (!ap || typeof ap !== 'object') return 'neutral';
  if (ap.status === 'pending' || ap.status === 'skipped' || ap.status === 'failed') return 'neutral';
  const p = ap.repair_degree_percent != null ? Number(ap.repair_degree_percent) : null;
  if (p != null && !Number.isNaN(p)) {
    if (p >= cfg.repairGoodMin) return 'good';
    if (p <= cfg.repairBadMax) return 'bad';
    return 'neutral';
  }
  return 'neutral';
}

/** 配件-方案：完全/基本匹配为正向，不匹配为负向 */
function aiPartsAssessment(pd) {
  if (!pd || typeof pd !== 'object') return 'neutral';
  const ml = pd.ai_match_level;
  if (ml === 'full_match' || ml === 'basic_match') return 'good';
  if (ml === 'mismatch') return 'bad';
  return 'neutral';
}

function pushAnomaly(items, dimension, label, userStar, aiAssess, detailWhenAiGood, detailWhenAiBad, cfg) {
  if (userStar == null || aiAssess === 'neutral') return;
  if (userStar <= cfg.userLowMax && aiAssess === 'good') {
    items.push({
      dimension,
      label,
      pattern: 'low_star_ai_positive',
      user_star: userStar,
      ai_side: 'positive',
      summary: `${label}：车主 ${userStar}★，系统/AI 侧为正向（${detailWhenAiGood}），与星级反差明显，建议人工查看。`,
    });
    return;
  }
  if (userStar >= cfg.userHighMin && aiAssess === 'bad') {
    items.push({
      dimension,
      label,
      pattern: 'high_star_ai_negative',
      user_star: userStar,
      ai_side: 'negative',
      summary: `${label}：车主 ${userStar}★，系统/AI 侧不利（${detailWhenAiBad}），与星级反差明显，建议人工查看。`,
    });
  }
}

function quoteDetailGood(qd) {
  if (!qd || qd.status !== 'ok') return '报价偏离度低/可接受';
  const pct = qd.percent != null ? `${qd.percent}%` : '';
  return [qd.label ? `偏离${qd.label}` : '', pct].filter(Boolean).join(' ') || '锁价与结算差异较小';
}

function quoteDetailBad(qd) {
  if (!qd || qd.status !== 'ok') return '报价偏离归纳不利';
  const pct = qd.percent != null ? `约 ${qd.percent}%` : '';
  return `偏离度高${pct ? `（${pct}）` : ''}`;
}

function repairDetailGood(ap) {
  const p = ap?.repair_degree_percent;
  return p != null ? `外观修复度约 ${p}%` : '外观归纳较好';
}

function repairDetailBad(ap) {
  const p = ap?.repair_degree_percent;
  return p != null ? `外观修复度约 ${p}%` : '外观归纳偏差';
}

function partsDetailGood(pd) {
  const ml = pd?.ai_match_level;
  if (ml === 'full_match') return '配件与方案完全匹配';
  if (ml === 'basic_match') return '配件与方案基本匹配';
  return '配件归纳正向';
}

function partsDetailBad(pd) {
  return pd?.ai_match_level === 'mismatch' ? '配件与方案不匹配' : '配件归纳不利';
}

/**
 * @param {object} m3 - module3 含 *_star
 * @param {object} systemChecks - buildInitialSystemChecksForOrder 结果
 * @param {StarAiAnomalyConfig} cfg
 * @returns {{ has_anomaly: boolean, flag: 0|1, items: object[], version: number, recorded_at: string } | null}
 */
function computeStarAiAnomaly(m3, systemChecks, cfg) {
  if (!m3 || !systemChecks || typeof systemChecks !== 'object') return null;
  const merged = mergeStarAiAnomalyConfig(cfg);

  const qStar = parseStar(m3.quote_transparency_star);
  const rStar = parseStar(m3.repair_effect_star);
  const pStar = parseStar(m3.parts_traceability_star);

  const items = [];
  const qd = systemChecks.quote_deviation;
  const ap = systemChecks.appearance;
  const pd = systemChecks.parts_delivery;

  pushAnomaly(
    items,
    'quote_transparency',
    '报价透明度',
    qStar,
    aiQuoteAssessment(qd, merged),
    quoteDetailGood(qd),
    quoteDetailBad(qd),
    merged
  );
  pushAnomaly(
    items,
    'repair_effect',
    '整体修复程度',
    rStar,
    aiRepairAssessment(ap, merged),
    repairDetailGood(ap),
    repairDetailBad(ap),
    merged
  );
  pushAnomaly(
    items,
    'parts_traceability',
    '配件可溯源度',
    pStar,
    aiPartsAssessment(pd),
    partsDetailGood(pd),
    partsDetailBad(pd),
    merged
  );

  const has = items.length > 0;
  return {
    has_anomaly: has,
    flag: has ? 1 : 0,
    version: 1,
    items,
    recorded_at: new Date().toISOString(),
  };
}

module.exports = {
  computeStarAiAnomaly,
  aiQuoteAssessment,
  aiRepairAssessment,
  USER_LOW_MAX,
  USER_HIGH_MIN,
};
