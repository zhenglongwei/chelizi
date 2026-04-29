/**
 * 店铺综合得分各维度：规则说明与行动按钮（文案对齐 docs/体系/05-店铺综合评价体系.md）
 * key 须与 shop-score computeHardBonusBreakdown 的 item.key 一致，另含 base_reputation
 */

const URL_SHOP = '/pages/merchant/shop/profile/index';
const URL_APPEAL_LIST = '/pages/merchant/appeal/list/index';
const URL_ORDER_LIST = '/pages/merchant/order/list/index';
const URL_MESSAGE = '/pages/merchant/message/index';

const DIMENSION_CONFIG = {
  base_reputation: {
    title: '口碑基础分',
    rulesParagraphs: [
      '店铺最终综合得分中的「口碑部分」来自有效评价：按星级 × 单条评价总权重 × 时间衰减系数加权平均后，再 ×20 转为百分制（5 星对应 100 分制下的满分口径）。',
      '时间衰减：近 3 个月系数 1.0；3–6 个月 0.5；6–12 个月 0.2；12 个月以上仅展示、不计入得分。',
      '单条评价总权重见《评价内容质量等级体系》；L1 复杂度订单评价权重为 0，不计入店铺得分。',
      '提升方向：保质保量完成订单、引导车主留下真实有效评价，并减少差评与履约问题。'
    ],
    actions: [
      { label: '我的订单', url: URL_ORDER_LIST },
      { label: '消息中心', url: URL_MESSAGE }
    ]
  },
  major: {
    title: '重大违规',
    rulesParagraphs: [
      '重大违规记录：出现 1 次扣 50 分；累计 2 次及以上综合得分清零，店铺可能下架。',
      '单笔扣分来源包括系统核验违规（如服务商不一致、结算偏差等，按规范 10/20/50 分/单）等，详见 docs/已归档/评价内容设置规范.md 与商户合规相关说明。',
      '若对扣分有异议，请在规定时限内发起申诉并补充材料。'
    ],
    actions: [
      { label: '我的申诉', url: URL_APPEAL_LIST },
      { label: '店铺资料', url: URL_SHOP }
    ]
  },
  qualification: {
    title: '维修资质等级',
    rulesParagraphs: [
      '一类维修资质 +10 分，二类 +5 分，三类不加分。',
      '请在店铺资料中如实填写并提交资质等级及相关证明，审核通过后在车主端展示并参与计分。'
    ],
    actions: [{ label: '去完善店铺资料', url: URL_SHOP }]
  },
  technician: {
    title: '持证技师',
    rulesParagraphs: [
      '**汽车维修工**职业技能等级与**机动车检测维修**水平评价（维修士、工程师）两套证书在市场上并存，计分**无主次**：工程师或技师、高级技师 +8 分/人；维修士或初级工、中级工、高级工 +3 分/人；同一店铺该项加分上限 +20 分。',
      '请在店铺资料中维护技师持证信息，以便系统计分与展示。'
    ],
    actions: [{ label: '去完善店铺资料', url: URL_SHOP }]
  },
  certification: {
    title: '品牌授权资质',
    rulesParagraphs: [
      '主机厂 4S 授权 +15 分；配件品牌授权 +5 分；可按规则叠加（实现上设有合理上限，以系统计算为准）。',
      '请在店铺资料中上传并维护授权类认证材料。'
    ],
    actions: [{ label: '去完善店铺资料', url: URL_SHOP }]
  },
  compliance: {
    title: '季度综合合规率',
    rulesParagraphs: [
      '季度综合合规率 = 本季度合规订单数 ÷ 本季度总完成订单数 ×100%。',
      '≥95% +10 分；80%–94% 不加减；低于 80% 扣 20 分。合规订单指无平台认定的违规扣分记录的完成单。',
      '违规类型包括进度未同步、配件展示、系统核验问题等，详见体系文档 3.1。'
    ],
    actions: [
      { label: '我的申诉', url: URL_APPEAL_LIST },
      { label: '店铺资料', url: URL_SHOP }
    ]
  },
  deviation: {
    title: '报价准确度',
    rulesParagraphs: [
      '按报价与实际结算等偏差率统计：偏差率 ≤10% +5 分；＞30% 扣 20 分。',
      '请在接单与结算环节保持报价透明、减少大幅偏差，避免扣分。'
    ],
    actions: [
      { label: '我的订单', url: URL_ORDER_LIST },
      { label: '店铺资料', url: URL_SHOP }
    ]
  },
  timeliness: {
    title: '维修时效履约',
    rulesParagraphs: [
      '本季度已完成订单中，实际完工时间相对承诺工期的履约情况：100% 按时履约 +5 分；低于 70% 扣 20 分。',
      '请在维修方案中合理承诺工期并按时完工。'
    ],
    actions: [{ label: '我的订单', url: URL_ORDER_LIST }]
  },
  parts: {
    title: '配件合规',
    rulesParagraphs: [
      '本季度已完成订单的配件合规情况：全部合规 +10 分；出现 1 次不合规扣 20 分（备案制：默认提交含编号照片视为合规路径之一，车主可查；人工确认不合规后扣分）。',
      '材料完整与完工提交规则已覆盖基础合规，仍须避免被认定的不合规记录。'
    ],
    actions: [
      { label: '我的申诉', url: URL_APPEAL_LIST },
      { label: '我的订单', url: URL_ORDER_LIST }
    ]
  }
};

function getDimensionConfig(key) {
  if (!key || !DIMENSION_CONFIG[key]) return null;
  return DIMENSION_CONFIG[key];
}

function isValidDimensionKey(key) {
  return !!DIMENSION_CONFIG[key];
}

module.exports = {
  getDimensionConfig,
  isValidDimensionKey,
  DIMENSION_KEYS: Object.keys(DIMENSION_CONFIG)
};
