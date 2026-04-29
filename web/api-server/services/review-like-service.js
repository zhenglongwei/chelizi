/**
 * 点赞追加奖金 - 阅读与点赞服务
 * 按 docs/体系/04 与附录 A（历史方案见 docs/已归档/点赞追加奖金体系完整标准方案-V1.0正式版.md）
 * 用户等级与权重以《用户等级体系》为准：0/0.3/1.0/1.5/2.0
 */

const crypto = require('crypto');
const antifraud = require('../antifraud');

// 点赞可信度权重（用户等级体系 6.2）：0级0 1级0.3 2级1.0 3级1.5 4级2.0
const LIKE_CREDIBILITY_WEIGHT = { 0: 0, 1: 0.3, 2: 1.0, 3: 1.5, 4: 2.0 };

// 有效阅读总时长上限（秒）
const MAX_EFFECTIVE_READING_TOTAL = 300;
// 单次会话有效阅读上限（秒）
const MAX_EFFECTIVE_READING_PER_SESSION = 180;
/** 累计有效阅读达到该值及以上时，点赞可记为有效赞（纳入互动月结等），与《04》§二「有效点赞」一致 */
const MIN_EFFECTIVE_READING_SECONDS_FOR_BONUS = 10;

function genId(prefix) {
  return prefix + crypto.randomBytes(12).toString('hex');
}

/**
 * 获取点赞可信度权重（0-4级，以用户等级体系为准）
 */
function getCredibilityWeight(level) {
  const L = parseInt(level, 10);
  if (isNaN(L) || L < 0 || L > 4) return 0;
  return LIKE_CREDIBILITY_WEIGHT[L] ?? 0;
}

function parseVehicleInfoLoose(raw) {
  if (!raw) return { plate: '', brand: '', model: '' };
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      plate: String(o.plate_number || o.plateNumber || '').trim(),
      brand: String(o.brand || '').trim(),
      model: String(o.model || '').trim(),
    };
  } catch (_) {
    return { plate: '', brand: '', model: '' };
  }
}

function normVehicleToken(s) {
  return String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * 同车型高权匹配键：品牌与车型均需非空（避免半信息误匹配）
 * @returns {string|null}
 */
function buildModelMatchKey(brand, model) {
  const b = normVehicleToken(brand);
  const m = normVehicleToken(model);
  if (!b || !m) return null;
  return `${b}|${m}`;
}

/** 点赞者画像车 vs 评价锚定订单车：规范化「品牌|车型」一致为 1，否则 0（不比较车牌，避免同车家庭成员刷高权） */
function getVehicleMatchByModel(likerKey, orderKey) {
  if (!likerKey || !orderKey) return 0;
  return likerKey === orderKey ? 1 : 0;
}

/**
 * 账号综合权重系数 = 基础可信度权重 × 车型匹配乘子
 * 乘子：同品牌+同车型（规范化）2.0，否则 0.5
 */
function calcWeightCoefficient(credibilityWeight, vehicleMatchByModel) {
  const vehicleWeight = vehicleMatchByModel ? 2.0 : 0.5;
  return Math.round(credibilityWeight * vehicleWeight * 10000) / 10000;
}

/**
 * 上报有效阅读会话
 * @param {object} pool
 * @param {string} userId
 * @param {string} reviewId
 * @param {number} effectiveSeconds - 本次有效阅读秒数，最多180
 * @param {Date} sawAt - 「看到了」的时刻
 */
async function reportReadingSession(pool, userId, reviewId, effectiveSeconds, sawAt) {
  const sec = Math.min(Math.max(0, Math.floor(effectiveSeconds)), MAX_EFFECTIVE_READING_PER_SESSION);
  if (sec <= 0) return { success: true, added: 0 };

  // 累计该用户对该评价的总有效阅读时长
  const [sumRows] = await pool.execute(
    `SELECT COALESCE(SUM(effective_seconds), 0) as total FROM review_reading_sessions WHERE review_id = ? AND user_id = ?`,
    [reviewId, userId]
  );
  const currentTotal = parseInt(sumRows[0]?.total || 0, 10);
  const remaining = Math.max(0, MAX_EFFECTIVE_READING_TOTAL - currentTotal);
  const toAdd = Math.min(sec, remaining);
  if (toAdd <= 0) return { success: true, added: 0, capped: true };

  const sessionId = genId('rrs_');
  const endedAt = new Date();
  await pool.execute(
    `INSERT INTO review_reading_sessions (session_id, review_id, user_id, effective_seconds, saw_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sessionId, reviewId, userId, toAdd, sawAt || endedAt, endedAt]
  );
  return { success: true, added: toAdd, total: currentTotal + toAdd };
}

/**
 * 事后验证判定：下单前7天有浏览 + 同品牌同车系同类项目 + 完工后30天内点赞
 * @returns {Promise<boolean>}
 */
async function checkPostVerify(pool, userId, reviewId, reviewOrderId) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [orders] = await pool.execute(
    `SELECT o.order_id, o.created_at, o.completed_at, o.bidding_id
     FROM orders o
     WHERE o.user_id = ? AND o.status = 3
       AND o.completed_at >= ? AND o.completed_at <= ?
       AND o.order_id != ?`,
    [userId, thirtyDaysAgo.toISOString().slice(0, 19).replace('T', ' '), now.toISOString().slice(0, 19).replace('T', ' '), reviewOrderId]
  );

  const [reviewOrderBid] = await pool.execute(
    `SELECT b.vehicle_info FROM orders o JOIN biddings b ON o.bidding_id = b.bidding_id WHERE o.order_id = ?`,
    [reviewOrderId]
  );
  const revVi = reviewOrderBid[0]?.vehicle_info ? (typeof reviewOrderBid[0].vehicle_info === 'string' ? JSON.parse(reviewOrderBid[0].vehicle_info) : reviewOrderBid[0].vehicle_info) : {};
  const reviewBrand = (revVi.brand || '').trim();

  for (const order of orders) {
    const completedAt = new Date(order.completed_at);
    const likeWindowEnd = new Date(completedAt);
    likeWindowEnd.setDate(likeWindowEnd.getDate() + 30);
    if (now > likeWindowEnd) continue;

    const [hasBrowse] = await pool.execute(
      `SELECT 1 FROM review_reading_sessions WHERE review_id = ? AND user_id = ?
       AND saw_at >= DATE_SUB(?, INTERVAL 7 DAY) AND saw_at < ? LIMIT 1`,
      [reviewId, userId, order.created_at, order.created_at]
    );
    if (hasBrowse.length === 0) continue;

    const [orderBid] = await pool.execute('SELECT vehicle_info FROM biddings WHERE bidding_id = ?', [order.bidding_id]);
    const ordVi = orderBid[0]?.vehicle_info ? (typeof orderBid[0].vehicle_info === 'string' ? JSON.parse(orderBid[0].vehicle_info) : orderBid[0].vehicle_info) : {};
    const orderBrand = (ordVi.brand || '').trim();
    if (reviewBrand && orderBrand && reviewBrand !== orderBrand) continue;

    return true;
  }
  return false;
}

/**
 * 获取用户对该评价的累计有效阅读时长
 */
async function getTotalEffectiveReading(pool, userId, reviewId) {
  const [rows] = await pool.execute(
    `SELECT COALESCE(SUM(effective_seconds), 0) as total FROM review_reading_sessions WHERE review_id = ? AND user_id = ?`,
    [reviewId, userId]
  );
  return parseInt(rows[0]?.total || 0, 10);
}

/**
 * 点赞
 * @returns { success, error?, like_id?, is_valid_for_bonus? }
 */
async function likeReview(pool, userId, reviewId) {
  // 1. 校验评价存在且有效
  const [reviews] = await pool.execute(
    `SELECT r.review_id, r.order_id, r.user_id as author_id, r.status
     FROM reviews r WHERE r.review_id = ?`,
    [reviewId]
  );
  if (!reviews.length) return { success: false, error: '评价不存在' };
  const review = reviews[0];
  if (review.status !== 1) return { success: false, error: '评价已隐藏' };
  if (review.author_id === userId) return { success: false, error: '不能给自己的评价点赞' };

  // 2. 是否已点赞（单用户单评价终身 1 次赞；「踩」已废止，不再与赞互斥）
  const [existing] = await pool.execute(
    'SELECT like_id, is_valid_for_bonus FROM review_likes WHERE review_id = ? AND user_id = ?',
    [reviewId, userId]
  );
  if (existing.length) return { success: false, error: '您已点赞过该评价' };

  // 3. 累计有效阅读时长
  const totalReading = await getTotalEffectiveReading(pool, userId, reviewId);
  const hasEnoughReading = totalReading >= MIN_EFFECTIVE_READING_SECONDS_FOR_BONUS;

  // 4. 用户等级与权重（以 antifraud.getUserTrustLevel 动态核算为准）
  const trust = await antifraud.getUserTrustLevel(pool, userId);
  const credibilityWeight = getCredibilityWeight(trust.level);

  // 5. 点赞者车辆画像（优先 user_vehicles；若缺品牌/车型则回退最近完工订单的 bidding.vehicle_info）
  let likerPlate = '';
  let likerBrand = '';
  let likerModel = '';
  const [uv] = await pool.execute(
    `SELECT plate_number, vehicle_info FROM user_vehicles WHERE user_id = ? AND status = 1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (uv.length) {
    likerPlate = String(uv[0].plate_number || '').trim();
    const fromUv = parseVehicleInfoLoose(uv[0].vehicle_info);
    if (!likerPlate) likerPlate = fromUv.plate;
    likerBrand = fromUv.brand;
    likerModel = fromUv.model;
  }
  let likerModelKey = buildModelMatchKey(likerBrand, likerModel);
  if (likerModelKey === null) {
    const [ord] = await pool.execute(
      `SELECT b.vehicle_info FROM orders o JOIN biddings b ON o.bidding_id = b.bidding_id
       WHERE o.user_id = ? AND o.status = 3 ORDER BY o.completed_at DESC LIMIT 1`,
      [userId]
    );
    if (ord.length && ord[0].vehicle_info) {
      const ov = parseVehicleInfoLoose(ord[0].vehicle_info);
      likerModelKey = buildModelMatchKey(ov.brand, ov.model);
      if (!likerPlate) likerPlate = ov.plate;
    }
  }

  // 6. 评价锚定订单车辆
  let orderPlate = '';
  let orderBrand = '';
  let orderModel = '';
  const [ord2] = await pool.execute(
    `SELECT b.vehicle_info FROM orders o JOIN biddings b ON o.bidding_id = b.bidding_id WHERE o.order_id = ?`,
    [review.order_id]
  );
  if (ord2.length && ord2[0].vehicle_info) {
    const ov = parseVehicleInfoLoose(ord2[0].vehicle_info);
    orderPlate = ov.plate;
    orderBrand = ov.brand;
    orderModel = ov.model;
  }
  const orderModelKey = buildModelMatchKey(orderBrand, orderModel);

  /** 落库列名仍为 vehicle_match_by_plate，语义为「同车型高权」1/0（见迁移 COMMENT） */
  const vehicleMatchByModel = getVehicleMatchByModel(likerModelKey, orderModelKey);
  const weightCoefficient = calcWeightCoefficient(credibilityWeight, vehicleMatchByModel);

  // 7. 是否纳入奖金：有效阅读≥10 秒 且 账号权重>0
  const isValidForBonus = hasEnoughReading && credibilityWeight > 0 ? 1 : 0;

  // 8. 事后验证判定：下单前7天有浏览 + 同品牌同车系同类项目真实交易 + 完工后30天内点赞
  let likeType = 'normal';
  if (isValidForBonus) {
    const isPostVerify = await checkPostVerify(pool, userId, reviewId, review.order_id);
    if (isPostVerify) likeType = 'post_verify';
  }

  const likeId = genId('rl_');
  await pool.execute(
    `INSERT INTO review_likes (like_id, review_id, user_id, effective_reading_seconds, like_type, is_valid_for_bonus, weight_coefficient, vehicle_match_by_plate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [likeId, reviewId, userId, totalReading, likeType, isValidForBonus, weightCoefficient, vehicleMatchByModel]
  );

  // 9. 更新 reviews.like_count、post_verify_like_count
  await pool.execute(
    'UPDATE reviews SET like_count = like_count + 1 WHERE review_id = ?',
    [reviewId]
  );

  if (likeType === 'post_verify') {
    await pool.execute(
      'UPDATE reviews SET post_verify_like_count = COALESCE(post_verify_like_count, 0) + 1 WHERE review_id = ?',
      [reviewId]
    );
  }

  // 10. 4级爆款自动升级：满足条件则升级（异步，不阻塞点赞返回）
  try {
    const level4Service = require('./review-level4-service');
    const upgradeResult = await level4Service.checkAndUpgradeToLevel4(pool, reviewId);
    if (upgradeResult.upgraded) {
      console.log('[review-like] 评价', reviewId, '自动升级为4级爆款');
    }
  } catch (err) {
    console.error('[review-like] 4级升级检查异常:', err.message);
  }

  // 奖励金审计日志（REWARD_AUDIT_LOG=1 启用）
  try {
    const auditLogger = require('../reward-audit-logger');
    auditLogger.logLike({
      like_id: likeId,
      review_id: reviewId,
      user_id: userId,
      author_id: review.author_id,
      total_reading_seconds: totalReading,
      has_enough_reading: hasEnoughReading,
      user_level: trust.level,
      credibility_weight: credibilityWeight,
      liker_plate: likerPlate,
      order_plate: orderPlate,
      liker_model_key: likerModelKey,
      order_model_key: orderModelKey,
      vehicle_match_by_plate: vehicleMatchByModel,
      weight_coefficient: weightCoefficient,
      is_valid_for_bonus: !!isValidForBonus,
      like_type: likeType,
    });
  } catch (_) {}

  return {
    success: true,
    like_id: likeId,
    is_valid_for_bonus: !!isValidForBonus,
    like_count_delta: 1,
  };
}

/**
 * 获取评价的点赞统计（含事后验证数、是否车主验证标签）
 */
async function getReviewLikeStats(pool, reviewIds) {
  if (!reviewIds || reviewIds.length === 0) return {};
  const placeholders = reviewIds.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT review_id,
       COUNT(*) as like_count,
       SUM(CASE WHEN like_type = 'post_verify' THEN 1 ELSE 0 END) as post_verify_count,
       SUM(CASE WHEN is_valid_for_bonus = 1 THEN 1 ELSE 0 END) as valid_bonus_count
     FROM review_likes
     WHERE review_id IN (${placeholders})
     GROUP BY review_id`,
    reviewIds
  );
  const map = {};
  for (const r of rows) {
    const pv = parseInt(r.post_verify_count || 0, 10);
    map[r.review_id] = {
      like_count: parseInt(r.like_count || 0, 10),
      post_verify_count: pv,
      has_owner_verify_badge: pv >= 10,
    };
  }
  return map;
}

/**
 * 踩评价（已废止）：不再写入 review_dislikes，不参与质量/奖金/排序；接口保留并返回明确错误，兼容旧客户端。
 */
async function dislikeReview(_pool, _userId, _reviewId) {
  return { success: false, error: '暂不支持踩评价' };
}

module.exports = {
  reportReadingSession,
  getTotalEffectiveReading,
  likeReview,
  dislikeReview,
  getReviewLikeStats,
  getCredibilityWeight,
  calcWeightCoefficient,
  buildModelMatchKey,
  getVehicleMatchByModel,
  MAX_EFFECTIVE_READING_TOTAL,
  MAX_EFFECTIVE_READING_PER_SESSION,
  MIN_EFFECTIVE_READING_SECONDS_FOR_BONUS,
};
