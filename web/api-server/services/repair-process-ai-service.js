/**
 * 订单进入待验收后：聚合里程碑 + 完工凭证，写入 orders.repair_process_ai（MVP：规则摘要 + 可选千问文本归纳）
 */

const crypto = require('crypto');
const { hasColumn } = require('../utils/db-utils');
const repairMilestoneService = require('./repair-milestone-service');
const { callQwenText } = require('../qwen-analyzer');

const REPAIR_PROCESS_AI_SYSTEM = `你是汽车维修流程稽核助手。只根据给定的结构化事实（节点数量、照片张数、凭证类型计数）输出 JSON，不要编造未提供的数据。
严格输出 JSON 对象，键为：
{
  "phase_coverage": { "before": true/false, "during": true/false, "after": true/false },
  "doc_quality": { "repair_photos": 0, "settlement_photos": 0, "material_photos": 0, "milestone_photo_total": 0 },
  "risk_flags": ["字符串数组，如 few_photos、no_milestones"],
  "summary_score": 0-100 整数,
  "model_confidence": "high"|"medium"|"low"
}
summary_score：节点与凭证较齐全 70+；明显缺失可低于 50。`;

function countUrls(arr) {
  if (!Array.isArray(arr)) return 0;
  return arr.filter((u) => u && String(u).trim()).length;
}

function buildHeuristicPayload(orderId, milestones, evidence) {
  const codes = new Set((milestones || []).map((m) => String(m.milestone_code || '')));
  const phase_coverage = {
    before: codes.has('before_process') || codes.has('pre_clean_inspect'),
    during:
      codes.has('during_process') ||
      codes.has('parts_verify_process') ||
      codes.has('parts_off') ||
      codes.has('parts_on') ||
      codes.has('mid_qc'),
    after: codes.has('after_process') || codes.has('pre_delivery_clean'),
  };
  const ev = evidence && typeof evidence === 'object' ? evidence : {};
  const doc_quality = {
    repair_photos: countUrls(ev.repair_photos),
    settlement_photos: countUrls(ev.settlement_photos),
    material_photos: countUrls(ev.material_photos),
    milestone_photo_total: (milestones || []).reduce((n, m) => {
      const a = Array.isArray(m.photo_urls) ? m.photo_urls.length : 0;
      const b = Array.isArray(m.parts_photo_urls) ? m.parts_photo_urls.length : 0;
      return n + a + b;
    }, 0),
  };
  const risk_flags = [];
  if ((milestones || []).length === 0) risk_flags.push('no_milestones');
  const totalDoc = doc_quality.repair_photos + doc_quality.settlement_photos + doc_quality.material_photos;
  if (totalDoc < 1 && doc_quality.milestone_photo_total < 2) risk_flags.push('few_photos');

  let summary_score = 55;
  if (phase_coverage.before && phase_coverage.during && phase_coverage.after) summary_score += 15;
  else if (phase_coverage.before || phase_coverage.after) summary_score += 8;
  if (totalDoc >= 3) summary_score += 12;
  else if (totalDoc >= 1) summary_score += 6;
  if (doc_quality.milestone_photo_total >= 3) summary_score += 10;
  summary_score = Math.max(15, Math.min(100, Math.round(summary_score)));

  return {
    version: 1,
    order_id: orderId,
    analyzed_at: new Date().toISOString(),
    source: 'heuristic_v1',
    phase_coverage,
    doc_quality,
    risk_flags,
    summary_score,
    model_confidence: risk_flags.length ? 'medium' : 'low',
    milestone_count: (milestones || []).length,
  };
}

async function mergeQwenSummary(heuristic, userFactsText, apiKey) {
  if (!apiKey || !String(apiKey).trim()) return heuristic;
  try {
    const raw = await callQwenText(
      REPAIR_PROCESS_AI_SYSTEM,
      `订单事实摘要：\n${userFactsText}\n\n请输出 JSON（与 system 约定键一致）。`,
      apiKey
    );
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    if (!m) return { ...heuristic, qwen_parse_failed: true };
    const parsed = JSON.parse(m[0]);
    return {
      ...heuristic,
      source: 'heuristic_v1+qwen_text_v1',
      phase_coverage: parsed.phase_coverage || heuristic.phase_coverage,
      doc_quality: parsed.doc_quality || heuristic.doc_quality,
      risk_flags: Array.isArray(parsed.risk_flags) ? parsed.risk_flags : heuristic.risk_flags,
      summary_score:
        typeof parsed.summary_score === 'number'
          ? Math.max(0, Math.min(100, Math.round(parsed.summary_score)))
          : heuristic.summary_score,
      model_confidence: parsed.model_confidence || heuristic.model_confidence,
    };
  } catch (e) {
    return { ...heuristic, qwen_error: String(e.message || 'qwen').slice(0, 200) };
  }
}

async function runRepairProcessAiForOrder(pool, orderId) {
  if (!(await hasColumn(pool, 'orders', 'repair_process_ai'))) return;
  const [ords] = await pool.execute(
    'SELECT order_id, completion_evidence, status FROM orders WHERE order_id = ? LIMIT 1',
    [orderId]
  );
  if (!ords.length) return;
  const row = ords[0];
  let evidence = {};
  try {
    evidence =
      typeof row.completion_evidence === 'string'
        ? JSON.parse(row.completion_evidence || '{}')
        : row.completion_evidence || {};
  } catch (_) {
    evidence = {};
  }
  const milestones = await repairMilestoneService.listForOrder(pool, orderId);
  const base = buildHeuristicPayload(orderId, milestones, evidence);
  const apiKey = process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '';
  const facts = [
    `milestone_count=${base.milestone_count}`,
    `repair_photos=${base.doc_quality.repair_photos}`,
    `settlement=${base.doc_quality.settlement_photos}`,
    `material=${base.doc_quality.material_photos}`,
    `milestone_photos=${base.doc_quality.milestone_photo_total}`,
    `phase_before/during/after=${base.phase_coverage.before}/${base.phase_coverage.during}/${base.phase_coverage.after}`,
  ].join('\n');
  const merged = await mergeQwenSummary(base, facts, apiKey);
  await pool.execute('UPDATE orders SET repair_process_ai = ? WHERE order_id = ?', [
    JSON.stringify(merged),
    orderId,
  ]);
  try {
    const align = require('./review-evidence-alignment-service');
    if (typeof align.recalculateReviewsForOrder === 'function') {
      await align.recalculateReviewsForOrder(pool, orderId);
    }
  } catch (e) {
    console.warn('[repair-process-ai] recalculateReviewsForOrder:', e && e.message);
  }
}

function scheduleRepairProcessAiForOrder(pool, orderId) {
  setImmediate(() => {
    runRepairProcessAiForOrder(pool, orderId).catch((err) => {
      console.error('[repair-process-ai] runRepairProcessAiForOrder:', err && err.message);
    });
  });
}

module.exports = {
  runRepairProcessAiForOrder,
  scheduleRepairProcessAiForOrder,
  buildHeuristicPayload,
};
