/**
 * AI 驳回后待人工裁定：运营「裁定有效」发奖并展示 / 「裁定无效」维持不展示不发奖
 */

const rewardCalculator = require('../reward-calculator');
const reviewValidator = require('../review-validator');
const antifraud = require('../antifraud');
const objectiveSchema = require('../utils/review-objective-schema');
const shopScore = require('../shop-score');
const orderRewardCap = require('./order-reward-cap-service');
const { preWithholdLaborRemunerationEachPayment } = require('../utils/labor-remuneration-withhold');

function parseJsonField(v, fallback) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'object' && !Buffer.isBuffer(v)) return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return fallback;
  }
}

async function hasTableCheck(pool, tableName) {
  try {
    const [rows] = await pool.execute(
      `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [tableName]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

function mergeAiAnalysisHuman(rv, patch) {
  let base = {};
  try {
    const raw = rv.ai_analysis;
    if (raw && typeof raw === 'string') base = JSON.parse(raw);
    else if (raw && typeof raw === 'object') base = { ...raw };
  } catch (_) {
    base = {};
  }
  return JSON.stringify({ ...base, ...patch });
}

/**
 * 人工裁定：AI 误判通过 → 按规则发奖、前台展示、计店铺分
 */
async function approvePendingHumanAiReview(pool, reviewId, adminUserId) {
  const [revs] = await pool.execute('SELECT * FROM reviews WHERE review_id = ?', [reviewId]);
  if (!revs.length) return { success: false, error: '评价不存在', statusCode: 404 };
  const rv = revs[0];
  if (rv.content_quality !== 'pending_human') {
    return { success: false, error: '该评价不处于「待人工裁定」状态', statusCode: 400 };
  }

  const order_id = rv.order_id;
  const userId = rv.user_id;
  const [orders] = await pool.execute('SELECT * FROM orders WHERE order_id = ?', [order_id]);
  if (!orders.length) return { success: false, error: '订单不存在', statusCode: 404 };
  const order = orders[0];

  let vehicleInfo = {};
  if (order.bidding_id) {
    const [b] = await pool.execute('SELECT vehicle_info FROM biddings WHERE bidding_id = ?', [order.bidding_id]);
    if (b.length && b[0].vehicle_info) {
      try {
        vehicleInfo =
          typeof b[0].vehicle_info === 'string' ? JSON.parse(b[0].vehicle_info || '{}') : b[0].vehicle_info || {};
      } catch (_) {}
    }
  }

  let quoteItems = [];
  if (order.quote_id) {
    const [quotes] = await pool.execute('SELECT items FROM quotes WHERE quote_id = ?', [order.quote_id]);
    if (quotes.length && quotes[0].items) {
      quoteItems = parseJsonField(quotes[0].items, []);
    }
  }
  if (order.repair_plan) {
    try {
      const rp = typeof order.repair_plan === 'string' ? JSON.parse(order.repair_plan) : order.repair_plan;
      if (rp?.items && Array.isArray(rp.items)) quoteItems = rp.items;
    } catch (_) {}
  }

  const [shops] = await pool.execute('SELECT compliance_rate, complaint_rate, name FROM shops WHERE shop_id = ?', [
    order.shop_id,
  ]);
  const shop = shops.length > 0 ? shops[0] : {};

  const rewardResult = await rewardCalculator.calculateReward(pool, order, vehicleInfo, quoteItems, shop);
  let totalReward = rewardResult.reward_pre;
  const orderTier = rewardResult.order_tier;
  const complexityLevel = rewardResult.complexity_level || order.complexity_level || 'L2';

  const completionArr = parseJsonField(rv.completion_images, []);
  const afterArr = parseJsonField(rv.after_images, completionArr);
  const settlementImage = rv.settlement_list_image || null;
  const ratingNum = parseFloat(rv.rating) || 5;

  const validation = reviewValidator.validateReview({
    complexityLevel,
    rating: ratingNum,
    content: rv.content,
    completion_images: completionArr,
    after_images: afterArr,
    settlement_list_image: settlementImage,
  });

  let contentQuality = 'valid';
  let contentQualityLevel = 1;

  const faultEvidenceUrls = parseJsonField(rv.fault_evidence_images, []);
  const objFlat = parseJsonField(rv.objective_answers, {});
  const m3Merged = objectiveSchema.legacyMergeObjectives({ ...objFlat });

  if (m3Merged.q_fault_resolved === false && faultEvidenceUrls.length > 0 && contentQualityLevel === 1) {
    contentQuality = '维权参考';
    contentQualityLevel = 2;
  }
  if (contentQualityLevel > 2) {
    contentQualityLevel = 2;
    if (contentQuality === '标杆') contentQuality = 'premium';
  }

  const isPremium = false;
  const premiumFloat = 0;

  const eligibility = await antifraud.getRewardEligibility(pool, userId);
  const rewardRulesSnapshot = await rewardCalculator.getRewardRules(pool);
  const pv1Global = rewardRulesSnapshot.platformIncentiveV1 || {};
  const commissionCapRatio = 1.0;
  const maxByCommission = (rewardResult.commission_amount || 0) * commissionCapRatio;
  if (maxByCommission > 0) totalReward = Math.min(totalReward, maxByCommission);

  let rewardAmount = totalReward;
  if (complexityLevel === 'L1') rewardAmount = 0;

  const [userRow] = await pool.execute('SELECT level_demoted_by_violation FROM users WHERE user_id = ?', [userId]).catch(() => [[{ level_demoted_by_violation: 0 }]]);
  const demotedByViolation = userRow?.[0]?.level_demoted_by_violation === 1;
  if (!eligibility.canReceive) {
    rewardAmount = 0;
  }

  const afConfig = await antifraud.getAntifraudConfig(pool);
  if (complexityLevel === 'L1' && rewardAmount > 0) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [l1Sum] = await pool.execute(
      `SELECT COALESCE(SUM(t.amount), 0) as total FROM transactions t
       JOIN reviews r ON t.related_id = r.review_id
       JOIN orders o ON r.order_id = o.order_id
       WHERE t.user_id = ? AND t.type = 'rebate' AND t.created_at >= ?
       AND o.complexity_level = 'L1'`,
      [userId, monthStart]
    );
    const currentMonthL1 = parseFloat(l1Sum[0]?.total || 0);
    const cap = afConfig.l1MonthlyCap;
    if (currentMonthL1 >= cap) {
      rewardAmount = 0;
    } else if (currentMonthL1 + rewardAmount > cap) {
      rewardAmount = Math.round((cap - currentMonthL1) * 100) / 100;
    }
  }

  const wRA = preWithholdLaborRemunerationEachPayment(rewardAmount);
  let taxDeducted = wRA.taxDeducted;
  let userReceives = wRA.afterTax;
  const userReceivesPreHardCap = userReceives;
  const taxDeductedPreHardCap = taxDeducted;
  if (userReceives > 0) {
    const capped = await orderRewardCap.clampPayoutToOrderHardCap(
      pool,
      order_id,
      order,
      {
        afterTax: userReceives,
        taxDeducted,
      },
      null,
      { review_id: reviewId, payout_kind: 'rebate_human_approve' }
    );
    userReceives = capped.afterTax;
    taxDeducted = capped.taxDeducted;
  }

  let shouldWithhold = false;
  if (eligibility.level === 0 && rewardAmount === 0 && !demotedByViolation && complexityLevel !== 'L1') {
    const trust = await antifraud.getUserTrustLevel(pool, userId);
    shouldWithhold = trust.needsVerification === true;
  }
  if (shouldWithhold) {
    let withholdAmount = Math.round(totalReward * 100) / 100;
    if (complexityLevel === 'L1' && withholdAmount > 0) {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const [l1Sum] = await pool.execute(
        `SELECT COALESCE(SUM(t.amount), 0) as total FROM transactions t
         JOIN reviews r ON t.related_id = r.review_id
         JOIN orders o ON r.order_id = o.order_id
         WHERE t.user_id = ? AND t.type = 'rebate' AND t.created_at >= ?
         AND o.complexity_level = 'L1'`,
        [userId, monthStart]
      );
      const currentMonthL1 = parseFloat(l1Sum[0]?.total || 0);
      const cap = afConfig.l1MonthlyCap;
      withholdAmount = currentMonthL1 >= cap ? 0 : Math.min(withholdAmount, cap - currentMonthL1);
    }
    withholdAmount = Math.round(withholdAmount * 100) / 100;
    const wHW = preWithholdLaborRemunerationEachPayment(withholdAmount);
    const withholdTax = wHW.taxDeducted;
    const withholdReceives = wHW.afterTax;
    if (withholdReceives > 0) {
      try {
        await pool.execute(
          `INSERT INTO withheld_rewards (user_id, review_id, order_id, amount, tax_deducted, user_receives, status, reason)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', 'no_verification')`,
          [userId, reviewId, order_id, withholdAmount, withholdTax, withholdReceives]
        );
      } catch (e) {
        console.error('[review-human-audit] withheld_rewards:', e.message);
      }
    }
  }

  const aiMerged = mergeAiAnalysisHuman(rv, {
    human_audit: {
      decision: 'approve',
      at: new Date().toISOString(),
      operator_id: adminUserId || 'admin',
      note: '人工裁定有效（覆盖 AI 不通过）',
    },
  });

  const [updRes] = await pool.execute(
    `UPDATE reviews SET rebate_amount = ?, reward_amount = ?, tax_deducted = ?, status = 1,
     content_quality = ?, content_quality_level = ?, ai_analysis = ?, rebate_rate = 0
     WHERE review_id = ? AND content_quality = 'pending_human'`,
    [userReceives, rewardAmount, taxDeducted, contentQuality, contentQualityLevel, aiMerged, reviewId]
  );
  const affected = Number(updRes && updRes.affectedRows) || 0;
  if (affected < 1) {
    return { success: false, error: '状态已变更，请刷新后重试', statusCode: 409 };
  }

  try {
    await shopScore.updateShopScoreAfterReview(pool, order.shop_id, reviewId);
  } catch (err) {
    console.error('[review-human-audit] shop score:', err.message);
  }

  const scene = objectiveSchema.reviewScene(order);
  const falseKeys = objectiveSchema.falseObjectiveKeysForAppeals(scene, m3Merged);
  if (falseKeys.length > 0) {
    try {
      if (await hasTableCheck(pool, 'merchant_evidence_requests')) {
        const materialAudit = require('./material-audit-service');
        const crypto = require('crypto');
        const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000);
        for (const key of falseKeys) {
          const item = {
            key,
            label: objectiveSchema.QUESTION_LABELS[key] || key,
            penalty: objectiveSchema.PENALTIES[key] ?? 0,
          };
          const requestId = 'evr_' + crypto.randomBytes(12).toString('hex');
          await pool.execute(
            `INSERT INTO merchant_evidence_requests (request_id, order_id, review_id, shop_id, question_key, status, deadline)
             VALUES (?, ?, ?, ?, ?, 0, ?)`,
            [requestId, order_id, reviewId, order.shop_id, item.key, deadline]
          );
          const msg =
            item.penalty > 0
              ? `车主在评价中选择了「否」：${item.label}。请在 48 小时内提交申诉材料，申诉不利将扣 ${item.penalty} 分。`
              : `车主在评价中选择了「否」：${item.label}。请在 48 小时内提交申诉材料（如竣工检验、检测报告等）。`;
          await materialAudit.sendMerchantMessage(
            pool,
            order.shop_id,
            'evidence_request',
            '评价待申诉',
            msg,
            order_id,
            '48小时内提交申诉'
          );
        }
      }
    } catch (err) {
      console.error('[review-human-audit] merchant appeals:', err.message);
    }
  }

  if (userReceives > 0) {
    await pool.execute('UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?', [
      userReceives,
      userReceives,
      userId,
    ]);
    const hasSrc = await orderRewardCap.hasRewardSourceOrderColumn(pool);
    if (hasSrc) {
      await pool.execute(
        `INSERT INTO transactions (transaction_id, user_id, type, amount, description, related_id, reward_source_order_id, reward_tier, review_stage, tax_deducted, created_at)
         VALUES (?, ?, 'rebate', ?, '主评价奖励金（人工裁定）', ?, ?, ?, 'main', ?, NOW())`,
        ['TXN' + Date.now(), userId, userReceives, reviewId, order_id, orderTier ?? null, taxDeducted ?? null]
      );
    } else {
      await pool.execute(
        `INSERT INTO transactions (transaction_id, user_id, type, amount, description, related_id, reward_tier, review_stage, tax_deducted, created_at)
         VALUES (?, ?, 'rebate', ?, '主评价奖励金（人工裁定）', ?, ?, 'main', ?, NOW())`,
        ['TXN' + Date.now(), userId, userReceives, reviewId, orderTier ?? null, taxDeducted ?? null]
      );
    }
  }

  try {
    await pool.execute(
      `INSERT INTO review_audit_logs (review_id, audit_type, result, missing_items, operator_id) VALUES (?, 'manual', 'pass', ?, ?)`,
      [reviewId, JSON.stringify({ source: 'human_override_ai' }), adminUserId || 'admin']
    );
  } catch (e) {
    console.error('[review-human-audit] audit log:', e.message);
  }

  try {
    const auditLogger = require('../reward-audit-logger');
    auditLogger.logReviewSubmit({
      review_id: reviewId,
      order_id,
      user_id: userId,
      reward_pre: rewardResult.reward_pre,
      reward_base: rewardResult.reward_pre,
      order_tier: orderTier,
      complexity_level: complexityLevel,
      commission_rate: rewardResult.commission_rate,
      commission_amount: rewardResult.commission_amount,
      vehicle_price_tier: rewardResult.vehicle_price_tier,
      vehicle_coeff: rewardResult.vehicle_coeff,
      content_quality: contentQuality,
      content_quality_level: contentQualityLevel,
      is_premium: isPremium,
      premium_float: premiumFloat,
      total_reward: totalReward,
      max_by_commission: maxByCommission,
      immediate_percent: 1,
      user_level: eligibility.level,
      eligibility_can_receive: eligibility.canReceive,
      eligibility_multiplier: eligibility.multiplier,
      l1_monthly_cap: null,
      current_month_l1: null,
      reward_amount_before_tax: rewardAmount,
      tax_deducted: taxDeducted,
      user_receives: userReceives,
      user_receives_pre_hard_cap: userReceivesPreHardCap,
      tax_deducted_pre_hard_cap: taxDeductedPreHardCap,
      compliance_red_line_pct: rewardRulesSnapshot.complianceRedLine,
      platform_incentive_v1: auditLogger.pickPv1ForAudit(pv1Global),
      tracks: {
        base: {
          reward_pre: rewardResult.reward_pre,
          premium_float: premiumFloat,
          total_reward_pre_tax: totalReward,
          reward_amount_pre_tax: rewardAmount,
          user_receives: userReceives,
          tax_deducted: taxDeducted,
          user_receives_pre_hard_cap: userReceivesPreHardCap,
          tax_deducted_pre_hard_cap: taxDeductedPreHardCap,
          source: 'human_approve_pending_ai',
        },
        interaction: { settled: false, pipeline: 'monthly_like_bonus' },
        conversion: { settled: false, pipeline: 'monthly_conversion_or_post_verify' },
      },
    });
  } catch (_) {}

  return {
    success: true,
    message: '已裁定有效并发奖',
    data: { user_receives: userReceives, reward_amount: rewardAmount, tax_deducted: taxDeducted },
  };
}

/**
 * 人工裁定：维持无效（不发奖、不展示）
 */
async function rejectPendingHumanAiReview(pool, reviewId, adminUserId, note) {
  const [revs] = await pool.execute('SELECT * FROM reviews WHERE review_id = ?', [reviewId]);
  if (!revs.length) return { success: false, error: '评价不存在', statusCode: 404 };
  const rv = revs[0];
  if (rv.content_quality !== 'pending_human') {
    return { success: false, error: '该评价不处于「待人工裁定」状态', statusCode: 400 };
  }

  const aiMerged = mergeAiAnalysisHuman(rv, {
    pending_human_audit: false,
    invalid_submission: true,
    human_audit: {
      decision: 'reject',
      at: new Date().toISOString(),
      operator_id: adminUserId || 'admin',
      note: String(note || '').trim() || '人工裁定维持无效',
    },
  });

  const [updRej] = await pool.execute(
    `UPDATE reviews SET content_quality = 'invalid', content_quality_level = 1, status = 0,
     rebate_amount = 0, reward_amount = 0, tax_deducted = 0, ai_analysis = ?
     WHERE review_id = ? AND content_quality = 'pending_human'`,
    [aiMerged, reviewId]
  );
  const affectedRej = Number(updRej && updRej.affectedRows) || 0;
  if (affectedRej < 1) {
    return { success: false, error: '状态已变更，请刷新后重试', statusCode: 409 };
  }

  try {
    await pool.execute(
      `INSERT INTO review_audit_logs (review_id, audit_type, result, missing_items, operator_id) VALUES (?, 'manual', 'reject', ?, ?)`,
      [reviewId, JSON.stringify({ note: String(note || '').trim() }), adminUserId || 'admin']
    );
  } catch (e) {
    console.error('[review-human-audit] audit log reject:', e.message);
  }

  return { success: true, message: '已裁定无效' };
}

module.exports = {
  approvePendingHumanAiReview,
  rejectPendingHumanAiReview,
};
