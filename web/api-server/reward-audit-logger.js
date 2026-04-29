/**
 * 奖励金审计日志
 * 在评价提交、点赞、内容转化、事后验证、订单硬帽压减等关键环节输出**单行 JSON**，便于测试核对三轨与最终结果。
 * 启用：环境变量 REWARD_AUDIT_LOG=1（或 true）
 * 查看：grep "\[REWARD-AUDIT\]" 日志
 *
 * 典型事件：
 * - review_submit：首评基础轨（含 premium、硬帽前后）
 * - order_hard_cap_clamp：单笔 C 上 80% 硬帽压减明细
 * - like_bonus / conversion_bonus / post_verify_bonus / upgrade_diff：月结类
 */

const ENABLED = process.env.REWARD_AUDIT_LOG === '1' || process.env.REWARD_AUDIT_LOG === 'true';

function log(event, data) {
  if (!ENABLED) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...data,
  });
  console.log(`[REWARD-AUDIT] ${line}`);
}

/** 写入日志的 platformIncentiveV1 子集（避免整包过大） */
function pickPv1ForAudit(pv1) {
  const p = pv1 && typeof pv1 === 'object' ? pv1 : {};
  const keys = [
    'enabled',
    'disableAiPremiumFloat',
    'settleUpgradeDiffEnabled',
    'disableOrderTierCap',
    'maxUserRewardPctOfCommission',
    'baseInteractionCapPct',
    'interactionPoolShare',
    'conversionPoolShare',
    'postVerifySharesConversionPool',
    'thetaCap',
    'compliancePreTaxOnly',
    'neutralizeContentQualityInConversionWeight',
    'shopScoreIgnoreContentQualityLevel',
    'attributionWindowDays',
  ];
  const o = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(p, k)) o[k] = p[k];
  }
  return o;
}

/**
 * 评价提交：奖励金计算参数
 */
function logReviewSubmit(payload) {
  log('review_submit', {
    review_id: payload.review_id,
    order_id: payload.order_id,
    user_id: payload.user_id,
    // 三轨（首评仅落基础轨；互动/转化为月结，此处标注口径）
    tracks: payload.tracks || {
      base: {
        reward_pre: payload.reward_pre,
        premium_float: payload.premium_float,
        reward_amount_pre_tax: payload.reward_amount_before_tax,
        user_receives: payload.user_receives,
        tax_deducted: payload.tax_deducted,
        user_receives_pre_hard_cap: payload.user_receives_pre_hard_cap,
        tax_deducted_pre_hard_cap: payload.tax_deducted_pre_hard_cap,
      },
      interaction: {
        settled: false,
        note: 'like_bonus 等为月度结算，见 like_bonus 事件',
      },
      conversion: {
        settled: false,
        note: 'conversion_bonus / post_verify_bonus 为月度结算，见对应事件',
      },
    },
    reward_result: {
      reward_pre: payload.reward_pre,
      reward_base: payload.reward_base,
      order_tier: payload.order_tier,
      complexity_level: payload.complexity_level,
      commission_rate: payload.commission_rate,
      commission_amount: payload.commission_amount,
      vehicle_price_tier: payload.vehicle_price_tier,
      vehicle_coeff: payload.vehicle_coeff,
    },
    rules_snapshot: {
      compliance_red_line_pct: payload.compliance_red_line_pct,
      platform_incentive_v1: payload.platform_incentive_v1 || undefined,
    },
    content_quality: payload.content_quality,
    content_quality_level: payload.content_quality_level,
    is_premium: payload.is_premium,
    premium_float: payload.premium_float,
    total_reward: payload.total_reward,
    max_by_commission: payload.max_by_commission,
    immediate_percent: payload.immediate_percent,
    user_level: payload.user_level,
    eligibility_can_receive: payload.eligibility_can_receive,
    eligibility_multiplier: payload.eligibility_multiplier,
    l1_monthly_cap: payload.l1_monthly_cap,
    current_month_l1: payload.current_month_l1,
    reward_amount_before_tax: payload.reward_amount_before_tax,
    tax_deducted: payload.tax_deducted,
    user_receives: payload.user_receives,
    user_receives_pre_hard_cap: payload.user_receives_pre_hard_cap,
    tax_deducted_pre_hard_cap: payload.tax_deducted_pre_hard_cap,
  });
}

/**
 * 点赞：权重与类型判定参数
 */
function logLike(payload) {
  log('like', {
    like_id: payload.like_id,
    review_id: payload.review_id,
    user_id: payload.user_id,
    author_id: payload.author_id,
    total_reading_seconds: payload.total_reading_seconds,
    has_enough_reading: payload.has_enough_reading,
    user_level: payload.user_level,
    credibility_weight: payload.credibility_weight,
    liker_plate: payload.liker_plate,
    order_plate: payload.order_plate,
    liker_model_key: payload.liker_model_key,
    order_model_key: payload.order_model_key,
    vehicle_match_by_plate: payload.vehicle_match_by_plate,
    weight_coefficient: payload.weight_coefficient,
    is_valid_for_bonus: payload.is_valid_for_bonus,
    like_type: payload.like_type,
  });
}

/**
 * 内容转化：单条分配参数
 */
function logConversionBonus(payload) {
  log('conversion_bonus', {
    order_id: payload.order_id,
    review_id: payload.review_id,
    user_id: payload.user_id,
    commission: payload.commission,
    pool_amount: payload.pool_amount,
    decision_weight: payload.decision_weight,
    weight_share_pct: payload.weight_share_pct,
    share_before_tax: payload.share_before_tax,
    tax_deducted: payload.tax_deducted,
    share_after_tax: payload.share_after_tax,
    weight_breakdown: payload.weight_breakdown,
  });
}

/**
 * 事后验证补发：单条发放参数
 */
function logPostVerifyBonus(payload) {
  log('post_verify_bonus', {
    order_id: payload.order_id,
    review_id: payload.review_id,
    user_id: payload.user_id,
    commission: payload.commission,
    bonus_before_tax: payload.bonus_before_tax,
    tax_deducted: payload.tax_deducted,
    bonus_after_tax: payload.bonus_after_tax,
  });
}

/**
 * 追评/升级差额：整体重评后升级
 */
function logUpgradeDiff(payload) {
  log('upgrade_diff', {
    order_id: payload.order_id,
    review_id: payload.review_id,
    user_id: payload.user_id,
    old_level: payload.old_level,
    new_level: payload.new_level,
    diff_amount: payload.diff_amount,
    calc_reason: payload.calc_reason,
  });
}

/**
 * 常规点赞追加：单条发放参数
 */
function logLikeBonus(payload) {
  log('like_bonus', {
    review_id: payload.review_id,
    order_id: payload.order_id,
    user_id: payload.user_id,
    settlement_month: payload.settlement_month,
    commission_C: payload.commission_C ?? payload.commission,
    allocation_mode: payload.allocation_mode,
    sigma_c_month: payload.sigma_c_month,
    interaction_pool_share: payload.interaction_pool_share,
    pool_pre_tax_month: payload.pool_pre_tax_month,
    total_weight_sum_month: payload.total_weight_sum_month,
    like_rate_applied: payload.like_rate_applied,
    commission: payload.commission,
    cap_hard_pct: payload.cap_hard_pct,
    cap_total_pre_tax_burden: payload.cap_total_pre_tax_burden,
    used_pre_tax_burden_before_payout: payload.used_pre_tax_burden_before_payout,
    remaining_pre_tax_burden_before_payout: payload.remaining_pre_tax_burden_before_payout,
    proposed_pre_tax_burden: payload.proposed_pre_tax_burden,
    cap80: payload.cap80,
    existing_total: payload.existing_total,
    remaining_cap: payload.remaining_cap,
    weight_sum: payload.weight_sum,
    bonus_before_tax: payload.bonus_before_tax,
    tax_deducted: payload.tax_deducted,
    bonus_after_tax: payload.bonus_after_tax,
  });
}

/** 单笔订单实收佣金 C 上的硬帽压减（与 order-reward-cap-service 一致） */
function logHardCapClamp(payload) {
  log('order_hard_cap_clamp', {
    order_id: payload.order_id,
    review_id: payload.review_id || null,
    payout_kind: payload.payout_kind || null,
    pending_id: payload.pending_id || null,
    commission_C: payload.commission_C,
    max_cap_pct: payload.max_cap_pct,
    cap_total_pre_tax_burden: payload.cap_total_pre_tax_burden,
    used_pre_tax_burden_before: payload.used_pre_tax_burden_before,
    remaining_pre_tax_burden: payload.remaining_pre_tax_burden,
    proposed_pre_tax_burden: payload.proposed_pre_tax_burden,
    result_after_tax: payload.result_after_tax,
    result_tax_deducted: payload.result_tax_deducted,
    skipped_no_anchor_column: payload.skipped_no_anchor_column,
  });
}

module.exports = {
  log,
  pickPv1ForAudit,
  logReviewSubmit,
  logLike,
  logLikeBonus,
  logConversionBonus,
  logPostVerifyBonus,
  logUpgradeDiff,
  logHardCapClamp,
};
