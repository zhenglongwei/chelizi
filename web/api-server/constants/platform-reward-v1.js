/**
 * 评价激励平台化 V1 默认参数（与计划 §十 对齐；reward_rules 可覆盖）
 * 合并逻辑见 services/reward-rules-loader.js
 */
module.exports = {
  /** 基础轨相对单笔订单实收佣金 C 的红线（%）；reward_rules 根级可覆盖 */
  complianceRedLine: 60,
  platformIncentiveV1: {
    enabled: true,
    /** 关闭 AI 内容档驱动的首发现金浮动（首评仍可用规则 premium） */
    disableAiPremiumFloat: true,
    /** 月度结算是否处理 upgrade_diff pending（默认关） */
    settleUpgradeDiffEnabled: false,
    /** 归因订单转化池 + 事后验证共帽：占该单实收佣金比例 */
    conversionPoolShare: 0.1,
    postVerifySharesConversionPool: true,
    /** 合规比较与 (B) 硬帽：一律税前应付 vs 订单实收佣金 */
    compliancePreTaxOnly: true,
    /** 单笔订单用户侧激励硬帽（税前合计 / C） */
    maxUserRewardPctOfCommission: 0.8,
    /** 互动轨：结算月内完工订单 ΣC 的全站池比例（与每单 conversionPoolShare 语义独立） */
    interactionPoolShare: 0.1,
    /** 文档/规划：基础轨相对 C 的子帽叙事，默认与 complianceRedLine 对齐（可后台调） */
    baseInteractionCapPct: 60,
    /** 买家等级 φ(L)，索引 0..4 */
    phi: [0, 0.6, 0.85, 1, 1],
    /** 作者等级 ψ(L)，索引 0..4 */
    psi: [0, 0.75, 1, 1, 1.05],
    thetaCap: 0.65,
    attributionWindowDays: 7,
    /** 下线订单分级封顶参与 min（与计划一致） */
    disableOrderTierCap: true,
    /** 转化决策权重中不再用 content_quality_level 乘子（避免 AI 档耦合） */
    neutralizeContentQualityInConversionWeight: true,
    /** 店铺分计算时不再把 AI/内容档位抬到 premium 权重（仍保留差评加权等） */
    shopScoreIgnoreContentQualityLevel: true,
    interaction: {
      sE: 5,
      sR: 300,
      rhoCap: 0.5,
      tau: 0.25,
      eta: { E: 0.1, R: 0.0005, L: 0.2, C: 0.5, rho: 2.0 },
      coldStartD: 50,
    },
    /** 店铺内容指数权重 w1..w5，和为 1（实现侧可逐步接入） */
    shopScoreWeights: [0.28, 0.22, 0.22, 0.18, 0.1],
  },
};
