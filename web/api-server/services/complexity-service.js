/**
 * 复杂度判定服务
 * 从前台维修项目数据与运营后台 repair_complexity_levels 配置匹配，获得复杂度等级
 * 未匹配时可选调用 AI 大模型按复杂度定义判定
 */

const LEVEL_ORDER = { L1: 1, L2: 2, L3: 3, L4: 4 };

/**
 * 从 repair_complexity_levels 匹配维修项目，返回最高等级（就高不就低）
 * @param {object} pool - 数据库连接池
 * @param {Array} items - 维修项目 [{ name }, ...]，name 为项目名称
 * @returns {Promise<{ level: string, matched: boolean }>} level=L1|L2|L3|L4，matched 表示是否在后台配置中匹配到
 */
async function resolveComplexityFromItems(pool, items) {
  if (!items || !Array.isArray(items) || items.length === 0) {
    return { level: 'L2', matched: false };
  }
  try {
    const [rows] = await pool.execute(
      'SELECT `level`, project_type FROM repair_complexity_levels WHERE `level` IN (\'L1\',\'L2\',\'L3\',\'L4\')'
    );
    if (!rows || rows.length === 0) {
      return { level: 'L2', matched: false };
    }
    const itemNames = items.map((i) => String(i.name || '').toLowerCase()).filter(Boolean);
    if (itemNames.length === 0) return { level: 'L2', matched: false };

    let maxLevel = 'L1';
    let anyMatched = false;
    const text = itemNames.join(' ');

    for (const r of rows) {
      const L = (r.level || '').toUpperCase();
      if (!LEVEL_ORDER[L]) continue;
      const keywords = String(r.project_type || '').split(/[|,，]/).map((k) => k.trim()).filter(Boolean);
      for (const kw of keywords) {
        if (!kw) continue;
        const k = kw.toLowerCase();
        if (text.includes(k)) {
          anyMatched = true;
          if (LEVEL_ORDER[L] > LEVEL_ORDER[maxLevel]) maxLevel = L;
          break;
        }
      }
    }
    return { level: anyMatched ? maxLevel : 'L2', matched: anyMatched };
  } catch (err) {
    console.error('[complexity-service] resolveComplexityFromItems error:', err.message);
    return { level: 'L2', matched: false };
  }
}

/**
 * 未匹配时调用 AI 判定（预留接口，可按需接入千问等）
 * @param {Array} items - 维修项目
 * @param {number} orderAmount - 订单金额
 * @returns {Promise<string|null>} L1|L2|L3|L4 或 null
 */
async function inferComplexityByAI(items, orderAmount) {
  // TODO: 接入 AI 大模型，根据《复杂度分级详细标准》定义判定
  return null;
}

/**
 * 解析维修项目来源：quote items 或 analysis repair_suggestions
 * @param {Array} quoteItems - 报价项目 [{ name }]
 * @param {object} analysisResult - 定损分析结果 { repair_suggestions: [{ name }] }
 * @returns {Array} 合并后的项目列表
 */
function normalizeRepairItems(quoteItems, analysisResult) {
  const list = [];
  if (quoteItems && Array.isArray(quoteItems)) {
    for (const i of quoteItems) {
      const n = i.name || i.damage_part || i.repair_type;
      if (n) list.push({ name: String(n) });
    }
  }
  if (analysisResult && analysisResult.repair_suggestions && Array.isArray(analysisResult.repair_suggestions)) {
    for (const s of analysisResult.repair_suggestions) {
      const n = s.name || s.item || s.damage_part || s.repair_type;
      if (n) list.push({ name: String(n) });
    }
  }
  return list;
}

module.exports = {
  resolveComplexityFromItems,
  inferComplexityByAI,
  normalizeRepairItems,
};
