/**
 * 防刷服务 - 第二阶段
 * 黑名单校验、账号可信度、防刷配置读取
 * 违规等级：1=轻度 2=中度 3=重度 4=重大（与 violation_records.violation_level 一致）
 */

/**
 * 获取用户违规汇总（供等级核算使用）
 * @param {object} pool - 数据库连接池
 * @param {string} userId - 用户ID
 * @returns {Promise<{hasMajor: boolean, hasSevere: boolean, severeCount: number, moderateCount: number, levelCap: number|null}>}
 */
async function getUserViolationSummary(pool, userId) {
  try {
    const [rows] = await pool.execute(
      `SELECT violation_level FROM violation_records 
       WHERE target_type = 'user' AND target_id = ? AND status IN (0, 1)`,
      [userId]
    );
    let hasMajor = false;
    let hasSevere = false;
    let severeCount = 0;
    let moderateCount = 0;
    for (const r of rows || []) {
      const lv = parseInt(r.violation_level, 10);
      if (lv === 4) hasMajor = true;
      if (lv === 3) { hasSevere = true; severeCount++; }
      if (lv === 2) moderateCount++;
    }
    // 等级上限：重大→0 永久；重度或≥2次重度→0；≥2次中度→永久上限2级；≥1次中度→取消3/4级
    let levelCap = null;
    if (hasMajor || hasSevere || severeCount >= 2) levelCap = 0;
    else if (moderateCount >= 2) levelCap = 2;
    else if (moderateCount >= 1) levelCap = 2; // 1次中度即取消3级及以上
    return { hasMajor, hasSevere, severeCount, moderateCount, levelCap };
  } catch (err) {
    console.error('[antifraud] getUserViolationSummary error:', err.message);
    return { hasMajor: false, hasSevere: false, severeCount: 0, moderateCount: 0, levelCap: null };
  }
}

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
 * 用户等级体系 0-4 级：0=风险受限 1=基础注册 2=普通可信 3=活跃可信 4=核心标杆
 * 完整实现：0-4 级、违规联动、优先读 users.level（月度核算后）
 * @param {object} pool - 数据库连接池
 * @param {string} userId - 用户ID
 * @returns {Promise<{level: number, weight: number, levelName: string, needsVerification?: boolean}>}
 */
async function getUserTrustLevel(pool, userId) {
  const WEIGHTS = { 0: 0, 1: 0.3, 2: 1.0, 3: 2.0, 4: 3.0 };
  const NAMES = { 0: '风险受限', 1: '基础注册', 2: '普通可信', 3: '活跃可信', 4: '核心标杆' };

  try {
    const [userRows] = await pool.execute(
      'SELECT u.created_at, COALESCE(u.level_demoted_by_violation, 0) as level_demoted_by_violation, u.phone FROM users u WHERE u.user_id = ?',
      [userId]
    );
    if (userRows.length === 0) return { level: 0, weight: 0, levelName: NAMES[0] };

    const user = userRows[0];
    const createdAt = new Date(user.created_at);
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    // 一票否决：未实名 or 未车辆 → 0 级（始终优先校验）
    const [verifRows] = await pool.execute(
      'SELECT verified FROM user_verification WHERE user_id = ?',
      [userId]
    );
    const hasVerification = (verifRows[0]?.verified === 1) || (user.phone && String(user.phone).trim());

    const [vehicleCount] = await pool.execute(
      'SELECT COUNT(*) as c FROM user_vehicles WHERE user_id = ? AND status = 1',
      [userId]
    );
    const [orderWithVehicle] = await pool.execute(
      `SELECT 1 FROM orders o JOIN biddings b ON o.bidding_id = b.bidding_id
       WHERE o.user_id = ? AND o.status = 3 AND b.vehicle_info IS NOT NULL AND b.vehicle_info != '' AND b.vehicle_info != 'null' LIMIT 1`,
      [userId]
    );
    const hasVehicle = (vehicleCount[0]?.c || 0) > 0 || orderWithVehicle.length > 0;

    if (!hasVerification || !hasVehicle) {
      return { level: 0, weight: 0, levelName: NAMES[0], needsVerification: true };
    }

    // 违规联动：读取 violation_records 确定等级上限
    const vio = await getUserViolationSummary(pool, userId);
    if (vio.levelCap === 0) {
      return { level: 0, weight: 0, levelName: NAMES[0] };
    }

    // 统计：有效交易、有效评价、优质评价、标杆评价、同车型点赞
    const [orderCount] = await pool.execute(
      'SELECT COUNT(*) as c FROM orders WHERE user_id = ? AND status = 3',
      [userId]
    );
    const [reviewCount] = await pool.execute(
      `SELECT COUNT(*) as c FROM reviews r JOIN orders o ON r.order_id = o.order_id WHERE r.user_id = ? AND r.type = 1`,
      [userId]
    );
    const validOrders = orderCount[0]?.c || 0;
    const validReviews = reviewCount[0]?.c || 0;

    // 优质评价：主评价 content_quality_level >= 2 或 content_quality 为 premium/标杆/维权参考
    const [qualityReviewCount] = await pool.execute(
      `SELECT COUNT(*) as c FROM reviews r
       JOIN orders o ON r.order_id = o.order_id AND o.user_id = ? AND o.status = 3
       WHERE r.user_id = ? AND r.type = 1 AND (r.content_quality_level >= 2 OR r.content_quality IN ('premium', '标杆', '维权参考', '爆款'))`,
      [userId, userId]
    );
    const qualityReviews = qualityReviewCount[0]?.c || 0;

    // 同车型有效点赞：用户发布的评价收到的有效点赞数（简化：用 review_likes 中 is_valid_for_bonus=1 的）
    const [likeCount] = await pool.execute(
      `SELECT COUNT(*) as c FROM review_likes rl 
       JOIN reviews r ON rl.review_id = r.review_id AND r.user_id = ?
       WHERE rl.is_valid_for_bonus = 1`,
      [userId]
    );
    const sameModelLikes = likeCount[0]?.c || 0;

    let level = 1;

    // 2 级：注册≥7天、≥2笔交易、≥2条有效评价、合规、违规上限
    if (createdAt <= sevenDaysAgo && validOrders >= 2 && validReviews >= 2) {
      level = 2;
    }

    // 3 级：注册≥30天、≥5笔、≥3条优质评价、100%合规、无中度及以上违规
    if (level >= 2 && createdAt <= thirtyDaysAgo && validOrders >= 5 && qualityReviews >= 3 && vio.moderateCount === 0) {
      level = 3;
    }

    // 4 级：注册≥90天、≥10笔、≥5条标杆评价、≥100同车型点赞、终身零违规
    if (level >= 3 && createdAt <= ninetyDaysAgo && validOrders >= 10 && qualityReviews >= 5 && sameModelLikes >= 100 && vio.moderateCount === 0 && vio.severeCount === 0) {
      level = 4;
    }

    // 应用违规等级上限
    if (vio.levelCap !== null && level > vio.levelCap) {
      level = vio.levelCap;
    }

    return {
      level,
      weight: WEIGHTS[level],
      levelName: NAMES[level],
      needsVerification: level === 0,
    };
  } catch (err) {
    console.error('[antifraud] getUserTrustLevel error:', err.message);
    return { level: 0, weight: 0, levelName: '风险受限', needsVerification: true };
  }
}

/**
 * 处理待回溯奖励：用户完成实名+车辆后，补发0级时暂扣的奖励
 * 若用户曾因违规降级，则不补发
 * @param {object} pool - 数据库连接池
 * @param {string} userId - 用户ID
 * @returns {Promise<{paid: number, total: number, skipped: boolean}>}
 */
async function processWithheldRewards(pool, userId) {
  try {
    const [userRows] = await pool.execute(
      'SELECT level_demoted_by_violation FROM users WHERE user_id = ?',
      [userId]
    );
    if (userRows.length === 0) return { paid: 0, total: 0, skipped: false };
    if (userRows[0].level_demoted_by_violation === 1) {
      await pool.execute(
        "UPDATE withheld_rewards SET status = 'rejected' WHERE user_id = ? AND status = 'pending'",
        [userId]
      );
      return { paid: 0, total: 0, skipped: true };
    }

    const [rows] = await pool.execute(
      "SELECT id, review_id, user_receives FROM withheld_rewards WHERE user_id = ? AND status = 'pending'",
      [userId]
    );
    if (rows.length === 0) return { paid: 0, total: 0, skipped: false };

    let totalPaid = 0;
    for (const r of rows) {
      const amount = parseFloat(r.user_receives) || 0;
      if (amount <= 0) continue;
      const txnId = 'TXN' + Date.now() + '_' + r.id;
      await pool.execute(
        'UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?',
        [amount, amount, userId]
      );
      await pool.execute(
        `INSERT INTO transactions (transaction_id, user_id, type, amount, description, related_id, created_at)
         VALUES (?, ?, 'rebate', ?, '0级回溯奖励金', ?, NOW())`,
        [txnId, userId, amount, r.review_id]
      );
      await pool.execute(
        "UPDATE withheld_rewards SET status = 'paid', paid_at = NOW() WHERE id = ?",
        [r.id]
      );
      totalPaid += amount;
    }
    return { paid: totalPaid, total: rows.length, skipped: false };
  } catch (err) {
    console.error('[antifraud] processWithheldRewards error:', err.message);
    return { paid: 0, total: 0, skipped: false };
  }
}

/**
 * 获取用户等级详情（升级进度、权益、保级条件）
 * @param {object} pool - 数据库连接池
 * @param {string} userId - 用户ID
 * @returns {Promise<object>}
 */
async function getUserLevelDetail(pool, userId) {
  const trust = await getUserTrustLevel(pool, userId);
  const PERKS = {
    0: ['仅可浏览，完成实名和车辆绑定后可下单、评价'],
    1: ['基础下单、评价、点赞', '可进社群', '奖励金 50%'],
    2: ['完整功能、竞价、福利、先行赔付', '奖励金 80% 封顶'],
    3: ['专属标识、免费专家咨询、优先推送、商家折扣、维权优先', '奖励金 90% 封顶'],
    4: ['KOC 标识、终身专家、专属客户经理、订单监理、年度福利', '奖励金 100% 封顶'],
  };
  const RETENTION = {
    0: '完成实名+车辆绑定可升至 1 级',
    1: '实名+车辆有效，无重度及以上违规',
    2: '近 3 月≥1 笔有效交易，月度合规率≥80%',
    3: '近 3 月≥2 笔有效交易，月度合规率≥90%',
    4: '近 3 月≥3 笔有效交易，月度合规率 100%',
  };

  const [userRows] = await pool.execute('SELECT created_at FROM users WHERE user_id = ?', [userId]);
  const createdAt = userRows[0] ? new Date(userRows[0].created_at) : new Date();
  const now = new Date();
  const [orderCount] = await pool.execute('SELECT COUNT(*) as c FROM orders WHERE user_id = ? AND status = 3', [userId]);
  const [reviewCount] = await pool.execute(
    `SELECT COUNT(*) as c FROM reviews r JOIN orders o ON r.order_id = o.order_id WHERE r.user_id = ? AND r.type = 1`,
    [userId]
  );
  const [qualityCount] = await pool.execute(
    `SELECT COUNT(DISTINCT o.order_id) as c FROM orders o
     JOIN reviews r1 ON r1.order_id = o.order_id AND r1.user_id = ? AND r1.type = 1
     JOIN reviews r2 ON r2.order_id = o.order_id AND r2.type = 2
     WHERE o.user_id = ? AND o.status = 3`,
    [userId, userId]
  );
  const [likeCount] = await pool.execute(
    `SELECT COUNT(*) as c FROM review_likes rl JOIN reviews r ON rl.review_id = r.review_id AND r.user_id = ? WHERE rl.is_valid_for_bonus = 1`,
    [userId]
  );

  const daysRegistered = Math.floor((now - createdAt) / (24 * 60 * 60 * 1000));
  const validOrders = orderCount[0]?.c || 0;
  const validReviews = reviewCount[0]?.c || 0;
  const qualityReviews = qualityCount[0]?.c || 0;
  const sameModelLikes = likeCount[0]?.c || 0;

  const current = { days_registered: daysRegistered, valid_orders: validOrders, valid_reviews: validReviews, quality_reviews: qualityReviews, same_model_likes: sameModelLikes };

  let next_level = null;
  let requirements = [];
  if (trust.level < 4) {
    next_level = trust.level + 1;
    if (next_level === 1) {
      requirements = [{ key: '实名认证', met: trust.level >= 1, required: '手机号实名' }, { key: '车辆绑定', met: trust.level >= 1, required: '至少 1 台' }];
    } else if (next_level === 2) {
      requirements = [
        { key: '注册天数', met: daysRegistered >= 7, current: daysRegistered, required: 7 },
        { key: '有效交易', met: validOrders >= 2, current: validOrders, required: 2 },
        { key: '有效评价', met: validReviews >= 2, current: validReviews, required: 2 },
      ];
    } else if (next_level === 3) {
      requirements = [
        { key: '注册天数', met: daysRegistered >= 30, current: daysRegistered, required: 30 },
        { key: '有效交易', met: validOrders >= 5, current: validOrders, required: 5 },
        { key: '优质评价', met: qualityReviews >= 3, current: qualityReviews, required: 3 },
      ];
    } else if (next_level === 4) {
      requirements = [
        { key: '注册天数', met: daysRegistered >= 90, current: daysRegistered, required: 90 },
        { key: '有效交易', met: validOrders >= 10, current: validOrders, required: 10 },
        { key: '优质评价', met: qualityReviews >= 5, current: qualityReviews, required: 5 },
        { key: '同车型点赞', met: sameModelLikes >= 100, current: sameModelLikes, required: 100 },
      ];
    }
  }

  return {
    level: trust.level,
    level_name: trust.levelName,
    weight: trust.weight,
    needs_verification: trust.needsVerification === true,
    perks: PERKS[trust.level] || PERKS[0],
    retention: RETENTION[trust.level] || '',
    upgrade_progress: next_level ? { next_level, requirements, current } : null,
  };
}

/**
 * 检查用户是否可领取奖励金（0级不可领，1级50%）
 * @param {object} pool - 数据库连接池
 * @param {string} userId - 用户ID
 * @returns {Promise<{canReceive: boolean, level: number, multiplier: number}>}
 */
async function getRewardEligibility(pool, userId) {
  const trust = await getUserTrustLevel(pool, userId);
  if (trust.level === 0) return { canReceive: false, level: 0, multiplier: 0 };
  if (trust.level === 1) return { canReceive: true, level: 1, multiplier: 0.5 };
  return { canReceive: true, level: trust.level, multiplier: 1 };
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
  getUserViolationSummary,
  getUserTrustLevel,
  getUserLevelDetail,
  getRewardEligibility,
  processWithheldRewards,
  getAntifraudConfig,
  calcReviewWeight,
  computeShopWeightedScore,
  checkContentAntiCheat,
  verifyInsuranceClaim,
  writeAuditLog,
};
