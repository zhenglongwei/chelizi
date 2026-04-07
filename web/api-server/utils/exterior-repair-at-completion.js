/**
 * 服务商提交完工凭证时：维修前（定损/上报）+ 维修后（repair_photos）→ 千问外观修复度，写入 completion_evidence.exterior_repair_analysis
 * 评价页 for-review 直接读此字段，不再依赖「提交评价后再异步算」。
 */

const { analyzeExteriorRepairDegreeWithQwen } = require('../qwen-analyzer');

function toAbsUrl(u, baseUrl) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base) return s;
  return base + (s.startsWith('/') ? s : '/' + s);
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} orderId
 * @returns {Promise<string[]>}
 */
async function getBeforeImageUrlsForOrder(pool, orderId) {
  const [orders] = await pool.execute(
    'SELECT bidding_id, before_images FROM orders WHERE order_id = ? LIMIT 1',
    [orderId]
  );
  if (!orders.length) return [];
  const o = orders[0];
  const out = [];
  if (o.before_images) {
    try {
      const arr = typeof o.before_images === 'string' ? JSON.parse(o.before_images) : o.before_images;
      if (Array.isArray(arr)) out.push(...arr);
    } catch (_) {}
  }
  if (o.bidding_id) {
    try {
      const [biddings] = await pool.execute('SELECT report_id FROM biddings WHERE bidding_id = ?', [o.bidding_id]);
      if (biddings.length > 0) {
        const [reports] = await pool.execute('SELECT images FROM damage_reports WHERE report_id = ?', [
          biddings[0].report_id,
        ]);
        if (reports.length > 0 && reports[0].images) {
          const arr =
            typeof reports[0].images === 'string' ? JSON.parse(reports[0].images) : reports[0].images;
          if (Array.isArray(arr)) out.push(...arr);
        }
      }
    } catch (_) {}
  }
  const seen = new Set();
  return out.map((x) => String(x || '').trim()).filter((u) => {
    if (!u || seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} orderId
 * @param {object} evidence - completion_evidence 对象（会浅拷贝后写入新字段）
 * @param {string} [baseUrl] - 相对路径转绝对 URL 供千问拉图
 * @returns {Promise<object>}
 */
async function enrichCompletionEvidenceWithExteriorRepairAnalysis(pool, orderId, evidence, baseUrl) {
  const ev = evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? { ...evidence } : {};
  if (ev.exterior_repair_analysis && typeof ev.exterior_repair_analysis === 'object') {
    return ev;
  }

  const apiKey = process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '';
  const base = baseUrl || process.env.BASE_URL || 'http://localhost:3000';

  if (!apiKey || !String(apiKey).trim()) {
    ev.exterior_repair_analysis = {
      status: 'skipped',
      repair_degree_percent: null,
      note: '未配置视觉模型，未生成外观修复度',
      analyzed_at: new Date().toISOString(),
      source: 'exterior_repair_at_completion',
    };
    return ev;
  }

  const beforeRaw = await getBeforeImageUrlsForOrder(pool, orderId);
  const repairPhotos = Array.isArray(ev.repair_photos) ? ev.repair_photos : [];
  const beforeUrls = beforeRaw.map((u) => toAbsUrl(u, base)).filter((u) => u.startsWith('http'));
  const afterUrls = repairPhotos.map((u) => toAbsUrl(u, base)).filter((u) => u.startsWith('http'));

  try {
    const analysis = await analyzeExteriorRepairDegreeWithQwen({
      beforeUrls,
      afterUrls,
      apiKey,
    });
    ev.exterior_repair_analysis = {
      ...analysis,
      source: 'exterior_repair_at_completion',
      analyzed_at: analysis.analyzed_at || new Date().toISOString(),
    };
  } catch (err) {
    console.warn('[exterior-repair-at-completion] order=%s %s', orderId, err.message);
    ev.exterior_repair_analysis = {
      status: 'failed',
      repair_degree_percent: null,
      note: '外观对比分析异常，请结合实拍自行判断',
      analyzed_at: new Date().toISOString(),
      source: 'exterior_repair_at_completion',
    };
  }

  return ev;
}

module.exports = {
  enrichCompletionEvidenceWithExteriorRepairAnalysis,
  getBeforeImageUrlsForOrder,
  toAbsUrl,
};
