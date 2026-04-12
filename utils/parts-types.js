/**
 * 小程序侧配件类型选项（与 CSV 模板、服务端 constants/parts-types 一致）
 */
const PARTS_TYPES = [
  { label: '原厂件', value: '原厂件' },
  { label: '同质品牌件', value: '同质品牌件' },
  { label: '普通副厂件', value: '普通副厂件' },
  { label: '再制造件', value: '再制造件' },
  { label: '回用拆车件', value: '回用拆车件' },
];

const LEGACY = {
  原厂配件: '原厂件',
  纯正配件: '原厂件',
  同质件: '同质品牌件',
  大厂件: '同质品牌件',
  副厂件: '普通副厂件',
  拆车件: '回用拆车件',
  回用件: '回用拆车件',
};

function normalizePartsTypeLabel(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  if (LEGACY[t]) return LEGACY[t];
  return PARTS_TYPES.some((p) => p.value === t) ? t : t;
}

function partsTypePickerIndex(value) {
  const v = normalizePartsTypeLabel(value);
  const i = PARTS_TYPES.findIndex((p) => p.value === v);
  return i >= 0 ? i : 0;
}

module.exports = {
  PARTS_TYPES,
  normalizePartsTypeLabel,
  partsTypePickerIndex,
};
