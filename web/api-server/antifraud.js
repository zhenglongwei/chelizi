/**
 * 防刷服务 - 第二阶段
 * 黑名单校验、账号可信度、防刷配置读取
 */

/**
 * 检查用户是否在黑名单
 * @param {object} pool - 数据库连接池
 * @param {string} userId - 用户ID
 * @param {string} [phone] - 手机号（可选）
 * @param {string} [ip] - IP（可选）
 * @returns {Promise<{blocked: boolean, reason?: string}>}
 */
async function checkBlacklist(pool, userId, phone, ip) {
  try {
    const checks = [{ type: 'user_id', value: userId }];
    if (phone && String(phone).trim()) checks.push({ type: 'phone', value: String(phone).trim() });
    if (ip && String(ip).trim()) checks.push({ type: 'ip', value: String(ip).trim() });

    for (const c of checks) {
      const [rows] = await pool.execute(
        'SELECT reason FROM blacklist WHERE blacklist_type = ? AND blacklist_value = ?',
        [c.type, c.value]
      );
      if (rows.length > 0) {
        return { blocked: true, reason: rows[0].reason || '账号存在异常，暂无法使用' };
      }
    }
    return { blocked: false };
  } catch (err) {
    console.error('[antifraud] checkBlacklist error:', err.message);
    return { blocked: false };
  }
}

/**
 * 获取用户账号可信度等级与权重系数
 * 规范：高风险0、新用户0.3、普通活跃1.0、核心可信2.0
 * @param {object} pool - 数据库连接池
 * @param {string} userId - 用户ID
 * @returns {Promise<{level: string, weight: number}>}
 */
async function getUserTrustLevel(pool, userId) {
  try {
    const [userRows] = await pool.execute(
      'SELECT created_at FROM users WHERE user_id = ?',
      [userId]
    );
    if (userRows.length === 0) return { level: 'high_risk', weight: 0 };

    const createdAt = new Date(userRows[0].created_at);
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [orderCount] = await pool.execute(
      `SELECT COUNT(*) as c FROM orders WHERE user_id = ? AND status = 3`,
      [userId]
    );
    const [reviewCount] = await pool.execute(
      `SELECT COUNT(*) as c FROM reviews r JOIN orders o ON r.order_id = o.order_id WHERE r.user_id = ? AND r.type = 1`,
      [userId]
    );
    const validOrders = orderCount[0]?.c || 0;
    const validReviews = reviewCount[0]?.c || 0;

    if (createdAt > sevenDaysAgo && validOrders <= 2 && validReviews === 0) {
      return { level: 'new_user', weight: 0.3 };
    }
    if (validOrders >= 10 && validReviews >= 3) {
      return { level: 'core_trusted', weight: 2.0 };
    }
    if (validOrders >= 3 && validReviews >= 2) {
      return { level: 'normal_active', weight: 1.0 };
    }
    return { level: 'new_user', weight: 0.3 };
  } catch (err) {
    console.error('[antifraud] getUserTrustLevel error:', err.message);
    return { level: 'new_user', weight: 0.3 };
  }
}

/**
 * 从 settings 读取防刷配置
 */
async function getAntifraudConfig(pool) {
  try {
    const [rows] = await pool.execute(
      `SELECT \`key\`, \`value\` FROM settings WHERE \`key\` IN (
        'antifraud_order_same_shop_days', 'antifraud_order_same_shop_max',
        'antifraud_new_user_days', 'antifraud_new_user_order_max',
        'antifraud_l1_monthly_cap', 'antifraud_l1l2_freeze_days', 'antifraud_l1l2_sample_rate'
      )`
    );
    const cfg = {};
    for (const r of rows || []) {
      cfg[r.key] = r.value;
    }
    return {
      orderSameShopDays: parseInt(cfg.antifraud_order_same_shop_days) || 30,
      orderSameShopMax: parseInt(cfg.antifraud_order_same_shop_max) || 3,
      newUserDays: parseInt(cfg.antifraud_new_user_days) || 7,
      newUserOrderMax: parseInt(cfg.antifraud_new_user_order_max) || 5,
      l1MonthlyCap: parseFloat(cfg.antifraud_l1_monthly_cap) || 100,
      l1l2FreezeDays: parseInt(cfg.antifraud_l1l2_freeze_days) || 0,
      l1l2SampleRate: parseInt(cfg.antifraud_l1l2_sample_rate) || 5,
    };
  } catch (err) {
    console.error('[antifraud] getAntifraudConfig error:', err.message);
    return {
      orderSameShopDays: 30,
      orderSameShopMax: 3,
      newUserDays: 7,
      newUserOrderMax: 5,
      l1MonthlyCap: 100,
      l1l2FreezeDays: 0,
      l1l2SampleRate: 5,
    };
  }
}

/**
 * 计算单条评价权重（供店铺得分）
 * 权重 = 订单含金量 × 内容质量 × 账号可信度 × 合规系数
 */
function calcReviewWeight(complexityLevel, contentQuality, userTrustWeight, shopComplianceCoeff) {
  const orderWeight = { L1: 0.2, L2: 1.0, L3: 3.0, L4: 6.0 }[complexityLevel] || 1.0;
  const contentWeight = contentQuality || 1.0;
  const trustWeight = userTrustWeight ?? 1.0;
  const complianceCoeff = shopComplianceCoeff ?? 1.0;
  return orderWeight * contentWeight * trustWeight * complianceCoeff;
}

/**
 * 计算店铺加权评价得分（已迁移至 shop-score.js，此处保留兼容调用）
 * @deprecated 使用 shop-score.computeShopScore
 */
async function computeShopWeightedScore(pool, shopId) {
  try {
    const shopScore = require('./shop-score');
    const result = await shopScore.computeShopScore(pool, shopId);
    return { score: result.score, count: result.count };
  } catch (err) {
    console.error('[antifraud] computeShopWeightedScore error:', err.message);
    return { score: 0, count: 0 };
  }
}

/**
 * 内容反作弊：检测重复度、无意义水评
 * @param {object} pool - 数据库连接池
 * @param {string} content - 评价内容
 * @param {string} [excludeReviewId] - 排除的评价ID（编辑时）
 * @returns {Promise<{pass: boolean, reason?: string}>}
 */
async function checkContentAntiCheat(pool, content, excludeReviewId) {
  try {
    const [cfgRows] = await pool.execute(
      `SELECT \`key\`, \`value\` FROM settings WHERE \`key\` IN (
        'antifraud_content_min_length', 'antifraud_content_similarity_threshold', 'antifraud_water_words'
      )`
    );
    const cfg = {};
    for (const r of cfgRows || []) cfg[r.key] = r.value;
    const minLen = parseInt(cfg.antifraud_content_min_length) || 10;
    const similarityThreshold = parseInt(cfg.antifraud_content_similarity_threshold) || 60;
    const waterWords = (cfg.antifraud_water_words || '不错,很好,划算,可以,满意').split(',').map(s => s.trim()).filter(Boolean);

    const text = String(content || '').trim();
    if (text.length < minLen) {
      return { pass: false, reason: `评价内容至少 ${minLen} 字，请补充与维修项目相关的具体描述` };
    }

    // 无意义水评：仅含水词且无其他有效内容
    const onlyWater = waterWords.some(w => text === w || text === w + '。' || text === w + '！');
    if (onlyWater || (waterWords.some(w => text.includes(w)) && text.length < 15)) {
      return { pass: false, reason: '请补充与维修项目相关的具体描述，无意义水评无法领取奖励金' };
    }

    // 重复度检测：与平台已有评价的简单相似度（取最近 500 条）
    const [existing] = await pool.execute(
      `SELECT content FROM reviews WHERE content IS NOT NULL AND content != '' AND type = 1
       ${excludeReviewId ? 'AND review_id != ?' : ''}
       ORDER BY created_at DESC LIMIT 500`,
      excludeReviewId ? [excludeReviewId] : []
    );
    const simpleSimilarity = (a, b) => {
      if (!a || !b) return 0;
      const sa = new Set(a.split(''));
      const sb = new Set(b.split(''));
      let intersect = 0;
      for (const c of sa) if (sb.has(c)) intersect++;
      return (intersect * 2) / (sa.size + sb.size);
    };
    for (const row of existing || []) {
      const sim = simpleSimilarity(text, row.content || '') * 100;
      if (sim >= similarityThreshold) {
        return { pass: false, reason: `评价内容与已有评价相似度过高，请补充真实体验描述` };
      }
    }
    return { pass: true };
  } catch (err) {
    console.error('[antifraud] checkContentAntiCheat error:', err.message);
    return { pass: true };
  }
}

/**
 * 写入审计日志
 * @param {object} pool - 数据库连接池
 * @param {object} params - { logType, action, targetTable, targetId, oldValue, newValue, operatorId, operatorRole, ip }
 */
async function writeAuditLog(pool, params) {
  try {
    await pool.execute(
      `INSERT INTO audit_logs (log_type, action, target_table, target_id, old_value, new_value, operator_id, operator_role, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.logType || 'unknown',
        params.action || 'unknown',
        params.targetTable || null,
        params.targetId || null,
        params.oldValue ? JSON.stringify(params.oldValue) : null,
        params.newValue ? JSON.stringify(params.newValue) : null,
        params.operatorId || null,
        params.operatorRole || null,
        params.ip || null,
      ]
    );
  } catch (err) {
    console.error('[antifraud] writeAuditLog error:', err.message);
  }
}

/**
 * 定损单核验（占位：预留保险公司对接）
 * @param {object} pool - 数据库连接池
 * @param {string} claimNo - 定损单号
 * @param {string} [insuranceCompany] - 保险公司
 * @returns {Promise<{valid: boolean, message?: string}>}
 */
async function verifyInsuranceClaim(pool, claimNo, insuranceCompany) {
  if (!claimNo || !String(claimNo).trim()) {
    return { valid: false, message: '定损单号不能为空' };
  }
  // 占位：实际对接需调用保险公司 API 或人工核验
  return { valid: true, message: '待对接保险公司系统' };
}

module.exports = {
  checkBlacklist,
  getUserTrustLevel,
  getAntifraudConfig,
  calcReviewWeight,
  computeShopWeightedScore,
  checkContentAntiCheat,
  verifyInsuranceClaim,
  writeAuditLog,
};
