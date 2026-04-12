/**
 * 复杂度判定服务
 * 从前台维修项目数据与 reward_rules.complexityLevels 配置匹配，获得复杂度等级
 * 配置缺失时直接报错
 */

const LEVEL_ORDER = { L1: 1, L2: 2, L3: 3, L4: 4 };

/**
 * 单行报价/方案项的可匹配文本（与 quote-import、reward-calculator.applyComplexityUpgrade 对齐）
 */
function getItemMatchText(i) {
  if (!i || typeof i !== 'object') return '';
  const a = String(i.name || '').trim();
  const b = String(i.damage_part || '').trim();
  const c = String(i.item || '').trim();
  if (a) return a;
  if (b) return b;
  if (c) return c;
  const rt = String(i.repair_type || '').trim();
  if (rt && rt !== '换' && rt !== '修') return rt;
  return '';
}

/**
 * 从 reward_rules.complexityLevels 匹配维修项目，返回最高等级（就高不就低）
 * @param {object} pool - 数据库连接池
 * @param {Array} items - 维修项目（支持 name / damage_part / item / repair_type）
 * @returns {Promise<{ level: string, matched: boolean }>} level=L1|L2|L3|L4，matched 表示是否在后台配置中匹配到
 */
async function resolveComplexityFromItems(pool, items) {
  if (!items || !Array.isArray(items) || items.length === 0) {
    return { level: 'L2', matched: false };
  }
  const rewardRulesLoader = require('./reward-rules-loader');
  const rows = await rewardRulesLoader.getComplexityLevels(pool);

  const itemNames = items.map((i) => String(getItemMatchText(i) || '').toLowerCase()).filter(Boolean);
  if (itemNames.length === 0) return { level: 'L2', matched: false };

  let maxLevel = 'L1';
  let anyMatched = false;
  const text = itemNames.join(' ');

  for (const r of rows) {
    const L = (r.level || '').toUpperCase();
    if (!LEVEL_ORDER[L]) continue;
    const projectType = r.project_type || r.projectType || '';
    const keywords = String(projectType).split(/[|,，]/).map((k) => k.trim()).filter(Boolean);
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
      const n = getItemMatchText(i) || i.repair_type;
      if (n && String(n).trim()) list.push({ name: String(n).trim() });
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
  getItemMatchText,
  resolveComplexityFromItems,
  inferComplexityByAI,
  normalizeRepairItems,
};
