/**
 * 奖励金审计日志
 * 在评价提交、点赞、内容转化、事后验证等关键环节输出结构化参数，便于检查算法与逻辑
 * 启用：环境变量 REWARD_AUDIT_LOG=1
 * 查看：grep "\[REWARD-AUDIT\]" 日志文件
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

/**
 * 评价提交：奖励金计算参数
 */
function logReviewSubmit(payload) {
  log('review_submit', {
    review_id: payload.review_id,
    order_id: payload.order_id,
    user_id: payload.user_id,
    // 奖励计算
    reward_result: {
      reward_pre: payload.reward_pre,
      reward_base: payload.reward_base,
      order_tier: payload.order_tier,
      complexity_level: payload.complexity_level,
      commission_rate: payload.commission_rate,
      commission_amount: payload.commission_amount,
      vehicle_price_tier: payload.vehicle_price_tier,
    },
    content_quality: payload.content_quality,
    content_quality_level: payload.content_quality_level,
    is_premium: payload.is_premium,
    premium_float: payload.premium_float,
    total_reward: payload.total_reward,
    max_by_commission: payload.max_by_commission,
    immediate_percent: payload.immediate_percent,
    // 用户等级与发放
    user_level: payload.user_level,
    eligibility_can_receive: payload.eligibility_can_receive,
    eligibility_multiplier: payload.eligibility_multiplier,
    l1_monthly_cap: payload.l1_monthly_cap,
    current_month_l1: payload.current_month_l1,
    reward_amount_before_tax: payload.reward_amount_before_tax,
    tax_deducted: payload.tax_deducted,
    user_receives: payload.user_receives,
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
    commission: payload.commission,
    cap80: payload.cap80,
    existing_total: payload.existing_total,
    remaining_cap: payload.remaining_cap,
    weight_sum: payload.weight_sum,
    bonus_before_tax: payload.bonus_before_tax,
    tax_deducted: payload.tax_deducted,
    bonus_after_tax: payload.bonus_after_tax,
  });
}

module.exports = {
  log,
  logReviewSubmit,
  logLike,
  logLikeBonus,
  logConversionBonus,
  logPostVerifyBonus,
  logUpgradeDiff,
};
