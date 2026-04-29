/**
 * 主评价极简 v3 提交（review_form_version=3）
 * 与 review-service.js 主路径分离，便于维护
 */

const antifraud = require('./antifraud');
const rewardCalculator = require('./reward-calculator');
const reviewValidator = require('./review-validator');
const objectiveSchema = require('./utils/review-objective-schema');
const shopScore = require('./shop-score');
const reviewSystemCheckService = require('./services/review-system-check-service');
const { analyzeExteriorRepairDegreeWithQwen, analyzeReviewEvidenceContradictionWithQwen } = require('./qwen-analyzer');
const { computeStarAiAnomaly } = require('./utils/review-star-ai-anomaly');
const { getStarAiAnomalyConfig } = require('./utils/review-star-ai-anomaly-config');
const { normalizeReviewPublicMedia, anyPublicMediaSelected } = require('./utils/review-public-media');
const { jsonStringifyForDb } = require('./utils/json-stringify-safe');
const orderRewardCap = require('./services/order-reward-cap-service');
const { preWithholdLaborRemunerationEachPayment } = require('./utils/labor-remuneration-withhold');
const reviewEvidenceAlignment = require('./services/review-evidence-alignment-service');

async function hasColumn(pool, table, col) {
  try {
    const [rows] = await pool.execute(
      `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, col]
    );
    return rows.length > 0;
  } catch {
    return false;
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

function buildVehicleModelKey(vehicleInfo) {
  if (!vehicleInfo || typeof vehicleInfo !== 'object') return null;
  const brand = String(vehicleInfo.brand || '').trim();
  const model = String(vehicleInfo.model || '').trim();
  if (!brand && !model) return null;
  return `${brand || ''}|${model || ''}`;
}

function buildRepairProjectKey(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const parts = items
    .map((i) => {
      const part = String(i.damage_part || i.name || '').trim();
      const type = String(i.repair_type || '').trim();
      return part || type ? `${part}:${type}` : null;
    })
    .filter(Boolean);
  if (parts.length === 0) return null;
  parts.sort();
  return parts.join('|');
}

/** 仅允许声明为本单实际上传 URL，防注入 */
function resolveOwnerAlwaysPublicUrls(m3, completionArr, settlementImage, faultEvidenceImages) {
  const allowed = new Set();
  (completionArr || []).forEach((u) => {
    const s = String(u || '').trim();
    if (s) allowed.add(s);
  });
  if (settlementImage) allowed.add(String(settlementImage).trim());
  (faultEvidenceImages || []).forEach((u) => {
    const s = String(u || '').trim();
    if (s) allowed.add(s);
  });
  const raw = Array.isArray(m3.owner_always_public_urls) ? m3.owner_always_public_urls : [];
  return raw.map((u) => String(u || '').trim()).filter((u) => u && allowed.has(u));
}

function hasLowStarDivergence(m3) {
  const proc = parseInt(m3.process_transparency_star, 10);
  const q = parseInt(m3.quote_transparency_star, 10);
  const p = parseInt(m3.parts_traceability_star, 10);
  const r = parseInt(m3.repair_effect_star, 10);
  if (!Number.isNaN(proc) && proc <= 2) return true;
  if (!Number.isNaN(q) && q <= 2) return true;
  if (!Number.isNaN(p) && p <= 2) return true;
  if (!Number.isNaN(r) && r <= 2) return true;
  if (m3.parts_authenticity_check === 'mismatch') return true;
  return false;
}

function tryNormalizeAiUserAlignmentOptional(m3) {
  const a = m3.ai_user_alignment;
  if (!a || typeof a !== 'object') return null;
  const dims = ['quote_flow', 'appearance', 'parts_delivery'];
  const complete = dims.every((d) => {
    const st = a[d]?.stance;
    return st === 'accept' || st === 'override';
  });
  if (!complete) return null;
  return normalizeAiUserAlignment(a);
}

const AI_ALIGN_DIMS = ['quote_flow', 'appearance', 'parts_delivery'];
const AI_ALIGN_REASONS = new Set(['ai_wrong', 'not_applicable', 'incomplete', 'other']);

/**
 * 校验并归一化车主对系统/AI 归纳的认可结果（供运营抽样 has_divergence）
 */
function normalizeAiUserAlignment(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: '请完成对本页系统/AI 归纳的认可选择', statusCode: 400 };
  }
  let hasDivergence = false;
  const out = { recorded_at: new Date().toISOString() };
  for (const dim of AI_ALIGN_DIMS) {
    const row = raw[dim];
    const stance = row?.stance === 'override' ? 'override' : row?.stance === 'accept' ? 'accept' : '';
    if (!stance) {
      return { ok: false, error: '请对每项系统/AI 归纳选择「认可」或「不认可」', statusCode: 400 };
    }
    if (stance === 'override') {
      hasDivergence = true;
      const rc = String(row?.reason_code || '').trim();
      if (!AI_ALIGN_REASONS.has(rc)) {
        return { ok: false, error: '不认可时请选择原因类型', statusCode: 400 };
      }
      const note = String(row?.note || '').trim().slice(0, 40);
      if (rc === 'other' && note.length < 2) {
        return { ok: false, error: '选择「其他」时请填写简短说明', statusCode: 400 };
      }
      out[dim] = { stance: 'override', reason_code: rc, ...(note ? { note } : {}) };
    } else {
      out[dim] = { stance: 'accept' };
    }
  }
  out.has_divergence = hasDivergence ? 1 : 0;
  return { ok: true, data: out };
}

/**
 * @param {object} pool
 * @param {object} req
 * @param {object} opts
 */
async function submitReviewMinimalV3(pool, req, opts = {}) {
  const { order_id, module3, content, after_images, is_anonymous, force_submit } = req.body || {};
  const userId = req.userId;
  const m3 = module3 || {};

  if (!order_id) {
    return { success: false, error: '订单ID不能为空', statusCode: 400 };
  }

  const trust = await antifraud.getUserTrustLevel(pool, userId);
  if (trust.level === 0) {
    return { success: false, error: '您的账号等级不足，完成实名认证和车辆绑定后可评价', statusCode: 403 };
  }

  const [orders] = await pool.execute('SELECT * FROM orders WHERE order_id = ? AND user_id = ?', [order_id, userId]);
  if (orders.length === 0) {
    return { success: false, error: '订单不存在', statusCode: 404 };
  }
  const order = orders[0];

  const [existing] = await pool.execute('SELECT review_id FROM reviews WHERE order_id = ?', [order_id]);
  if (existing.length > 0) {
    return { success: false, error: '该订单已评价', statusCode: 400 };
  }

  const ip = req.ip || req.headers?.['x-forwarded-for'] || '';
  const [userForBl] = await pool.execute('SELECT phone FROM users WHERE user_id = ?', [userId]);
  const bl = await antifraud.checkBlacklist(pool, userId, userForBl[0]?.phone, ip);
  if (bl.blocked) {
    return { success: false, error: bl.reason || '账号存在异常，暂无法评价', statusCode: 403 };
  }

  const objRes = objectiveSchema.validateObjectiveAnswersV3(m3);
  if (!objRes.ok) {
    return { success: false, error: objRes.error, statusCode: 400 };
  }

  const aiPreviewFingerprint =
    typeof m3.ai_preview_fingerprint === 'string' ? m3.ai_preview_fingerprint.slice(0, 2000) : '';

  let vehicleInfo = {};
  let quoteItems = [];
  if (order.bidding_id) {
    const [biddings] = await pool.execute('SELECT vehicle_info FROM biddings WHERE bidding_id = ?', [order.bidding_id]);
    if (biddings.length > 0 && biddings[0].vehicle_info) {
      try {
        vehicleInfo = typeof biddings[0].vehicle_info === 'string' ? JSON.parse(biddings[0].vehicle_info) : biddings[0].vehicle_info;
      } catch (_) {}
    }
  }
  if (order.quote_id) {
    const [quotes] = await pool.execute('SELECT items FROM quotes WHERE quote_id = ?', [order.quote_id]);
    if (quotes.length > 0 && quotes[0].items) {
      try {
        quoteItems = typeof quotes[0].items === 'string' ? JSON.parse(quotes[0].items) : (quotes[0].items || []);
      } catch (_) {}
    }
  }
  let repairItems = quoteItems;
  if (order.repair_plan) {
    try {
      const rp = typeof order.repair_plan === 'string' ? JSON.parse(order.repair_plan) : order.repair_plan;
      if (rp?.items && Array.isArray(rp.items)) repairItems = rp.items;
    } catch (_) {}
  }
  const vehicleModelKey = buildVehicleModelKey(vehicleInfo);
  const repairProjectKey = buildRepairProjectKey(repairItems);

  const [shops] = await pool.execute('SELECT compliance_rate, complaint_rate, name FROM shops WHERE shop_id = ?', [order.shop_id]);
  const shop = shops.length > 0 ? shops[0] : {};

  const rewardResult = await rewardCalculator.calculateReward(pool, order, vehicleInfo, quoteItems, shop);
  let totalReward = rewardResult.reward_pre;
  const orderTier = rewardResult.order_tier;
  const complexityLevel = rewardResult.complexity_level || order.complexity_level || 'L2';

  const settlementImage = m3.settlement_list_image || null;
  const completionImages = m3.completion_images || after_images || [];
  const completionArr = Array.isArray(completionImages) ? completionImages : [];
  const faultEvidenceImages = Array.isArray(m3.fault_evidence_images) ? m3.fault_evidence_images : [];
  const ownerAlwaysPublicUrls = resolveOwnerAlwaysPublicUrls(m3, completionArr, settlementImage, faultEvidenceImages);
  const m3ForObjective = { ...m3, owner_always_public_urls: ownerAlwaysPublicUrls };

  const validation = reviewValidator.validateReviewMinimalV3({
    content: m3.content || content,
    complexityLevel,
  });
  if (!validation.valid && !force_submit) {
    return { success: false, error: validation.reason || '评价内容不符合要求', statusCode: 400 };
  }
  if (!validation.valid && force_submit) {
    return { success: false, error: validation.reason || '评价内容不符合要求', statusCode: 400 };
  }

  const svcStar = parseInt(m3.service_experience_star ?? m3.overall_star, 10);
  const resStar = parseInt(m3.repair_effect_star, 10);
  const quoteStar = parseInt(m3.quote_transparency_star, 10);
  const partsStar = parseInt(m3.parts_traceability_star, 10);
  const ratingNum = !Number.isNaN(svcStar) && svcStar >= 1 && svcStar <= 5 ? svcStar : 5;
  const repairStar =
    !Number.isNaN(resStar) && resStar >= 1 && resStar <= 5 ? resStar : ratingNum;
  const priceStar =
    !Number.isNaN(quoteStar) && quoteStar >= 1 && quoteStar <= 5 ? quoteStar : ratingNum;
  const partsRatingStar =
    !Number.isNaN(partsStar) && partsStar >= 1 && partsStar <= 5 ? partsStar : ratingNum;
  const eligibility = await antifraud.getRewardEligibility(pool, userId);
  const level = eligibility.level;
  const rewardRulesSnapshot = await rewardCalculator.getRewardRules(pool);
  const pv1Global = rewardRulesSnapshot.platformIncentiveV1 || {};
  const commissionCapRatio = 1.0;
  const maxByCommission = (rewardResult.commission_amount || 0) * commissionCapRatio;
  if (maxByCommission > 0) totalReward = Math.min(totalReward, maxByCommission);

  const contentForCheck = (m3.content || content || '').trim();
  const apiKey = process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '';
  let usedAiAudit = false;
  let aiResult = null;

  if (apiKey) {
    try {
      const baseUrl = opts.baseUrl || (process.env.BASE_URL || ((req.protocol || 'http') + '://' + (req.get?.('host') || `localhost:${opts.port || 3000}`)));
      const toAbsolute = (u) => {
        const s = String(u || '').trim();
        if (s.startsWith('http')) return s;
        return (baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl) + (s.startsWith('/') ? s : '/' + s);
      };
      const repairProjects = (quoteItems || []).map((i) => i.name || '').filter(Boolean);
      const quotedAmount = parseFloat(order.quoted_amount || order.actual_amount) || 0;
      const processStar = parseInt(m3.process_transparency_star, 10);
      const processLow = !Number.isNaN(processStar) && processStar >= 1 && processStar <= 2;
      const isNegative =
        ratingNum <= 2 || repairStar <= 2 || priceStar <= 2 || partsRatingStar <= 2 || processLow;
      const aiInput = {
        order: {
          orderId: order_id,
          shopName: shop.name || '',
          quotedAmount,
          repairProjects: repairProjects.length ? repairProjects : ['维修'],
          complexityLevel,
          faultDescription: '',
        },
        review: {
          content: contentForCheck,
          rating: ratingNum,
          isNegative,
          objectiveAnswers: objectiveSchema.buildObjectiveAnswersPayloadV3(order, m3ForObjective),
        },
        images: [],
      };
      if (settlementImage && settlementImage.trim()) {
        aiInput.images.push({ type: 'settlement', url: toAbsolute(settlementImage) });
      }
      completionArr.slice(0, 5).forEach((url) => {
        if (url && String(url).trim()) aiInput.images.push({ type: 'completion', url: toAbsolute(url) });
      });
      if (aiInput.images.length > 0) {
        aiResult = await analyzeReviewEvidenceContradictionWithQwen({ ...aiInput, apiKey });
        if (!aiResult?.details?.skipped) usedAiAudit = true;
        if (!aiResult.pass && !force_submit) {
          return {
            success: false,
            error: aiResult.rejectReason || '评价与服务商留档材料存在明显不一致，请核对后重试',
            statusCode: 400,
          };
        }
        if (!aiResult.pass && force_submit) {
          return {
            success: false,
            error: aiResult.rejectReason || '评价与服务商留档材料存在明显不一致，请核对后重试',
            statusCode: 400,
          };
        }
      }
    } catch (err) {
      console.error('[review-service-minimal-v3] 材料-表述一致性（千问）异常:', err.message);
    }
  }

  if (!usedAiAudit && contentForCheck) {
    const contentCheck = await antifraud.checkContentSimilarityOnly(pool, contentForCheck);
    if (!contentCheck.pass && !force_submit) {
      return { success: false, error: contentCheck.reason || '评价内容不符合要求', statusCode: 400 };
    }
  }

  const aiQuality = usedAiAudit && aiResult?.details?.contentQuality?.quality;
  let contentQuality;
  let contentQualityLevel;
  if (usedAiAudit && aiQuality) {
    if (aiQuality === 'benchmark') {
      contentQuality = '标杆';
      contentQualityLevel = 3;
    } else if (aiQuality === 'quality') {
      contentQuality = 'premium';
      contentQualityLevel = 2;
    } else if (aiQuality === '维权参考') {
      contentQuality = '维权参考';
      contentQualityLevel = 2;
    } else if (aiQuality === 'invalid') {
      contentQuality = 'invalid';
      contentQualityLevel = 1;
    } else if (aiQuality === 'basic') {
      contentQuality = 'valid';
      contentQualityLevel = 1;
    } else {
      contentQuality = 'valid';
      contentQualityLevel = 1;
    }
  } else {
    contentQuality = 'valid';
    contentQualityLevel = 1;
  }

  if (contentQualityLevel > 2) {
    contentQualityLevel = 2;
    if (contentQuality === '标杆') contentQuality = 'premium';
  }

  const isPremium = false;
  const premiumFloat = 0;
  if (contentQuality === 'invalid') {
    totalReward = 0;
  }

  let rewardAmount = totalReward;
  if (complexityLevel === 'L1') rewardAmount = 0;

  const [userRow] = await pool.execute('SELECT level_demoted_by_violation FROM users WHERE user_id = ?', [userId]).catch(() => [[{ level_demoted_by_violation: 0 }]]);
  const demotedByViolation = userRow?.[0]?.level_demoted_by_violation === 1;
  if (!eligibility.canReceive) rewardAmount = 0;

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
    if (currentMonthL1 >= cap) rewardAmount = 0;
    else if (currentMonthL1 + rewardAmount > cap) {
      rewardAmount = Math.round((cap - currentMonthL1) * 100) / 100;
    }
  }

  const reviewId = 'REV' + Date.now();

  const wRebate = preWithholdLaborRemunerationEachPayment(rewardAmount);
  let taxDeducted = wRebate.taxDeducted;
  let userReceives = wRebate.afterTax;
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
      { review_id: reviewId, payout_kind: 'rebate_first_review' }
    );
    userReceives = capped.afterTax;
    taxDeducted = capped.taxDeducted;
  }

  let systemChecks = await reviewSystemCheckService.buildInitialSystemChecksForOrder(pool, order_id);
  const alignTry = tryNormalizeAiUserAlignmentOptional(m3);
  const fromAlign = alignTry && alignTry.ok && alignTry.data.has_divergence === 1;
  const fromStars = hasLowStarDivergence(m3);
  const userAiPayload = alignTry && alignTry.ok
    ? { ...alignTry.data, preview_fingerprint: aiPreviewFingerprint || undefined }
    : { recorded_at: new Date().toISOString(), preview_fingerprint: aiPreviewFingerprint || undefined };
  userAiPayload.has_divergence = fromAlign || fromStars ? 1 : 0;
  systemChecks.user_ai_alignment = userAiPayload;
  try {
    const starAiCfg = await getStarAiAnomalyConfig(pool);
    if (starAiCfg.enabled) {
      const starAnomaly = computeStarAiAnomaly(m3, systemChecks, starAiCfg);
      if (starAnomaly && starAnomaly.has_anomaly) {
        systemChecks.star_ai_anomaly = starAnomaly;
      }
    }
  } catch (e) {
    console.error('[review-service-minimal-v3] star_ai_anomaly 计算失败（已跳过，不影响提交）:', e.message);
  }
  let systemChecksJson;
  try {
    systemChecksJson = jsonStringifyForDb(systemChecks);
  } catch (e) {
    console.error('[review-service-minimal-v3] review_system_checks 序列化失败:', e.message);
    try {
      delete systemChecks.star_ai_anomaly;
      systemChecksJson = jsonStringifyForDb(systemChecks);
    } catch (e2) {
      systemChecksJson = JSON.stringify({
        _serialization_fallback: true,
        recorded_at: new Date().toISOString(),
        user_ai_alignment: systemChecks.user_ai_alignment || null,
      });
    }
  }

  const publicMedia = normalizeReviewPublicMedia(m3.review_public_media || req.body.review_public_media);
  const legacyImgPublic = anyPublicMediaSelected(publicMedia) ? 1 : 0;

  let beforeImages = [];
  if (order.bidding_id) {
    const [biddings] = await pool.execute('SELECT report_id FROM biddings WHERE bidding_id = ?', [order.bidding_id]);
    if (biddings.length > 0) {
      const [reports] = await pool.execute('SELECT images FROM damage_reports WHERE report_id = ?', [biddings[0].report_id]);
      if (reports.length > 0 && reports[0].images) {
        try {
          beforeImages = typeof reports[0].images === 'string' ? JSON.parse(reports[0].images) : reports[0].images;
        } catch (_) {}
      }
    }
  }

  const contentVal = (m3.content || content || '').trim();
  const objectiveAnswersJson = objectiveSchema.buildObjectiveAnswersPayloadV3(order, m3ForObjective);
  const faultEvidenceJson = JSON.stringify(faultEvidenceImages);
  const toNull = (v) => (v === undefined ? null : v);
  const afterImagesJson = JSON.stringify(Array.isArray(completionArr) ? completionArr : after_images || []);

  const hasFaultCol = await hasColumn(pool, 'reviews', 'fault_evidence_images');
  const hasWeightCol = await hasColumn(pool, 'reviews', 'weight');
  const hasContentQualityCol = await hasColumn(pool, 'reviews', 'content_quality');
  const hasReviewImagesPublicCol = await hasColumn(pool, 'reviews', 'review_images_public');
  const hasPublicMediaCol = await hasColumn(pool, 'reviews', 'review_public_media');
  const hasSystemChecksCol = await hasColumn(pool, 'reviews', 'review_system_checks');

  let cols = `review_id, order_id, shop_id, user_id, type, review_stage, rating,
       ratings_quality, ratings_price, ratings_service, ratings_speed, ratings_parts,
       settlement_list_image, completion_images`;
  if (hasFaultCol) cols += `, fault_evidence_images`;
  cols += `, objective_answers, content, before_images, after_images, is_anonymous`;
  if (hasReviewImagesPublicCol) cols += `, review_images_public`;
  if (hasPublicMediaCol) cols += `, review_public_media`;
  if (hasSystemChecksCol) cols += `, review_system_checks`;
  cols += `, rebate_amount, reward_amount, tax_deducted, rebate_rate, status`;
  if (hasWeightCol) cols += `, weight`;
  if (hasContentQualityCol) cols += `, content_quality`;
  cols += `, content_quality_level, vehicle_model_key, repair_project_key, ai_analysis, created_at`;

  let vals = `?, ?, ?, ?, 1, 'main', ?, ?, ?, ?, ?, ?, ?, ?`;
  if (hasFaultCol) vals += `, ?`;
  vals += `, ?, ?, ?, ?, ?`;
  if (hasReviewImagesPublicCol) vals += `, ?`;
  if (hasPublicMediaCol) vals += `, ?`;
  if (hasSystemChecksCol) vals += `, ?`;
  vals += `, ?, ?, ?, 0, 1`;
  if (hasWeightCol) vals += `, NULL`;
  if (hasContentQualityCol) vals += `, ?`;
  vals += `, ?, ?, ?, ?, NOW()`;

  const aiAnalysisJson =
    usedAiAudit && aiResult?.details ? JSON.stringify(aiResult.details) : null;

  let params = [
    reviewId,
    order_id,
    order.shop_id,
    userId,
    toNull(ratingNum),
    toNull(repairStar),
    toNull(priceStar),
    toNull(ratingNum),
    toNull(ratingNum),
    toNull(partsRatingStar),
    toNull(settlementImage),
    JSON.stringify(Array.isArray(completionArr) ? completionArr : []),
  ];
  if (hasFaultCol) params.push(faultEvidenceJson);
  params.push(JSON.stringify(objectiveAnswersJson), contentVal, JSON.stringify(beforeImages), afterImagesJson, is_anonymous || false);
  if (hasReviewImagesPublicCol) params.push(legacyImgPublic);
  if (hasPublicMediaCol) params.push(JSON.stringify(publicMedia));
  if (hasSystemChecksCol) params.push(systemChecksJson);
  params.push(userReceives, rewardAmount, taxDeducted);
  if (hasContentQualityCol) params.push(contentQuality);
  params.push(toNull(contentQualityLevel), toNull(vehicleModelKey), toNull(repairProjectKey), toNull(aiAnalysisJson));

  if (!order.complexity_level) {
    await pool.execute('UPDATE orders SET complexity_level = ?, order_tier = ? WHERE order_id = ?', [complexityLevel ?? null, orderTier ?? null, order_id]);
  }

  try {
    await pool.execute(`INSERT INTO reviews (${cols}) VALUES (${vals})`, params);
  } catch (e) {
    console.error('[review-service-minimal-v3] insert', e);
    throw e;
  }

  try {
    await reviewEvidenceAlignment.onMainReviewInserted(pool, order_id);
  } catch (err) {
    console.error('[review-service-minimal-v3] evidence alignment', err.message);
  }

  try {
    await shopScore.updateShopScoreAfterReview(pool, order.shop_id, reviewId);
  } catch (err) {
    console.error('[review-service-minimal-v3] shop score', err.message);
  }

  const falseKeys = objectiveSchema.falseObjectiveKeysForAppealsV3(m3);
  if (falseKeys.length > 0) {
    try {
      const hasTable = await hasTableCheck(pool, 'merchant_evidence_requests');
      if (hasTable) {
        const materialAudit = require('./services/material-audit-service');
        const crypto = require('crypto');
        const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000);
        const items = falseKeys.map((key) => ({
          key,
          label: objectiveSchema.QUESTION_LABELS[key] || key,
          penalty: objectiveSchema.PENALTIES[key] ?? 0,
        }));
        for (const item of items) {
          const requestId = 'evr_' + crypto.randomBytes(12).toString('hex');
          await pool.execute(
            `INSERT INTO merchant_evidence_requests (request_id, order_id, review_id, shop_id, question_key, status, deadline)
             VALUES (?, ?, ?, ?, ?, 0, ?)`,
            [requestId, order_id, reviewId, order.shop_id, item.key, deadline]
          );
          const msg = item.penalty > 0
            ? `车主在极简评价中反馈需申诉：${item.label}。请在 48 小时内提交申诉材料，申诉不利将扣 ${item.penalty} 分。`
            : `车主在极简评价中反馈需申诉：${item.label}。请在 48 小时内提交申诉材料（如竣工检验、检测报告等）。`;
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
      console.error('[review-service-minimal-v3] 申诉任务', err.message);
    }
  }

  if (userReceives > 0) {
    await pool.execute(
      'UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?',
      [userReceives, userReceives, userId]
    );
    const hasSrc = await orderRewardCap.hasRewardSourceOrderColumn(pool);
    if (hasSrc) {
      await pool.execute(
        `INSERT INTO transactions (transaction_id, user_id, type, amount, description, related_id, reward_source_order_id, reward_tier, review_stage, tax_deducted, created_at)
         VALUES (?, ?, 'rebate', ?, '主评价奖励金', ?, ?, ?, 'main', ?, NOW())`,
        ['TXN' + Date.now(), userId, userReceives, reviewId, order_id, orderTier ?? null, taxDeducted ?? null]
      );
    } else {
      await pool.execute(
        `INSERT INTO transactions (transaction_id, user_id, type, amount, description, related_id, reward_tier, review_stage, tax_deducted, created_at)
         VALUES (?, ?, 'rebate', ?, '主评价奖励金', ?, ?, 'main', ?, NOW())`,
        ['TXN' + Date.now(), userId, userReceives, reviewId, orderTier ?? null, taxDeducted ?? null]
      );
    }
  }

  try {
    const auditLogger = require('./reward-audit-logger');
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
      user_level: level,
      eligibility_can_receive: eligibility.canReceive,
      eligibility_multiplier: eligibility.multiplier,
      l1_monthly_cap: complexityLevel === 'L1' ? afConfig.l1MonthlyCap : null,
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
        },
        interaction: { settled: false, pipeline: 'monthly_like_bonus', note: '首评提交不落账；见 like_bonus 审计' },
        conversion: {
          settled: false,
          pipeline: 'monthly_conversion_or_post_verify',
          note: '首评提交不落账；见 conversion_bonus / post_verify_bonus 审计',
        },
      },
    });
  } catch (_) {}

  /** 完工阶段已写入 completion_evidence.exterior_repair_analysis 的，不再在评价提交后重复调用千问 */
  if (hasSystemChecksCol && apiKey && systemChecks.appearance?.status === 'pending') {
    const beforeUrls = (beforeImages || []).map((u) => String(u || '').trim()).filter(Boolean);
    const afterUrls = []
      .concat(completionArr || [], Array.isArray(after_images) ? after_images : [])
      .map((u) => String(u || '').trim())
      .filter(Boolean);
    setImmediate(async () => {
      try {
        const appearance = await analyzeExteriorRepairDegreeWithQwen({
          beforeUrls,
          afterUrls,
          apiKey,
        });
        const [r2] = await pool.execute(
          'SELECT objective_answers, review_system_checks FROM reviews WHERE review_id = ?',
          [reviewId]
        );
        let chk = {};
        try {
          chk =
            typeof r2[0]?.review_system_checks === 'string'
              ? JSON.parse(r2[0].review_system_checks)
              : r2[0]?.review_system_checks || {};
        } catch (_) {
          chk = {};
        }
        let oa = {};
        try {
          oa =
            typeof r2[0]?.objective_answers === 'string'
              ? JSON.parse(r2[0].objective_answers)
              : r2[0]?.objective_answers || {};
        } catch (_) {
          oa = {};
        }
        const prevApp = chk.appearance || {};
        const noteLine = appearance.note ? String(appearance.note).trim() : '';
        chk.appearance = {
          ...prevApp,
          ...appearance,
          analysis_text: appearance.analysis_text || noteLine || prevApp.analysis_text || null,
          ai_disclaimer:
            prevApp.ai_disclaimer ||
            '以下外观分析由 AI 生成，仅供参考，不构成鉴定结论。',
          source: 'async_post_review_fallback',
        };
        const m3Stars = {
          process_transparency_star: oa.process_transparency_star,
          quote_transparency_star: oa.quote_transparency_star,
          parts_traceability_star: oa.parts_traceability_star,
          repair_effect_star: oa.repair_effect_star,
          service_experience_star: oa.service_experience_star,
        };
        try {
          const starAiCfg = await getStarAiAnomalyConfig(pool);
          if (starAiCfg.enabled) {
            const next = computeStarAiAnomaly(m3Stars, chk, starAiCfg);
            if (next && next.has_anomaly) chk.star_ai_anomaly = next;
            else delete chk.star_ai_anomaly;
          } else {
            delete chk.star_ai_anomaly;
          }
        } catch (e2) {
          console.error('[review-service-minimal-v3] star_ai_anomaly async recompute', e2.message);
        }
        await pool.execute('UPDATE reviews SET review_system_checks = ? WHERE review_id = ?', [
          jsonStringifyForDb(chk),
          reviewId,
        ]);
      } catch (e) {
        console.error('[review-service-minimal-v3] appearance async', e.message);
      }
    });
  }

  return {
    success: true,
    data: {
      review_id: reviewId,
      reward: {
        amount: userReceives.toFixed(2),
        tax_deducted: taxDeducted,
        stages: orderTier <= 2 ? '100%' : '50%',
      },
      review_form_version: 3,
    },
  };
}

module.exports = {
  submitReviewMinimalV3,
};
