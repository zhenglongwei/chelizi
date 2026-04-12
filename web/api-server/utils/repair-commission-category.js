/**
 * 维修佣金类目：与搜索/店铺类目、后台 commissionRepair.byCategory 键一致
 * 未匹配到关键词时返回 null，佣金取该付款方 default
 */

const CANONICAL_CATEGORIES = [
  '钣金喷漆',
  '保养服务',
  '发动机维修',
  '电路维修',
  '换胎',
  '美容',
];

/**
 * @param {Array<{name?:string,damage_part?:string,item?:string,repair_type?:string}>} items
 * @returns {string|null} 无关键词命中时 null，佣金用付款方 default
 */
function resolveRepairCommissionCategory(items) {
  const parts = [];
  for (const i of items || []) {
    const n = [i.name, i.damage_part, i.item, i.repair_type]
      .map((x) => (x != null ? String(x).trim() : ''))
      .filter(Boolean)
      .join(' ');
    if (n) parts.push(n);
  }
  const text = parts.join(' ').toLowerCase();
  if (!text) return null;

  if (/轮胎|换胎|动平衡|四轮定位/.test(text)) return '换胎';
  if (/洗车|美容|打蜡|镀晶|贴膜|精洗/.test(text)) return '美容';
  if (/钣金|喷漆|腻子|补漆|翼子板|车门/.test(text)) return '钣金喷漆';
  if (/保养|机油|机滤|小保养|滤芯|三滤/.test(text)) return '保养服务';
  if (/发动机|变速箱|大修|机电/.test(text)) return '发动机维修';
  if (/电路|线路|电控|电脑板/.test(text)) return '电路维修';

  return null;
}

module.exports = {
  CANONICAL_CATEGORIES,
  resolveRepairCommissionCategory,
};
