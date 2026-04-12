/**
 * 平台配件类型（与《配件类型和极简证明材料》五类一致，名称与 CSV / 小程序模板统一）
 */

const CANONICAL_PARTS_TYPES = Object.freeze([
  '原厂件',
  '同质品牌件',
  '普通副厂件',
  '再制造件',
  '回用拆车件',
]);

/** 历史别名 / 口语 → 规范名 */
const LEGACY_TO_CANONICAL = {
  原厂配件: '原厂件',
  纯正配件: '原厂件',
  原厂: '原厂件',
  原厂件: '原厂件',
  '4S': '原厂件',
  同质品牌件: '同质品牌件',
  同质件: '同质品牌件',
  大厂件: '同质品牌件',
  普通副厂件: '普通副厂件',
  副厂件: '普通副厂件',
  品牌件: '普通副厂件',
  再制造件: '再制造件',
  再制造: '再制造件',
  回用拆车件: '回用拆车件',
  拆车件: '回用拆车件',
  回用件: '回用拆车件',
};

function normalizePartsType(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (LEGACY_TO_CANONICAL[s]) return LEGACY_TO_CANONICAL[s];
  if (CANONICAL_PARTS_TYPES.includes(s)) return s;
  if (/同质|大厂|一线/.test(s)) return '同质品牌件';
  if (/副厂|平价|流通/.test(s)) return '普通副厂件';
  if (/再制造|翻新/.test(s)) return '再制造件';
  if (/拆车|回用|二手原厂/.test(s)) return '回用拆车件';
  if (/原厂|纯正|OE|4S/.test(s)) return '原厂件';
  return null;
}

function partsTypesEquivalent(a, b) {
  const na = normalizePartsType(a);
  const nb = normalizePartsType(b);
  if (!na && !nb) return true;
  return na != null && nb != null && na === nb;
}

module.exports = {
  CANONICAL_PARTS_TYPES,
  LEGACY_TO_CANONICAL,
  normalizePartsType,
  partsTypesEquivalent,
};
