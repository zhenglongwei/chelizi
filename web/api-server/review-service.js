/**
 * 评价提交流程服务
 * 编排：规则校验(review-validator) + AI审核(qwen) / 内容反作弊(antifraud) + 奖励计算 + 入库
 * review-validator 保持纯规则校验，本模块负责 DB/AI 等依赖
 */

const reviewValidator = require('./review-validator');
const rewardCalculator = require('./reward-calculator');
const antifraud = require('./antifraud');
const shopScore = require('./shop-score');

/**
 * 4级爆款前置：构建车型键（用于同车型同项目统计）
 * @param {object} vehicleInfo - biddings.vehicle_info { brand, model }
 * @returns {string|null} brand|model 或 null
 */
function buildVehicleModelKey(vehicleInfo) {
  if (!vehicleInfo || typeof vehicleInfo !== 'object') return null;
  const brand = String(vehicleInfo.brand || '').trim();
  const model = String(vehicleInfo.model || '').trim();
  if (!brand && !model) return null;
  return `${brand || ''}|${model || ''}`;
}

/**
 * 4级爆款前置：构建维修项目键（用于同车型同项目统计）
 * @param {Array} items - [{ damage_part, repair_type, name? }]
 * @returns {string|null} 排序后的 damage_part:repair_type 组合
 */
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

/**
 * 强行提交：存储为无效评价（status=0 仅商户可见，无奖励金，不计入店铺得分）
 */
async function storeInvalidReview(pool, req, ctx) {
  const {
    order_id, order, m3, module2, module3, rating, ratings, content, after_images, is_anonymous,
    completionImages, completionArr, settlementImage, faultEvidenceImages, rewardResult, orderTier, complexityLevel,
    vehicleModelKey, repairProjectKey, quoteItems,
  } = ctx;
  const userId = req.userId;
  const reviewId = 'REV' + Date.now();
  const ratingNum = m3.ratings ? (m3.ratings.service ?? m3.ratings.price_transparency ?? m3.ratings.quality ?? 5) : (rating || 5);
  const ratingsObj = m3.ratings || ratings;
  const contentVal = (m3.content || content || '').trim();
  const objectiveAnswers = {
    q1_progress_synced: m3.q1_progress_synced,
    q2_parts_shown: m3.q2_parts_shown,
    q3_fault_resolved: m3.q3_fault_resolved,
  };
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
  const completionUrls = Array.isArray(module3.completion_images) ? module3.completion_images : completionArr || [];
  const settlementUrl = settlementImage || (module3.settlement_list_image && typeof module3.settlement_list_image === 'string' && module3.settlement_list_image.startsWith('http') ? module3.settlement_list_image : '');
  const faultEvidenceUrls = Array.isArray(faultEvidenceImages) ? faultEvidenceImages : (Array.isArray(m3.fault_evidence_images) ? m3.fault_evidence_images : []);
  const insertParams = [
    reviewId, order_id, order.shop_id, userId, ratingNum,
    ratingsObj?.quality, ratingsObj?.price, ratingsObj?.service, ratingsObj?.speed, ratingsObj?.parts,
    settlementUrl,
    JSON.stringify(completionUrls),
    JSON.stringify(faultEvidenceUrls),
    JSON.stringify(objectiveAnswers),
    contentVal,
    JSON.stringify(beforeImages),
    JSON.stringify(completionUrls),
    is_anonymous || false, 0, 0, 0,
    'invalid', 0, vehicleModelKey, repairProjectKey, null,
  ];
  const hasFaultCol = await hasColumn(pool, 'reviews', 'fault_evidence_images');
  try {
    if (hasFaultCol) {
      await pool.execute(
        `INSERT INTO reviews (review_id, order_id, shop_id, user_id, type, review_stage, rating,
         ratings_quality, ratings_price, ratings_service, ratings_speed, ratings_parts,
         settlement_list_image, completion_images, fault_evidence_images, objective_answers,
         content, before_images, after_images, is_anonymous, rebate_amount, reward_amount, tax_deducted, rebate_rate, status, weight, content_quality, content_quality_level, vehicle_model_key, repair_project_key, ai_analysis, created_at)
         VALUES (?, ?, ?, ?, 1, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, ?, ?, ?, NOW())`,
        insertParams
      );
    } else {
      insertParams.splice(11, 1);
      await pool.execute(
        `INSERT INTO reviews (review_id, order_id, shop_id, user_id, type, review_stage, rating,
         ratings_quality, ratings_price, ratings_service, ratings_speed, ratings_parts,
         settlement_list_image, completion_images, objective_answers,
         content, before_images, after_images, is_anonymous, rebate_amount, reward_amount, tax_deducted, rebate_rate, status, weight, content_quality, content_quality_level, vehicle_model_key, repair_project_key, ai_analysis, created_at)
         VALUES (?, ?, ?, ?, 1, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, ?, ?, ?, NOW())`,
        insertParams
      );
    }
  } catch (insertErr) {
    console.error('[review-service] storeInvalidReview insert error:', insertErr.message);
    return { success: false, error: '提交失败，请稍后重试', statusCode: 500 };
  }
  return {
    success: true,
    data: {
      review_id: reviewId,
      reward: { amount: 0 },
      is_invalid: true,
    },
    message: '评价已保存，未达有效标准，无法获得奖励金',
  };
}

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

/**
 * 评价提交完整流程
 * @param {object} pool - 数据库连接池
 * @param {object} req - Express 请求对象 { userId, body, ip, protocol, get }
 * @param {object} opts - { baseUrl, port } 可选，用于 AI 审核图片 URL 转绝对路径
 * @returns {Promise<{ success: boolean, data?: object, error?: string, statusCode?: number }>}
 */
async function submitReview(pool, req, opts = {}) {
  const { order_id, module1, module2, module3, rating, ratings, content, after_images, is_anonymous, force_submit } = req.body || {};
  const userId = req.userId;

  if (!order_id) {
    return { success: false, error: '订单ID不能为空', statusCode: 400 };
  }
  // 0 级禁止评价（点赞追加奖金方案：0级仅浏览，禁止下单/评价；点赞保持开放）
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

  // 防刷：黑名单校验
  const ip = req.ip || req.headers?.['x-forwarded-for'] || '';
  const [userForBl] = await pool.execute('SELECT phone FROM users WHERE user_id = ?', [userId]);
  const bl = await antifraud.checkBlacklist(pool, userId, userForBl[0]?.phone, ip);
  if (bl.blocked) {
    return { success: false, error: bl.reason || '账号存在异常，暂无法评价', statusCode: 403 };
  }

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
  // 维修项目优先用 repair_plan（实际执行方案），无则用 quote
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

  const m3 = module3 || {};
  const hasObjectiveAnswers = m3.q1_progress_synced != null && m3.q2_parts_shown != null && m3.q3_fault_resolved != null;
  const isNewFormat = module3 && hasObjectiveAnswers;
  const settlementImage = m3.settlement_list_image || null;
  const completionImages = m3.completion_images || after_images || [];
  const completionArr = Array.isArray(completionImages) ? completionImages : [];
  const faultEvidenceImages = Array.isArray(m3.fault_evidence_images) ? m3.fault_evidence_images : [];
  const ratingNum = m3.ratings ? (m3.ratings.service ?? m3.ratings.price_transparency ?? m3.ratings.quality ?? 5) : (rating || 5);

  const validationError = !isNewFormat && !rating ? '请完成 3 道必答客观题' : null;
  let validation = validationError ? null : reviewValidator.validateReview({
    complexityLevel,
    rating: ratingNum,
    content: m3.content || content,
    completion_images: completionArr,
    after_images: after_images || completionArr,
    settlement_list_image: settlementImage,
  });
  if (!validation) validation = { valid: false, reason: validationError };
  const shouldStoreInvalid = !!force_submit && !validation.valid;
  if (!validation.valid && !shouldStoreInvalid) {
    return { success: false, error: validation.reason || '评价不符合有效评价要求', statusCode: 400 };
  }
  if (shouldStoreInvalid) {
    return await storeInvalidReview(pool, req, {
      order_id, order, m3, module2, module3, rating, ratings, content, after_images, is_anonymous,
      completionImages, completionArr, settlementImage, faultEvidenceImages, rewardResult, orderTier, complexityLevel,
      vehicleModelKey, repairProjectKey, quoteItems,
    });
  }

  // 优质浮动奖励：先不叠加，等 AI 审核后由 AI contentQuality 或规则 premium 决定
  // 用户等级体系 6.3：2级80% 3级90% 4级100% 封顶；1级及以下沿用50%/70%
  const eligibility = await antifraud.getRewardEligibility(pool, userId);
  const level = eligibility.level;
  const commissionCapRatio = level >= 4 ? 1.0 : level >= 3 ? 0.9 : level >= 2 ? 0.8 : 0.7;
  const maxByCommission = (rewardResult.commission_amount || 0) * commissionCapRatio;
  if (maxByCommission > 0) totalReward = Math.min(totalReward, maxByCommission);

  // AI 审核（千问）或内容反作弊兜底
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
      const isNegative = parseFloat(ratingNum) <= 2;
      const aiInput = {
        order: {
          orderId: order_id,
          shopName: shop.name || '',
          quotedAmount: quotedAmount,
          repairProjects: repairProjects.length ? repairProjects : ['维修'],
          complexityLevel,
          faultDescription: '',
        },
        review: {
          content: contentForCheck,
          rating: ratingNum,
          isNegative,
          objectiveAnswers: {
            progressSynced: m3.q1_progress_synced,
            partsShown: m3.q2_parts_shown,
            faultResolved: m3.q3_fault_resolved,
          },
        },
        images: [],
      };
      if (settlementImage && settlementImage.trim()) {
        aiInput.images.push({ type: 'settlement', url: toAbsolute(settlementImage) });
      }
      (completionArr || []).slice(0, 5).forEach((url) => {
        if (url && String(url).trim()) aiInput.images.push({ type: 'completion', url: toAbsolute(url) });
      });
      const { analyzeReviewWithQwen } = require('./qwen-analyzer');
      aiResult = await analyzeReviewWithQwen({ ...aiInput, apiKey });
      usedAiAudit = true;
      if (!aiResult.pass && !force_submit) {
        return { success: false, error: aiResult.rejectReason || '评价未通过 AI 审核', statusCode: 400 };
      }
      if (!aiResult.pass && force_submit) {
        return await storeInvalidReview(pool, req, {
          order_id, order, m3, module2, module3, rating, ratings, content, after_images, is_anonymous,
          completionImages, completionArr, settlementImage, faultEvidenceImages, rewardResult, orderTier, complexityLevel,
          vehicleModelKey, repairProjectKey, quoteItems,
        });
      }
    } catch (err) {
      console.error('[review-service] 千问 AI 审核异常，回退规则校验:', err.message);
    }
  }
  if (!usedAiAudit && contentForCheck) {
    const contentCheck = await antifraud.checkContentAntiCheat(pool, contentForCheck);
    if (!contentCheck.pass && !force_submit) {
      return { success: false, error: contentCheck.reason || '评价内容不符合要求', statusCode: 400 };
    }
    if (!contentCheck.pass && force_submit) {
      return await storeInvalidReview(pool, req, {
        order_id, order, m3, module2, module3, rating, ratings, content, after_images, is_anonymous,
        completionImages, completionArr, settlementImage, faultEvidenceImages, rewardResult, orderTier, complexityLevel,
        vehicleModelKey, repairProjectKey, quoteItems,
      });
    }
  }

  // 内容质量与优质奖励：AI 优先，否则用规则。1-3 级对应 content_quality_level
  const aiQuality = usedAiAudit && aiResult?.details?.contentQuality?.quality;
  let contentQuality;
  let contentQualityLevel;
  let isPremium;
  if (usedAiAudit && aiQuality) {
    // AI 返回：invalid|basic|quality|benchmark|维权参考
    if (aiQuality === 'benchmark') {
      contentQuality = '标杆';
      contentQualityLevel = 3;
    } else if (aiQuality === 'quality') {
      contentQuality = 'premium';
      contentQualityLevel = 2;
    } else if (aiQuality === '维权参考') {
      contentQuality = '维权参考';
      contentQualityLevel = 2;
    } else {
      contentQuality = 'valid';
      contentQualityLevel = 1;
    }
    isPremium = contentQualityLevel >= 2;
  } else {
    contentQuality = validation.premium ? 'premium' : 'valid';
    contentQualityLevel = validation.premium ? 2 : 1;
    isPremium = validation.premium;
  }
  // 用户举证提升内容等级（商户合规与申诉 阶段4）：q3选否且上传故障凭证 → 1级提升为维权参考2级
  if (m3.q3_fault_resolved === false && faultEvidenceImages.length > 0 && contentQualityLevel === 1) {
    contentQuality = '维权参考';
    contentQualityLevel = 2;
    isPremium = true;
  }
  const premiumFloat = isPremium ? rewardCalculator.calcPremiumFloatReward(rewardResult.reward_pre, true) : 0;
  totalReward += premiumFloat;
  if (maxByCommission > 0) totalReward = Math.min(totalReward, maxByCommission);

  const immediatePercent = orderTier <= 2 ? 1 : 0.5;
  let rewardAmount = totalReward * immediatePercent;

  // 用户等级：0级不发、1级50%、2级及以上全额（eligibility 已在上方获取）
  const [userRow] = await pool.execute(
    'SELECT level_demoted_by_violation FROM users WHERE user_id = ?',
    [userId]
  ).catch(() => [[{ level_demoted_by_violation: 0 }]]);
  const demotedByViolation = userRow?.[0]?.level_demoted_by_violation === 1;

  if (!eligibility.canReceive) {
    rewardAmount = 0;
  } else if (eligibility.multiplier < 1) {
    rewardAmount = Math.round(rewardAmount * eligibility.multiplier * 100) / 100;
  }

  // L1 每月奖励金封顶
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

  const taxDeducted = rewardAmount > 800 ? Math.round((rewardAmount - 800) * 0.2 * 100) / 100 : 0;
  let userReceives = rewardAmount - taxDeducted;

  const reviewId = 'REV' + Date.now();

  // 0级因未实名/车辆暂扣：记录待回溯奖励，完成认证后可补发（违规降级的不补发）
  let shouldWithhold = false;
  if (eligibility.level === 0 && rewardAmount === 0 && !demotedByViolation) {
    const trust = await antifraud.getUserTrustLevel(pool, userId);
    shouldWithhold = trust.needsVerification === true;
  }
  if (shouldWithhold) {
    const potentialForL1 = Math.round(totalReward * immediatePercent * 100) / 100;
    let withholdAmount = potentialForL1;
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
    withholdAmount = Math.round(withholdAmount * 0.5 * 100) / 100; // 1级50%
    const withholdTax = withholdAmount > 800 ? Math.round((withholdAmount - 800) * 0.2 * 100) / 100 : 0;
    const withholdReceives = Math.round((withholdAmount - withholdTax) * 100) / 100;
    if (withholdReceives > 0) {
      try {
        await pool.execute(
          `INSERT INTO withheld_rewards (user_id, review_id, order_id, amount, tax_deducted, user_receives, status, reason)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', 'no_verification')`,
          [userId, reviewId, order_id, withholdAmount, withholdTax, withholdReceives]
        );
      } catch (e) {
        console.error('[review-service] 写入待回溯奖励失败:', e.message);
      }
    }
  }
  const objectiveAnswers = m3.q1_progress_synced != null
    ? {
        q1_progress_synced: m3.q1_progress_synced,
        q2_parts_shown: m3.q2_parts_shown,
        q3_fault_resolved: m3.q3_fault_resolved,
      }
    : null;

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

  const ratingVal = m3.ratings ? (m3.ratings.price_transparency || m3.ratings.service) : rating;
  const ratingsObj = m3.ratings || ratings;
  const contentVal = m3.content || content || '';

  if (!order.complexity_level) {
    await pool.execute('UPDATE orders SET complexity_level = ?, order_tier = ? WHERE order_id = ?', [complexityLevel, orderTier, order_id]);
  }
  const aiAnalysisJson = usedAiAudit && aiResult?.details ? JSON.stringify(aiResult.details) : null;
  const faultEvidenceJson = JSON.stringify(faultEvidenceImages);
  const insertParams = [
    reviewId, order_id, order.shop_id, userId, ratingVal,
    ratingsObj?.quality, ratingsObj?.price, ratingsObj?.service, ratingsObj?.speed, ratingsObj?.parts,
    settlementImage,
    JSON.stringify(Array.isArray(completionImages) ? completionImages : []),
    faultEvidenceJson,
    JSON.stringify(objectiveAnswers || {}),
    contentVal,
    JSON.stringify(beforeImages),
    JSON.stringify(Array.isArray(completionImages) ? completionImages : after_images || []),
    is_anonymous || false, userReceives, rewardAmount, taxDeducted,
    contentQuality, contentQualityLevel, vehicleModelKey, repairProjectKey, aiAnalysisJson,
  ];
  try {
    await pool.execute(
      `INSERT INTO reviews (review_id, order_id, shop_id, user_id, type, review_stage, rating,
       ratings_quality, ratings_price, ratings_service, ratings_speed, ratings_parts,
       settlement_list_image, completion_images, fault_evidence_images, objective_answers,
       content, before_images, after_images, is_anonymous, rebate_amount, reward_amount, tax_deducted, rebate_rate, status, weight, content_quality, content_quality_level, vehicle_model_key, repair_project_key, ai_analysis, created_at)
       VALUES (?, ?, ?, ?, 1, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, NULL, ?, ?, ?, ?, ?, NOW())`,
      insertParams
    );
  } catch (insertErr) {
    if (String(insertErr.message || '').includes('fault_evidence_images')) {
      insertParams.splice(11, 1);
      await pool.execute(
        `INSERT INTO reviews (review_id, order_id, shop_id, user_id, type, review_stage, rating,
         ratings_quality, ratings_price, ratings_service, ratings_speed, ratings_parts,
         settlement_list_image, completion_images, objective_answers,
         content, before_images, after_images, is_anonymous, rebate_amount, reward_amount, tax_deducted, rebate_rate, status, weight, content_quality, content_quality_level, vehicle_model_key, repair_project_key, ai_analysis, created_at)
         VALUES (?, ?, ?, ?, 1, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, NULL, ?, ?, ?, ?, ?, NOW())`,
        insertParams
      );
    } else {
      throw insertErr;
    }
  }

  try {
    await shopScore.updateShopScoreAfterReview(pool, order.shop_id, reviewId);
  } catch (err) {
    console.error('[review-service] 更新店铺得分失败:', err.message);
  }

  // 商户申诉：用户选「否」时创建申诉任务，48h 内申诉
  const q1False = m3.q1_progress_synced === false;
  const q2False = m3.q2_parts_shown === false;
  const q3False = m3.q3_fault_resolved === false;
  if (q1False || q2False || q3False) {
    try {
      const hasTable = await hasTableCheck(pool, 'merchant_evidence_requests');
      if (hasTable) {
        const materialAudit = require('./services/material-audit-service');
        const crypto = require('crypto');
        const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000);
        const questionLabels = {
          q1_progress_synced: '维修进度是否与您同步',
          q2_parts_shown: '是否展示新旧配件',
          q3_fault_resolved: '车辆问题是否已完全解决'
        };
        const penalties = { q1_progress_synced: 5, q2_parts_shown: 15 };
        const items = [];
        if (q1False) items.push({ key: 'q1_progress_synced', label: questionLabels.q1_progress_synced, penalty: penalties.q1_progress_synced });
        if (q2False) items.push({ key: 'q2_parts_shown', label: questionLabels.q2_parts_shown, penalty: penalties.q2_parts_shown });
        if (q3False) items.push({ key: 'q3_fault_resolved', label: questionLabels.q3_fault_resolved, penalty: 0 });
        for (const item of items) {
          const requestId = 'evr_' + crypto.randomBytes(12).toString('hex');
          await pool.execute(
            `INSERT INTO merchant_evidence_requests (request_id, order_id, review_id, shop_id, question_key, status, deadline)
             VALUES (?, ?, ?, ?, ?, 0, ?)`,
            [requestId, order_id, reviewId, order.shop_id, item.key, deadline]
          );
          const msg = item.penalty > 0
            ? `车主在评价中选择了「否」：${item.label}。请在 48 小时内提交申诉材料，申诉不利将扣 ${item.penalty} 分。`
            : `车主在评价中选择了「否」：${item.label}。请在 48 小时内提交申诉材料（如竣工检验、检测报告等）。`;
          await materialAudit.sendMerchantMessage(
            pool, order.shop_id, 'evidence_request',
            '需对评价中的项目申诉',
            msg,
            order_id
          );
        }
      }
    } catch (err) {
      console.error('[review-service] 创建商户申诉任务失败:', err.message);
    }
  }

  if (userReceives > 0) {
    await pool.execute(
      'UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?',
      [userReceives, userReceives, userId]
    );
    await pool.execute(
      `INSERT INTO transactions (transaction_id, user_id, type, amount, description, related_id, reward_tier, review_stage, tax_deducted, created_at)
       VALUES (?, ?, 'rebate', ?, '主评价奖励金', ?, ?, 'main', ?, NOW())`,
      ['TXN' + Date.now(), userId, userReceives, reviewId, orderTier, taxDeducted]
    );
  }

  try {
    await pool.execute(
      `INSERT INTO review_audit_logs (review_id, audit_type, result, created_at) VALUES (?, 'ai', 'pass', NOW())`,
      [reviewId]
    );
  } catch (_) {}

  // 奖励金审计日志（REWARD_AUDIT_LOG=1 启用）
  try {
    const auditLogger = require('./reward-audit-logger');
    let currentMonthL1 = null;
    let l1Cap = null;
    if (complexityLevel === 'L1') {
      const [l1Sum] = await pool.execute(
        `SELECT COALESCE(SUM(t.amount), 0) as total FROM transactions t
         JOIN reviews r ON t.related_id = r.review_id
         JOIN orders o ON r.order_id = o.order_id
         WHERE t.user_id = ? AND t.type = 'rebate' AND t.created_at >= ?
         AND o.complexity_level = 'L1'`,
        [userId, new Date(new Date().getFullYear(), new Date().getMonth(), 1)]
      );
      const sumNow = parseFloat(l1Sum[0]?.total || 0);
      currentMonthL1 = userReceives > 0 ? Math.max(0, sumNow - userReceives) : sumNow;
      l1Cap = (await antifraud.getAntifraudConfig(pool)).l1MonthlyCap;
    }
    auditLogger.logReviewSubmit({
      review_id: reviewId,
      order_id: order_id,
      user_id: userId,
      reward_pre: rewardResult.reward_pre,
      reward_base: rewardResult.reward_pre,
      order_tier: orderTier,
      complexity_level: complexityLevel,
      commission_rate: rewardResult.commission_rate,
      commission_amount: rewardResult.commission_amount,
      vehicle_price_tier: rewardResult.vehicle_price_tier,
      content_quality: contentQuality,
      content_quality_level: contentQualityLevel,
      is_premium: isPremium,
      premium_float: premiumFloat,
      total_reward: totalReward,
      max_by_commission: maxByCommission,
      immediate_percent: immediatePercent,
      user_level: level,
      eligibility_can_receive: eligibility.canReceive,
      eligibility_multiplier: eligibility.multiplier,
      l1_monthly_cap: l1Cap,
      current_month_l1: currentMonthL1,
      reward_amount_before_tax: rewardAmount,
      tax_deducted: taxDeducted,
      user_receives: userReceives,
    });
  } catch (_) {}

  return {
    success: true,
    data: {
      review_id: reviewId,
      reward: {
        amount: userReceives.toFixed(2),
        tax_deducted: taxDeducted,
        stages: orderTier <= 2 ? '100%' : '50%',
      },
    },
  };
}

/**
 * 追评提交后：主评价+追评整体重评估，回写主评价 content_quality
 * 按《02-评价内容质量等级体系》整体性评估原则
 * @param {object} pool - 数据库连接池
 * @param {string} orderId - 订单ID
 * @param {object} opts - { baseUrl, port }
 * @returns {Promise<void>}
 */
async function recomputeHolisticContentQuality(pool, orderId, opts = {}) {
  const apiKey = process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '';
  if (!apiKey) return;

  try {
    const [mains] = await pool.execute(
      'SELECT review_id, user_id, content, settlement_list_image, completion_images, rating, content_quality_level FROM reviews WHERE order_id = ? AND type = 1',
      [orderId]
    );
    if (mains.length === 0) return;
    const main = mains[0];

    const [followups] = await pool.execute(
      'SELECT review_stage, content FROM reviews WHERE order_id = ? AND type = 2 ORDER BY review_stage',
      [orderId]
    );
    const parts = [String(main.content || '').trim()];
    for (const f of followups) {
      const label = f.review_stage === '3m' ? '3个月追评' : '1个月追评';
      parts.push(`\n\n[${label}]\n${String(f.content || '').trim()}`);
    }
    const combinedContent = parts.join('').trim();
    if (!combinedContent) return;

    const [orders] = await pool.execute(
      'SELECT o.order_id, o.quoted_amount, o.actual_amount, o.complexity_level, s.name as shop_name FROM orders o LEFT JOIN shops s ON o.shop_id = s.shop_id WHERE o.order_id = ?',
      [orderId]
    );
    const order = orders[0];
    if (!order) return;

    let quoteItems = [];
    const [ord] = await pool.execute('SELECT quote_id FROM orders WHERE order_id = ?', [orderId]);
    if (ord[0]?.quote_id) {
      const [quotes] = await pool.execute('SELECT items FROM quotes WHERE quote_id = ?', [ord[0].quote_id]);
      if (quotes[0]?.items) {
        try {
          quoteItems = typeof quotes[0].items === 'string' ? JSON.parse(quotes[0].items) : (quotes[0].items || []);
        } catch (_) {}
      }
    }
    const repairProjects = (quoteItems || []).map((i) => i.name || '').filter(Boolean);
    const quotedAmount = parseFloat(order.quoted_amount || order.actual_amount) || 0;
    const complexityLevel = order.complexity_level || 'L2';
    const rating = parseFloat(main.rating) || 5;
    const isNegative = rating <= 2;

    const baseUrl = opts.baseUrl || (process.env.BASE_URL || `http://localhost:${opts.port || 3000}`);
    const toAbsolute = (u) => {
      const s = String(u || '').trim();
      if (!s) return '';
      if (s.startsWith('http')) return s;
      return (baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl) + (s.startsWith('/') ? s : '/' + s);
    };

    const images = [];
    if (main.settlement_list_image) images.push({ type: 'settlement', url: toAbsolute(main.settlement_list_image) });
    const completionArr = main.completion_images ? (typeof main.completion_images === 'string' ? JSON.parse(main.completion_images || '[]') : main.completion_images) : [];
    (completionArr || []).slice(0, 5).forEach((url) => {
      if (url) images.push({ type: 'completion', url: toAbsolute(url) });
    });

    const { analyzeReviewWithQwen } = require('./qwen-analyzer');
    const aiResult = await analyzeReviewWithQwen({
      order: {
        orderId,
        shopName: order.shop_name || '',
        quotedAmount,
        repairProjects: repairProjects.length ? repairProjects : ['维修'],
        complexityLevel,
        faultDescription: '',
      },
      review: { content: combinedContent, rating, isNegative },
      images,
      apiKey,
    });

    if (!aiResult.pass) return;
    const aiQuality = aiResult.details?.contentQuality?.quality;
    if (!aiQuality) return;

    let contentQuality;
    let contentQualityLevel;
    if (aiQuality === 'benchmark') {
      contentQuality = '标杆';
      contentQualityLevel = 3;
    } else if (aiQuality === 'quality') {
      contentQuality = 'premium';
      contentQualityLevel = 2;
    } else if (aiQuality === '维权参考') {
      contentQuality = '维权参考';
      contentQualityLevel = 2;
    } else {
      contentQuality = 'valid';
      contentQualityLevel = 1;
    }
    const oldLevel = parseInt(main.content_quality_level, 10) || 1;
    await pool.execute('UPDATE reviews SET content_quality = ?, content_quality_level = ? WHERE review_id = ?', [contentQuality, contentQualityLevel, main.review_id]);

    if (contentQualityLevel > oldLevel) {
      try {
        const settlementService = require('./services/settlement-service');
        const [txnRows] = await pool.execute(
          "SELECT COALESCE(SUM(t.amount), 0) as paid FROM transactions t WHERE t.related_id = ? AND t.type IN ('rebate', 'upgrade_diff')",
          [main.review_id]
        );
        const paid = parseFloat(txnRows[0]?.paid || 0);

        let vehicleInfo = {};
        const [bidRows] = await pool.execute('SELECT bidding_id FROM orders WHERE order_id = ?', [orderId]);
        if (bidRows[0]?.bidding_id) {
          const [bids] = await pool.execute('SELECT vehicle_info FROM biddings WHERE bidding_id = ?', [bidRows[0].bidding_id]);
          if (bids[0]?.vehicle_info) {
            try {
              vehicleInfo = typeof bids[0].vehicle_info === 'string' ? JSON.parse(bids[0].vehicle_info) : bids[0].vehicle_info;
            } catch (_) {}
          }
        }
        const shop = {};
        const [shopRows] = await pool.execute('SELECT compliance_rate, complaint_rate FROM shops WHERE shop_id = (SELECT shop_id FROM orders WHERE order_id = ?)', [orderId]);
        if (shopRows[0]) Object.assign(shop, shopRows[0]);

        const rewardResult = await rewardCalculator.calculateReward(pool, order, vehicleInfo, quoteItems, shop);
        const floatRatio = contentQualityLevel >= 3 ? 1.0 : contentQualityLevel >= 2 ? 0.5 : 0;
        const shouldGet = rewardResult.reward_pre * (1 + floatRatio);
        const diff = Math.round((shouldGet - paid) * 100) / 100;
        if (diff > 0) {
          const taxDeducted = diff > 800 ? Math.round((diff - 800) * 0.2 * 100) / 100 : 0;
          const afterTax = Math.round((diff - taxDeducted) * 100) / 100;
          const now = new Date();
          const triggerMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
          const calcReason = `${oldLevel}级→${contentQualityLevel}级，补发${diff.toFixed(2)}元`;
          await settlementService.insertUpgradeDiffPending(pool, {
            userId: main.user_id,
            reviewId: main.review_id,
            orderId,
            amountBeforeTax: diff,
            taxDeducted,
            amountAfterTax: afterTax,
            calcReason,
            triggerMonth,
          });
        }
      } catch (e) {
        console.error('[review-service] 评价升级差额待结算写入异常:', e.message);
      }
    }

    const shopScore = require('./shop-score');
    const [mainRow] = await pool.execute('SELECT shop_id FROM reviews WHERE review_id = ?', [main.review_id]);
    if (mainRow[0]?.shop_id) {
      await shopScore.updateShopScoreAfterReview(pool, mainRow[0].shop_id, main.review_id);
    }
  } catch (err) {
    console.error('[review-service] 整体重评估异常:', err.message);
  }
}

module.exports = {
  submitReview,
  recomputeHolisticContentQuality,
};
