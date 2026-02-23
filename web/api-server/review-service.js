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
 * 评价提交完整流程
 * @param {object} pool - 数据库连接池
 * @param {object} req - Express 请求对象 { userId, body, ip, protocol, get }
 * @param {object} opts - { baseUrl, port } 可选，用于 AI 审核图片 URL 转绝对路径
 * @returns {Promise<{ success: boolean, data?: object, error?: string, statusCode?: number }>}
 */
async function submitReview(pool, req, opts = {}) {
  const { order_id, module1, module2, module3, rating, ratings, content, after_images, is_anonymous } = req.body || {};
  const userId = req.userId;

  if (!order_id) {
    return { success: false, error: '订单ID不能为空', statusCode: 400 };
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

  const [shops] = await pool.execute('SELECT compliance_rate, complaint_rate, name FROM shops WHERE shop_id = ?', [order.shop_id]);
  const shop = shops.length > 0 ? shops[0] : {};

  const rewardResult = await rewardCalculator.calculateReward(pool, order, vehicleInfo, quoteItems, shop);
  let totalReward = rewardResult.reward_pre;
  const orderTier = rewardResult.order_tier;
  const complexityLevel = rewardResult.complexity_level || order.complexity_level || 'L2';

  const isNewFormat = module3 && (module3.settlement_list_image || module3.completion_images);
  const m3 = module3 || {};
  const settlementImage = m3.settlement_list_image || null;
  const completionImages = m3.completion_images || after_images || [];
  const completionArr = Array.isArray(completionImages) ? completionImages : [];
  const ratingNum = m3.ratings ? (m3.ratings.service ?? m3.ratings.price_transparency ?? m3.ratings.quality ?? 5) : (rating || 5);

  if (!isNewFormat && !rating) {
    return { success: false, error: '请完成评价必填项', statusCode: 400 };
  }

  // 全指标 2.2：规则校验（review-validator 纯规则，无 DB/AI）
  const validation = reviewValidator.validateReview({
    complexityLevel,
    rating: ratingNum,
    content: m3.content || content,
    completion_images: completionArr,
    after_images: after_images || completionArr,
    settlement_list_image: settlementImage,
  });
  if (!validation.valid) {
    return { success: false, error: validation.reason || '评价不符合有效评价要求', statusCode: 400 };
  }

  // 全指标 4.5：优质浮动奖励
  const premiumFloat = validation.premium ? rewardCalculator.calcPremiumFloatReward(rewardResult.reward_pre, true) : 0;
  totalReward += premiumFloat;
  const maxByCommission = (rewardResult.commission_amount || 0) * 0.7;
  if (maxByCommission > 0) totalReward = Math.min(totalReward, maxByCommission);

  // AI 审核（千问）或内容反作弊兜底
  const contentForCheck = (m3.content || content || '').trim();
  const apiKey = process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '';
  let usedAiAudit = false;
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
        review: { content: contentForCheck, rating: ratingNum, isNegative },
        images: [],
      };
      if (settlementImage && settlementImage.trim()) {
        aiInput.images.push({ type: 'settlement', url: toAbsolute(settlementImage) });
      }
      (completionArr || []).slice(0, 5).forEach((url) => {
        if (url && String(url).trim()) aiInput.images.push({ type: 'completion', url: toAbsolute(url) });
      });
      const { analyzeReviewWithQwen } = require('./qwen-analyzer');
      const aiResult = await analyzeReviewWithQwen({ ...aiInput, apiKey });
      usedAiAudit = true;
      if (!aiResult.pass) {
        return { success: false, error: aiResult.rejectReason || '评价未通过 AI 审核', statusCode: 400 };
      }
    } catch (err) {
      console.error('[review-service] 千问 AI 审核异常，回退规则校验:', err.message);
    }
  }
  if (!usedAiAudit && contentForCheck) {
    const contentCheck = await antifraud.checkContentAntiCheat(pool, contentForCheck);
    if (!contentCheck.pass) {
      return { success: false, error: contentCheck.reason || '评价内容不符合要求', statusCode: 400 };
    }
  }

  const immediatePercent = orderTier <= 2 ? 1 : 0.5;
  let rewardAmount = totalReward * immediatePercent;

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
  const userReceives = rewardAmount - taxDeducted;
  const objectiveAnswers = m3.q1_shop_match != null
    ? {
        q1_shop_match: m3.q1_shop_match,
        q2_settlement_match: m3.q2_settlement_match,
        q3_fault_resolved: m3.q3_fault_resolved,
        q4_warranty_informed: m3.q4_warranty_informed,
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

  const contentQuality = validation.premium ? 'premium' : 'valid';
  const reviewId = 'REV' + Date.now();
  await pool.execute(
    `INSERT INTO reviews (review_id, order_id, shop_id, user_id, type, review_stage, rating,
     ratings_quality, ratings_price, ratings_service, ratings_speed, ratings_parts,
     settlement_list_image, completion_images, objective_answers,
     content, before_images, after_images, is_anonymous, rebate_amount, reward_amount, tax_deducted, rebate_rate, status, weight, content_quality, created_at)
     VALUES (?, ?, ?, ?, 1, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, NULL, ?, NOW())`,
    [
      reviewId,
      order_id,
      order.shop_id,
      userId,
      ratingVal,
      ratingsObj?.quality,
      ratingsObj?.price,
      ratingsObj?.service,
      ratingsObj?.speed,
      ratingsObj?.parts,
      settlementImage,
      JSON.stringify(Array.isArray(completionImages) ? completionImages : []),
      JSON.stringify(objectiveAnswers || {}),
      contentVal,
      JSON.stringify(beforeImages),
      JSON.stringify(Array.isArray(completionImages) ? completionImages : after_images || []),
      is_anonymous || false,
      userReceives,
      rewardAmount,
      taxDeducted,
      contentQuality,
    ]
  );

  try {
    await shopScore.updateShopScoreAfterReview(pool, order.shop_id, reviewId);
  } catch (err) {
    console.error('[review-service] 更新店铺得分失败:', err.message);
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

module.exports = {
  submitReview,
};
