/**
 * 极简评价 v3：系统侧报价流程节点（无合规结论）+ 外观修复度等占位
 * 供 for-review 预计算、submit 入库、公示下发
 */

const orderQuoteProposalService = require('./order-quote-proposal-service');
const quoteProposalPublic = require('../utils/quote-proposal-public-list');

/**
 * 将 orders.completion_evidence.exterior_repair_analysis 映射为评价页 system_checks.appearance
 */
function appearanceFromExteriorRepairAnalysis(completionEvidence, appearanceDisclaimer) {
  const ext = completionEvidence && completionEvidence.exterior_repair_analysis;
  if (!ext || typeof ext !== 'object') return null;
  const st = String(ext.status || '').trim();
  const pctRaw = ext.repair_degree_percent;
  const pct = pctRaw != null && !Number.isNaN(Number(pctRaw)) ? Math.max(0, Math.min(100, Number(pctRaw))) : null;
  const note = ext.note ? String(ext.note).trim() : '';
  const analysisText = ext.analysis_text ? String(ext.analysis_text).trim() : note || null;

  if (st === 'skipped' || st === 'failed') {
    return {
      status: st,
      repair_degree_percent: pct,
      note: note || (st === 'skipped' ? '外观对比分析跳过' : '外观对比分析失败'),
      analysis_text: analysisText,
      ai_disclaimer: appearanceDisclaimer,
      analyzed_at: ext.analyzed_at || null,
      model_version: ext.model || null,
    };
  }
  if (st === 'ok' || st === 'uncertain' || st === 'heuristic') {
    return {
      status: pct != null ? 'ok' : 'uncertain',
      repair_degree_percent: pct,
      note: note || null,
      analysis_text: analysisText,
      ai_disclaimer: appearanceDisclaimer,
      analyzed_at: ext.analyzed_at || null,
      model_version: ext.model || null,
      confidence: ext.confidence || null,
    };
  }
  if (pct != null || note) {
    return {
      status: pct != null ? 'ok' : 'uncertain',
      repair_degree_percent: pct,
      note: note || null,
      analysis_text: analysisText,
      ai_disclaimer: appearanceDisclaimer,
      analyzed_at: ext.analyzed_at || null,
      model_version: ext.model || null,
      confidence: ext.confidence || null,
    };
  }
  return null;
}

function parseJson(v, fb = null) {
  if (v == null || v === '') return fb;
  try {
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch (_) {
    return fb;
  }
}

function fmtAmount(a) {
  if (a == null || a === '') return null;
  const n = parseFloat(a);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

function itemSignature(it) {
  if (!it || typeof it !== 'object') return '';
  const name = String(it.name || it.damage_part || '').trim();
  const rt = String(it.repair_type || '').trim();
  return name || rt ? `${name}|${rt}` : '';
}

function summarizeItemsDelta(prevItems, nextItems) {
  const prev = new Set((prevItems || []).map(itemSignature).filter(Boolean));
  const next = new Set((nextItems || []).map(itemSignature).filter(Boolean));
  const added = [...next].filter((x) => !prev.has(x)).length;
  const removed = [...prev].filter((x) => !next.has(x)).length;
  if (!added && !removed) return null;
  const parts = [];
  if (added) parts.push(`报价项目较上一轮新增约 ${added} 项`);
  if (removed) parts.push(`减少约 ${removed} 项`);
  return parts.join('；') + '（明细以订单过程为准）';
}

/** 与报价节点展示一致：订单未写入最终结算时，不视为「缺数据」 */
function orderActualAmountUnset(order) {
  const v = order && order.actual_amount;
  return v == null || v === '' || (typeof v === 'string' && !String(v).trim());
}

/**
 * 从到店报价记录兜底锁价金额（orders.quoted_amount 异常时）
 * @param {Array} proposalHistoryFormatted - listFormatted（可含首部合成预报价）
 */
function lastNonEmptyProposalAmount(proposalHistoryFormatted) {
  const list = Array.isArray(proposalHistoryFormatted) ? proposalHistoryFormatted : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (!p || typeof p !== 'object') continue;
    const snap = p.quote_snapshot && typeof p.quote_snapshot === 'object' ? p.quote_snapshot : {};
    const a = fmtAmount(snap.amount);
    if (a != null && a > 0) return a;
  }
  return null;
}

const QUOTE_DEVIATION_SCOPE_NOTE =
  '本指标为锁价（或订单确认的等效金额）与最终结算的相对差异，非店铺历史报价偏差率，也不表示平台认定商家恶意或虚假报价。' +
  ' 拆检后若发现照片未覆盖的内部/结构性损伤、隐性故障或合理增项，在事先或事中说明清楚的前提下，结算高于预报价可能是正常情况；请结合沟通记录、方案变更与车主评价综合判断，勿仅凭百分比下结论。';

/**
 * 锁价（quoted_amount）与结算（actual_amount）相对差异，供展示「报价偏离度」
 * 与 buildQuoteFlowFromOrder 一致：actual_amount 未落库时按与锁价相同处理（偏离 0%）。
 */
function buildQuoteDeviationForOrder(order, proposalHistoryFormatted) {
  let quoted = fmtAmount(order.quoted_amount);
  if (quoted == null || quoted <= 0) {
    const fallback = lastNonEmptyProposalAmount(proposalHistoryFormatted);
    if (fallback != null) quoted = fallback;
  }

  let actual = fmtAmount(order.actual_amount);
  let settlementInferred = false;
  if (quoted != null && quoted > 0 && (actual == null || orderActualAmountUnset(order))) {
    actual = quoted;
    settlementInferred = true;
  }

  if (quoted == null || quoted <= 0) {
    return {
      status: 'unavailable',
      label: '—',
      level: null,
      percent: null,
      note: '订单侧锁价/确认金额缺失，无法计算本单偏离度',
      scope_note: QUOTE_DEVIATION_SCOPE_NOTE,
    };
  }
  if (actual == null) {
    return {
      status: 'unavailable',
      label: '—',
      level: null,
      percent: null,
      note: '结算金额无法确定，无法计算本单偏离度',
      scope_note: QUOTE_DEVIATION_SCOPE_NOTE,
    };
  }

  const pct = Math.round((Math.abs(actual - quoted) / quoted) * 1000) / 10;
  let level = 'low';
  if (pct > 15) level = 'high';
  else if (pct > 5) level = 'mid';
  const label = pct <= 5 ? '低' : pct <= 15 ? '中' : '高';
  let note = `锁价 ¥${quoted.toFixed(2)} 与结算 ¥${actual.toFixed(2)} 相对差异约 ${pct}%`;
  if (settlementInferred) {
    note += '（订单未单独记录最终结算金额，已与报价节点展示一致按锁价处理，故偏离为 0%）';
  }
  return {
    status: 'ok',
    label,
    level,
    percent: pct,
    note,
    scope_note: QUOTE_DEVIATION_SCOPE_NOTE,
  };
}

/** 配件-方案 AI 匹配度 → 车主端短文案（完整推理仅存 orders.completion_evidence.parts_traceability_ai.analysis_process） */
const PARTS_MATCH_LABEL = {
  full_match: '完全匹配',
  basic_match: '基本匹配',
  mismatch: '不匹配',
};

function buildPartsAiDisplayLine(level, userConclusion, mismatchReasons) {
  const lb = (level && PARTS_MATCH_LABEL[level]) || '待确认';
  let line = `AI校验结果：配件与维修项目${lb}`;
  const uc = String(userConclusion || '').trim();
  if (uc) line += `（${uc.slice(0, 36)}）`;
  if (level === 'mismatch' && Array.isArray(mismatchReasons) && mismatchReasons.length) {
    line += `。原因：${mismatchReasons.slice(0, 4).join('；')}`;
  }
  return line;
}

/**
 * 将 completion_evidence.parts_traceability_ai 合并进 parts_delivery（不下发 analysis_process）
 */
function mergePartsTraceabilityAiIntoPartsDelivery(heuristic, partsAiRaw) {
  if (!partsAiRaw || typeof partsAiRaw !== 'object') return heuristic;
  const st = String(partsAiRaw.status || '').trim();

  if (st === 'skipped' || st === 'failed') {
    return {
      ...heuristic,
      parts_ai_status: st,
      ai_match_level: null,
      ai_display_line: null,
      user_conclusion: null,
      mismatch_reasons: [],
    };
  }

  const level = partsAiRaw.match_level;
  if (!level || !PARTS_MATCH_LABEL[level]) {
    return heuristic;
  }

  const userConclusion = String(partsAiRaw.user_conclusion || '').trim();
  const mismatch_reasons = Array.isArray(partsAiRaw.mismatch_reasons)
    ? partsAiRaw.mismatch_reasons.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
    : [];

  return {
    ...heuristic,
    status: 'ai',
    parts_ai_status: 'ok',
    ai_match_level: level,
    user_conclusion: userConclusion || null,
    mismatch_reasons: level === 'mismatch' ? mismatch_reasons : [],
    coverage_summary: userConclusion || PARTS_MATCH_LABEL[level],
    missing_hints: [],
    ai_display_line: buildPartsAiDisplayLine(level, userConclusion, mismatch_reasons),
  };
}

/**
 * 基于完工凭证的规则化配件材料说明（非视觉模型），可与 AI 结果合并
 */
function buildPartsDeliveryHeuristicOnly(order, repairItemCount, completionEvidence) {
  const disclaimer = '以下配件材料描述由系统自动归纳，仅供参考，不构成鉴定结论。';
  const ev = completionEvidence && typeof completionEvidence === 'object' ? completionEvidence : {};
  const mat = Array.isArray(ev.material_photos) ? ev.material_photos.filter(Boolean).length : 0;
  const pv = ev.parts_verification && typeof ev.parts_verification === 'object' ? ev.parts_verification : {};
  const methods = Array.isArray(pv.methods) ? pv.methods.filter(Boolean) : [];
  const notProvided = pv.not_provided === true;

  const missing_hints = [];
  let coverage_summary = '';
  if (mat < 1) {
    coverage_summary = '订单完工凭证中未见店端配件/物料照片记录。';
  } else if (!repairItemCount || repairItemCount <= 1) {
    coverage_summary = `店端上传配件/物料照片 ${mat} 张，可与维修方案对照阅读。`;
  } else {
    coverage_summary = `店端上传配件/物料照片 ${mat} 张；方案含约 ${repairItemCount} 个维修项，建议在店方指引下逐项核对。`;
    if (mat < Math.min(repairItemCount, 3)) {
      missing_hints.push('照片数量相对维修项可能偏少，或未分项留档');
    }
  }

  let verify_hint = '';
  if (notProvided) {
    verify_hint = '服务商勾选「未提供验真方式说明」。';
  } else if (methods.length) {
    verify_hint = '服务商已填写验真方式，可按其指引自行验真。';
  } else {
    verify_hint = '建议向商户确认配件验真方式（官网、防伪码等）。';
  }

  return {
    status: 'heuristic',
    coverage_summary,
    missing_hints,
    verify_hint,
    merchant_methods: methods,
    merchant_verify_note: pv.note ? String(pv.note).slice(0, 200) : '',
    disclaimer,
    parts_ai_status: null,
    ai_match_level: null,
    ai_display_line: null,
    user_conclusion: null,
    mismatch_reasons: [],
  };
}

function buildPartsDeliverySnapshot(order, repairItemCount, completionEvidence) {
  const h = buildPartsDeliveryHeuristicOnly(order, repairItemCount, completionEvidence);
  return mergePartsTraceabilityAiIntoPartsDelivery(h, completionEvidence?.parts_traceability_ai);
}

/**
 * 报价流程节点：仅事实与节点说明，不下发「合规/不合规」结论
 * @param {object} order - orders 行
 * @param {Array} proposalHistoryFormatted - listFormatted + 可选已 prepend 预报价
 * @returns {{ quote_flow: object }}
 */
function buildQuoteFlowFromOrder(order, proposalHistoryFormatted) {
  const list = Array.isArray(proposalHistoryFormatted) ? proposalHistoryFormatted : [];
  const nodes = [];
  let idx = 0;
  let prevItems = null;
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const snap = p.quote_snapshot && typeof p.quote_snapshot === 'object' ? p.quote_snapshot : {};
    const amt = fmtAmount(snap.amount);
    const items = Array.isArray(snap.items) ? snap.items : [];
    let change_note = p.is_synthetic_pre_quote
      ? '选厂/确认阶段的报价快照'
      : '到店报价记录';
    if (p.revision_no > 0 && prevItems != null) {
      const delta = summarizeItemsDelta(prevItems, items);
      if (delta) change_note = delta;
      else if (p.revision_no > 1) change_note = '到店后协商调整报价（具体原因以订单过程为准）';
    } else if (p.revision_no > 1) {
      change_note = '到店后协商调整报价（具体原因以订单过程为准）';
    }
    prevItems = items.length ? items : prevItems;
    nodes.push({
      index: idx++,
      revision_no: p.revision_no,
      display_round_label: p.display_round_label || `第 ${p.revision_no || idx} 轮`,
      amount: amt,
      submitted_at: p.submitted_at || null,
      status_text: p.status_text || '',
      change_note,
    });
  }
  const actual = fmtAmount(order.actual_amount);
  const quoted = fmtAmount(order.quoted_amount);
  if (actual != null || quoted != null) {
    nodes.push({
      index: idx,
      revision_no: null,
      display_round_label: '订单结算',
      amount: actual != null ? actual : quoted,
      submitted_at: order.completed_at || null,
      status_text: '最终结算',
      change_note: '以订单实际结算金额为准',
    });
  }

  const amounts = nodes.map((n) => (n.amount != null ? n.amount : null));
  const chart_spec = {
    type: 'line_step',
    labels: nodes.map((n) => n.display_round_label),
    values: amounts,
    x: nodes.map((_, i) => i),
    y: amounts,
  };

  return {
    quote_flow: {
      disclaimer: '以下为订单内记录的报价与结算节点，供对照；平台不对是否加价作出结论，请结合车主评价与实拍综合判断。',
      nodes,
      chart_spec,
    },
  };
}

/**
 * @param {object} pool
 * @param {string} orderId
 * @returns {Promise<object>} 完整 review_system_checks 初始对象（含二期 pending）
 */
async function buildInitialSystemChecksForOrder(pool, orderId) {
  const [rows] = await pool.execute('SELECT * FROM orders WHERE order_id = ?', [orderId]);
  if (!rows.length) {
    return {
      quote_flow: null,
      appearance: { status: 'no_order' },
      parts_delivery: { status: 'pending' },
      warranty: { status: 'pending' },
      loss_vs_settlement: { status: 'pending' },
    };
  }
  const order = rows[0];
  let proposalHistory = [];
  try {
    if (await orderQuoteProposalService.proposalsTableExists(pool)) {
      proposalHistory = await orderQuoteProposalService.listFormatted(pool, orderId);
    }
  } catch (_) {}
  const preQuotePlan = parseJson(order.pre_quote_snapshot, null);
  let quotePlan = null;
  if (order.bidding_id || order.quote_id) {
    try {
      const [quotes] = await pool.execute(
        order.quote_id
          ? 'SELECT items, value_added_services, amount, duration FROM quotes WHERE quote_id = ?'
          : 'SELECT items, value_added_services, amount, duration FROM quotes WHERE bidding_id = ? AND shop_id = ? LIMIT 1',
        order.quote_id ? [order.quote_id] : [order.bidding_id, order.shop_id]
      );
      if (quotes.length > 0) {
        const q = quotes[0];
        quotePlan = {
          items: parseJson(q.items, []),
          value_added_services: parseJson(q.value_added_services, []),
          amount: q.amount,
          duration: q.duration,
        };
      }
    } catch (_) {}
  }
  const prePlanForPublic = quoteProposalPublic.planHasDisplayablePreQuote(preQuotePlan) ? preQuotePlan : quotePlan;
  proposalHistory = quoteProposalPublic.prependPreQuoteProposalToList(
    proposalHistory,
    prePlanForPublic,
    order.accepted_at
  );

  const qf = buildQuoteFlowFromOrder(order, proposalHistory);

  const isInsurance =
    order.is_insurance_accident === 1 || order.is_insurance_accident === '1';

  let completionEvidence = null;
  if (order.completion_evidence) {
    try {
      completionEvidence =
        typeof order.completion_evidence === 'string'
          ? JSON.parse(order.completion_evidence)
          : order.completion_evidence;
    } catch (_) {}
  }
  const quoteItemCount = Array.isArray(quotePlan?.items) ? quotePlan.items.length : 0;
  let repairItemCount = quoteItemCount;
  if (order.repair_plan) {
    try {
      const rp =
        typeof order.repair_plan === 'string' ? JSON.parse(order.repair_plan || '{}') : order.repair_plan;
      if (Array.isArray(rp?.items) && rp.items.length) repairItemCount = rp.items.length;
    } catch (_) {}
  }

  const appearanceDisclaimer = '以下外观分析由 AI 生成，仅供参考，不构成鉴定结论。';
  const partsSnap = buildPartsDeliverySnapshot(order, repairItemCount, completionEvidence);

  const appearanceFromEvidence = appearanceFromExteriorRepairAnalysis(completionEvidence, appearanceDisclaimer);
  const appearanceBlock = appearanceFromEvidence || {
    status: 'pending',
    repair_degree_percent: null,
    note: '服务商提交完工凭证后系统将对比维修前/后图生成外观修复度；若尚未落库，请稍后刷新或结合实拍自行判断。',
    analysis_text: null,
    ai_disclaimer: appearanceDisclaimer,
  };

  return {
    ...qf,
    quote_deviation: buildQuoteDeviationForOrder(order, proposalHistory),
    appearance: appearanceBlock,
    parts_delivery: partsSnap,
    warranty: { status: 'pending' },
    loss_vs_settlement: isInsurance ? { status: 'pending' } : { status: 'skipped', reason: '非事故车订单' },
  };
}

module.exports = {
  buildQuoteFlowFromOrder,
  buildInitialSystemChecksForOrder,
  buildQuoteDeviationForOrder,
  buildPartsDeliverySnapshot,
  buildPartsDeliveryHeuristicOnly,
  mergePartsTraceabilityAiIntoPartsDelivery,
  appearanceFromExteriorRepairAnalysis,
};
