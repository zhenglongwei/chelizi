/**
 * 增值服务：平台标准勾选模板、订单/竞价结构化展示、合规免责（辙见）
 * 落库格式不变：value_added_services: [{ name: string }]
 *
 * 展示规则：车主与商户均按「类目标题 + 仅已勾选模板原文」一致展示；历史勾选文案经 LEGACY_VA_NAME_ALIASES 归一到当前模板句。
 */

/** 车主端类目标题（与类目 id 对应） */
const OWNER_GROUP_HEADLINE = {
  accident_care: '事故贴心修',
  claim_help: '理赔不用跑',
  convenience: '修车更省心',
  quality: '品质更放心',
  extras: '贴心小礼遇',
};

/** 修理厂报价勾选模板（勾选落库的 name 须与 items 中某一字符串完全一致） */
const MERCHANT_VALUE_ADDED_GROUPS = [
  {
    id: 'accident_care',
    merchantTitle: '【事故维修增值服务】',
    items: [
      '旧划痕、小剐蹭顺带修复（含局部免费处理）',
      '全车外观清洁与轻微瑕疵修整',
      '原厂漆优先，局部精细修复',
    ],
  },
  {
    id: 'claim_help',
    merchantTitle: '【保险理赔代办服务】',
    items: [
      '全程代办报案、定损与理赔',
      '多方事故协调与保险公司沟通对接',
      '直赔或免垫资结算；理赔材料协助整理',
    ],
  },
  {
    id: 'convenience',
    merchantTitle: '【时效与便利服务】',
    items: [
      '小事故优先快修',
      '上门取送车（可协商代步车或交通补贴）',
      '维修进度线上实时查看',
    ],
  },
  {
    id: 'quality',
    merchantTitle: '【透明品质服务】',
    items: [
      '维修过程拍照留档',
      '配件明码标价，无隐形消费、不强制加价',
      '交车前全车清洗与内饰简单清洁',
    ],
  },
  {
    id: 'extras',
    merchantTitle: '【贴心小福利】',
    items: [
      '免费添加玻璃水',
      '前挡玻璃油膜去除',
      '小易损件优惠更换与全车安全检查（灯泡、雨刮、底盘、轮胎、油液）',
    ],
  },
];

/**
 * 历史模板句 → 当前 canonical 模板句（键为历史落库原文）
 * 须覆盖上一版 MERCHANT_VALUE_ADDED_GROUPS 全部 items，避免旧单展示落入「其他服务」或勾选丢失
 */
const LEGACY_VA_NAME_ALIASES = {
  '旧划痕 / 小凹陷顺带修复': '旧划痕、小剐蹭顺带修复（含局部免费处理）',
  局部小剐蹭免费处理: '旧划痕、小剐蹭顺带修复（含局部免费处理）',
  '全车外观清洁 + minor 瑕疵修整': '全车外观清洁与轻微瑕疵修整',
  原厂漆优先保留修复: '原厂漆优先，局部精细修复',
  '全程代办报案、定损、理赔': '全程代办报案、定损与理赔',
  协助与保险公司合理沟通定损: '多方事故协调与保险公司沟通对接',
  '多方事故（同责 / 主次责）协调对接': '多方事故协调与保险公司沟通对接',
  '保险公司直赔，车主无需垫资': '直赔或免垫资结算；理赔材料协助整理',
  '理赔材料代整理、代提交': '直赔或免垫资结算；理赔材料协助整理',
  小事故优先快修: '小事故优先快修',
  '上门取车 / 上门送车': '上门取送车（可协商代步车或交通补贴）',
  维修进度实时线上查看: '维修进度线上实时查看',
  '提供临时代步车 / 交通补贴': '上门取送车（可协商代步车或交通补贴）',
  维修过程拍照留档: '维修过程拍照留档',
  '配件品牌、价格明确可选': '配件明码标价，无隐形消费、不强制加价',
  '无隐形消费，不强制加价': '配件明码标价，无隐形消费、不强制加价',
  '交车前全车清洗 + 内饰简单清洁': '交车前全车清洗与内饰简单清洁',
  免费添加玻璃水: '免费添加玻璃水',
  前挡玻璃油膜去除: '前挡玻璃油膜去除',
  '小易损件（灯泡 / 雨刮等）优惠更换':
    '小易损件优惠更换与全车安全检查（灯泡、雨刮、底盘、轮胎、油液）',
  '全车安全检查（底盘 / 轮胎 / 油液）':
    '小易损件优惠更换与全车安全检查（灯泡、雨刮、底盘、轮胎、油液）',
};

const OWNER_VA_INTRO = '这家修理厂可为你提供：';

/** 平台合规免责（车主端服务说明下方小字） */
const VALUE_ADDED_LEGAL_DISCLAIMER_LINES = [
  '说明：',
  '旧伤顺带修复、小剐蹭处理等增值服务，均在本次事故定损金额与维修项目合理范围内提供，不涉及虚构事故、故意扩损、违规理赔等行为。',
  '增值服务以修理厂实际车况评估为准，非所有损伤均可顺带处理。',
  '定损金额以保险公司最终核定为准，修理厂仅提供协助沟通，不做赔付承诺。',
];

/** 修理厂端模板区上方短提示 */
const VA_COMPLIANCE_HINT_MERCHANT =
  '请仅勾选本店实际可提供且合法合规的服务；以下为平台标准话术模板，车主端按类目展示已勾选项。';

function normalizeVaName(v) {
  return String(v == null ? '' : typeof v === 'string' ? v : v.name || '').trim();
}

function getVaNamesFromPayload(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeVaName).filter(Boolean);
}

const ALL_TEMPLATE_ITEMS = new Set(MERCHANT_VALUE_ADDED_GROUPS.flatMap((g) => g.items));

/**
 * 将落库/勾选文案归一为当前模板中的 canonical 句；非模板、无别名则原样返回（自定义项）
 */
function normalizeVaNameForTemplate(v) {
  const n = normalizeVaName(v);
  if (!n) return '';
  if (LEGACY_VA_NAME_ALIASES[n]) return LEGACY_VA_NAME_ALIASES[n];
  if (ALL_TEMPLATE_ITEMS.has(n)) return n;
  return n;
}

function findGroupIdForTemplateName(name) {
  const c = normalizeVaNameForTemplate(name);
  if (!c) return null;
  for (let i = 0; i < MERCHANT_VALUE_ADDED_GROUPS.length; i++) {
    const g = MERCHANT_VALUE_ADDED_GROUPS[i];
    for (let j = 0; j < g.items.length; j++) {
      if (g.items[j] === c) return g.id;
    }
  }
  return null;
}

/**
 * 根据已选增值服务生成结构化展示（车主/商户订单详情、竞价等共用）
 * 每类仅展示该类下「已勾选」的模板原文；类目标题为固定短标题；自定义项进「其他服务」
 * @param {Array<{name?: string}|string>} valueAddedList
 * @returns {{ intro: string, blocks: Array<{headline: string, lines: string[]}>, disclaimerLines: string[], show: boolean }}
 */
function buildOwnerValueAddedDisplay(valueAddedList) {
  const names = getVaNamesFromPayload(valueAddedList);
  if (!names.length) {
    return { intro: OWNER_VA_INTRO, blocks: [], disclaimerLines: [], show: false };
  }
  const pickedCanonical = new Set();
  const custom = [];
  for (let i = 0; i < names.length; i++) {
    const raw = names[i];
    const c = normalizeVaNameForTemplate(raw);
    if (findGroupIdForTemplateName(c)) {
      pickedCanonical.add(c);
    } else if (c && !ALL_TEMPLATE_ITEMS.has(c)) {
      custom.push(raw);
    }
  }
  const blocks = [];
  for (let gi = 0; gi < MERCHANT_VALUE_ADDED_GROUPS.length; gi++) {
    const g = MERCHANT_VALUE_ADDED_GROUPS[gi];
    const pickedLines = g.items.filter((label) => pickedCanonical.has(label));
    if (pickedLines.length && OWNER_GROUP_HEADLINE[g.id]) {
      blocks.push({
        headline: OWNER_GROUP_HEADLINE[g.id],
        lines: pickedLines.slice(),
      });
    }
  }
  if (custom.length) {
    blocks.push({ headline: '其他服务', lines: custom.slice() });
  }
  return {
    intro: OWNER_VA_INTRO,
    blocks,
    disclaimerLines: VALUE_ADDED_LEGAL_DISCLAIMER_LINES.slice(),
    show: true,
  };
}

/** 与 buildOwnerValueAddedDisplay 相同，便于语义区分 */
function buildValueAddedCardDisplay(valueAddedList) {
  return buildOwnerValueAddedDisplay(valueAddedList);
}

/**
 * 勾选 UI：每组带 itemRows { label, checked }
 * @param {Array<{name?: string}>} services
 */
function buildMerchantVaTemplateGroupsUI(services) {
  const selCanon = new Set(
    getVaNamesFromPayload(services)
      .map((n) => normalizeVaNameForTemplate(n))
      .filter(Boolean)
  );
  return MERCHANT_VALUE_ADDED_GROUPS.map((g) => ({
    id: g.id,
    merchantTitle: g.merchantTitle,
    itemRows: g.items.map((label) => ({ label, checked: selCanon.has(label) })),
  }));
}

function isTemplateValueAddedName(name) {
  return findGroupIdForTemplateName(normalizeVaNameForTemplate(normalizeVaName(name))) != null;
}

module.exports = {
  MERCHANT_VALUE_ADDED_GROUPS,
  OWNER_GROUP_HEADLINE,
  OWNER_VA_INTRO,
  VALUE_ADDED_LEGAL_DISCLAIMER_LINES,
  VA_COMPLIANCE_HINT_MERCHANT,
  normalizeVaName,
  normalizeVaNameForTemplate,
  getVaNamesFromPayload,
  findGroupIdForTemplateName,
  buildOwnerValueAddedDisplay,
  buildValueAddedCardDisplay,
  buildMerchantVaTemplateGroupsUI,
  isTemplateValueAddedName,
};
