/**
 * 公示/列表：极简 v3 评价卡与提交页「请您评价」块对齐（只读星 + 前 3 维折叠留痕图）
 */

function parseStar15(v) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n < 1 || n > 5) return 0;
  return n;
}

function amountEqualForQuote(a, b) {
  if (a == null || b == null || a === '' || b === '') return false;
  const x = Number(a);
  const y = Number(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return false;
  return Math.abs(x - y) < 0.005;
}

function isSettlementQuoteNode(n) {
  const lab = String(n.display_round_label || '');
  const st = String(n.status_text || '');
  return lab.indexOf('结算') >= 0 || st.indexOf('最终结算') >= 0;
}

/**
 * 与提交页 buildQuoteDisplayNodes 一致
 * @param {Array} rawNodes - review_system_checks.quote_flow.nodes
 */
function buildQuoteDisplayNodes(rawNodes) {
  const nodes = Array.isArray(rawNodes) ? rawNodes.map((n) => ({ ...n })) : [];
  if (!nodes.length) return [];

  const last = nodes[nodes.length - 1];
  const settlementLast = isSettlementQuoteNode(last);
  const nums = nodes.map((n) => {
    if (n.amount == null || n.amount === '') return null;
    const x = Number(n.amount);
    return Number.isNaN(x) ? null : x;
  });
  const allNumsOk = nums.every((x) => x != null);
  const allSamePrice =
    settlementLast &&
    nodes.length >= 2 &&
    allNumsOk &&
    nums.every((x) => amountEqualForQuote(x, nums[nums.length - 1]));

  if (allSamePrice) {
    return [
      {
        ...last,
        short_label: '最终结算',
        change_note: nodes.length === 2 ? '与预报价金额一致' : '历次报价与结算金额一致',
      },
    ];
  }

  const out = [];
  const len = nodes.length;
  for (let i = 0; i < len; i++) {
    const n = nodes[i];
    const isLast = i === len - 1 && settlementLast;
    let short_label;
    if (isLast) short_label = '最终结算';
    else if (i === 0) short_label = '预报价';
    else if (i === 1) short_label = '二次报价';
    else if (i === 2) short_label = '三次报价';
    else short_label = `${i + 1}次报价`;
    out.push({ ...n, short_label });
  }
  return out;
}

function isV3FiveStarLayout(oa) {
  if (!oa || typeof oa !== 'object' || oa.version !== 3 || oa.v3_form !== 'five_star') return false;
  return (
    parseStar15(oa.quote_transparency_star) > 0 &&
    parseStar15(oa.parts_traceability_star) > 0 &&
    parseStar15(oa.repair_effect_star) > 0 &&
    parseStar15(oa.service_experience_star) > 0
  );
}

/**
 * @param {object} row - 已映射的评价行（含 objective_answers、systemChecks、quote_credential_urls 等）
 */
function enrichReviewV3PublicCard(row) {
  const oa = row.objective_answers || {};
  const v3SubmitLayout = isV3FiveStarLayout(oa);
  const base = {
    ...row,
    v3SubmitLayout,
    pubExpand: { quote: false, repair: false, parts: false },
  };
  if (!v3SubmitLayout) return base;
  const sc = row.systemChecks || null;
  const nodes = sc && sc.quote_flow && Array.isArray(sc.quote_flow.nodes) ? sc.quote_flow.nodes : [];
  const cred = Array.isArray(row.quote_credential_urls)
    ? row.quote_credential_urls.map((u) => String(u || '').trim()).filter(Boolean)
    : [];
  return {
    ...base,
    pubQuoteStar: parseStar15(oa.quote_transparency_star),
    pubRepairStar: parseStar15(oa.repair_effect_star),
    pubPartsStar: parseStar15(oa.parts_traceability_star),
    pubServiceStar: parseStar15(oa.service_experience_star),
    pubQuoteDisplayNodes: buildQuoteDisplayNodes(nodes),
    pubQuoteCredentialUrls: cred,
  };
}

module.exports = {
  buildQuoteDisplayNodes,
  enrichReviewV3PublicCard,
  isV3FiveStarLayout,
  parseStar15,
};
