/**
 * 完工凭证写入时：维修方案分项 + material_photos → 千问配件-方案一致性，结果写入 completion_evidence.parts_traceability_ai
 * analysis_process 等完整过程仅存订单 JSON；评价页仅下发简短 ai_display_line。
 */

const { analyzePartsTraceabilityWithQwen } = require('../qwen-analyzer');

function toAbsUrl(u, baseUrl) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base) return s;
  return base + (s.startsWith('/') ? s : '/' + s);
}

function parseRepairItemsFromOrderRow(orderRow) {
  if (!orderRow || !orderRow.repair_plan) return [];
  try {
    const rp =
      typeof orderRow.repair_plan === 'string' ? JSON.parse(orderRow.repair_plan || '{}') : orderRow.repair_plan;
    return Array.isArray(rp?.items) ? rp.items : [];
  } catch (_) {
    return [];
  }
}

async function loadRepairItemsForOrder(pool, orderRow) {
  let items = parseRepairItemsFromOrderRow(orderRow);
  if (items.length || !orderRow) return items;
  try {
    if (orderRow.quote_id) {
      const [quotes] = await pool.execute('SELECT items FROM quotes WHERE quote_id = ?', [orderRow.quote_id]);
      if (quotes.length && quotes[0].items != null) {
        const raw = quotes[0].items;
        items = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw || [];
      }
    } else if (orderRow.bidding_id && orderRow.shop_id) {
      const [quotes] = await pool.execute(
        'SELECT items FROM quotes WHERE bidding_id = ? AND shop_id = ? LIMIT 1',
        [orderRow.bidding_id, orderRow.shop_id]
      );
      if (quotes.length && quotes[0].items != null) {
        const raw = quotes[0].items;
        items = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw || [];
      }
    }
  } catch (_) {}
  return Array.isArray(items) ? items : [];
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} orderId
 * @param {object} evidence
 * @param {string} [baseUrl]
 */
async function enrichCompletionEvidenceWithPartsTraceability(pool, orderId, evidence, baseUrl) {
  const ev = evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? { ...evidence } : {};
  if (ev.parts_traceability_ai && typeof ev.parts_traceability_ai === 'object') {
    return ev;
  }

  const [orders] = await pool.execute(
    'SELECT repair_plan, quote_id, bidding_id, shop_id FROM orders WHERE order_id = ? LIMIT 1',
    [orderId]
  );
  const repairItems = orders.length ? await loadRepairItemsForOrder(pool, orders[0]) : [];
  const materialPhotos = Array.isArray(ev.material_photos) ? ev.material_photos : [];
  const base = baseUrl || process.env.BASE_URL || 'http://localhost:3000';
  const imageUrls = materialPhotos.map((u) => toAbsUrl(u, base)).filter((u) => u.startsWith('http'));

  const apiKey = process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '';
  if (!apiKey || !String(apiKey).trim()) {
    ev.parts_traceability_ai = {
      status: 'skipped',
      match_level: null,
      user_conclusion: '',
      mismatch_reasons: [],
      analysis_process: '未配置视觉模型',
      analyzed_at: new Date().toISOString(),
      source: 'parts_traceability_at_completion',
    };
    return ev;
  }

  try {
    const result = await analyzePartsTraceabilityWithQwen({
      repairItems,
      imageUrls,
      apiKey,
    });
    ev.parts_traceability_ai = {
      ...result,
      source: 'parts_traceability_at_completion',
      analyzed_at: result.analyzed_at || new Date().toISOString(),
    };
  } catch (err) {
    console.warn('[parts-traceability-at-completion] order=%s %s', orderId, err.message);
    ev.parts_traceability_ai = {
      status: 'failed',
      match_level: null,
      user_conclusion: '',
      mismatch_reasons: [],
      analysis_process: String(err.message || 'error').slice(0, 2000),
      analyzed_at: new Date().toISOString(),
      source: 'parts_traceability_at_completion',
    };
  }

  return ev;
}

module.exports = {
  enrichCompletionEvidenceWithPartsTraceability,
  parseRepairItemsFromOrderRow,
  loadRepairItemsForOrder,
  toAbsUrl,
};
