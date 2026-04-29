/**
 * 评价聚合页服务
 * 全平台评价流：按等级+时间排序，支持时间/距离切换，新鲜度（3天内不重复）
 */

const reviewLikeService = require('./review-like-service');
const orderQuoteProposalService = require('./order-quote-proposal-service');
const { parseCompletionEvidence, parseRepairPlanEnrichment } = require('../utils/review-order-display');
const quoteProposalPublic = require('../utils/quote-proposal-public-list');
const { sanitizeQuoteProposalHistoryForPublicList } = require('../utils/quote-proposal-public-sanitize');
const { applyGranularPublicImages, sanitizeSystemChecksForUserFacing } = require('../utils/review-public-system-sanitize');
const { hasColumn } = require('../utils/db-utils');

const LEVEL_NAMES = { 0: '风险受限', 1: '基础注册', 2: '普通可信', 3: '活跃可信', 4: '核心标杆' };

/** 全站「严格条件」下可展示主评价总数低于该值时，自动放宽：含 L1 订单评价、关闭 3 天新鲜度，避免冷启动列表过短 */
const RELAX_THRESHOLD = Math.max(0, parseInt(process.env.REVIEW_FEED_RELAX_THRESHOLD || '40', 10) || 40);

/**
 * @param {object} opts
 * @returns {{ baseWhere: string, params: any[], excludeViewedSql: string }}
 */
function buildFeedWhere(opts) {
  const {
    excludeInvalid,
    excludeL1,
    projectFilter,
    projectParam,
    currentUserId,
    excludeRecentlyViewed,
    hasFeedViewsTable
  } = opts;

  const l1Clause = excludeL1 ? ' AND (o.complexity_level IS NULL OR o.complexity_level != \'L1\')' : '';

  let excludeViewedSql = '';
  const params = [];
  if (projectFilter) {
    params.push(projectParam, projectParam + '|%', '%|' + projectParam, '%|' + projectParam + '|%');
  }
  if (excludeRecentlyViewed && currentUserId && hasFeedViewsTable) {
    excludeViewedSql = ` AND r.review_id NOT IN (
          SELECT review_id FROM review_feed_views
          WHERE user_id = ? AND viewed_at > DATE_SUB(NOW(), INTERVAL 3 DAY)
        )`;
    params.push(currentUserId);
  }

  const baseWhere = `r.type = 1 AND r.status = 1
    AND (r.content_quality_level IS NULL OR r.content_quality_level >= ?)
    ${excludeInvalid}${l1Clause}${projectFilter}${excludeViewedSql}`;

  return { baseWhere, params, excludeViewedSql };
}

/**
 * 获取评价聚合流
 * @param {object} pool
 * @param {object} query - { page, limit, sort, min_level, repair_project_key, currentUserId, latitude, longitude, exclude_recently_viewed }
 */
async function getReviewFeed(pool, query) {
  const {
    page = 1,
    limit = 20,
    sort = 'quality',
    min_level = 1,
    repair_project_key,
    repair_project_item,
    currentUserId,
    latitude,
    longitude,
    exclude_recently_viewed = '1'
  } = query;

  const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 50);
  const pageNum = Math.max(parseInt(page) || 1, 1);
  const offset = (pageNum - 1) * limitNum;

  const projectParam = (repair_project_item || repair_project_key || '').trim();
  const projectFilter = projectParam
    ? ' AND (r.repair_project_key = ? OR r.repair_project_key LIKE ? OR r.repair_project_key LIKE ? OR r.repair_project_key LIKE ?)' : '';

  const minLevel = Math.max(1, Math.min(4, parseInt(min_level) || 1));
  const excludeInvalid = ' AND (r.content_quality IS NULL OR r.content_quality != \'invalid\') AND (r.content_quality_level IS NULL OR r.content_quality_level >= 1)';

  let hasFeedViewsTable = false;
  try {
    const [tables] = await pool.execute(
      "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'review_feed_views'"
    );
    hasFeedViewsTable = tables.length > 0;
  } catch (_) {}

  const userIncludeL1 = query.exclude_l1 === '0' || query.exclude_l1 === 'false';
  const userShowRecentlyViewed = exclude_recently_viewed === '0' || exclude_recently_viewed === 'false';

  let excludeL1 = !userIncludeL1;
  let excludeRecentlyViewed = !userShowRecentlyViewed;

  const strictParts = buildFeedWhere({
    excludeInvalid,
    excludeL1,
    projectFilter,
    projectParam,
    currentUserId,
    excludeRecentlyViewed,
    hasFeedViewsTable,
  });

  let strictTotal = 0;
  try {
    const [strictCountRows] = await pool.execute(
      `SELECT COUNT(*) as total FROM reviews r
       JOIN orders o ON r.order_id = o.order_id
       JOIN shops s ON r.shop_id = s.shop_id AND s.status = 1 AND (s.qualification_status = 1 OR s.qualification_status IS NULL)
       WHERE ${strictParts.baseWhere}`,
      [minLevel, ...strictParts.params]
    );
    strictTotal = Number(strictCountRows[0]?.total ?? 0);
  } catch (_) {}

  let feedRelaxed = false;
  if (RELAX_THRESHOLD > 0 && strictTotal < RELAX_THRESHOLD) {
    feedRelaxed = true;
    excludeL1 = false;
    excludeRecentlyViewed = false;
  }

  const { baseWhere, params } = buildFeedWhere({
    excludeInvalid,
    excludeL1,
    projectFilter,
    projectParam,
    currentUserId,
    excludeRecentlyViewed,
    hasFeedViewsTable,
  });

  let hasDiscoveryBoost = false;
  try {
    hasDiscoveryBoost = await hasColumn(pool, 'reviews', 'review_discovery_boost');
  } catch (_) {}

  let orderBy;
  if (sort === 'time') {
    orderBy = 'r.created_at DESC';
  } else if (sort === 'distance' && latitude != null && longitude != null && !isNaN(parseFloat(latitude)) && !isNaN(parseFloat(longitude))) {
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    // 球面距离：6371 * acos(...)；括号须闭合 (6371 * ACOS(LEAST(1,GREATEST(-1,expr))))
    orderBy = `(6371 * ACOS(LEAST(1, GREATEST(-1,
      COS(RADIANS(${lat})) * COS(RADIANS(s.latitude)) * COS(RADIANS(s.longitude) - RADIANS(${lng}))
      + SIN(RADIANS(${lat})) * SIN(RADIANS(s.latitude))
    )))) ASC, r.content_quality_level DESC, r.created_at DESC`;
  } else {
    orderBy = hasDiscoveryBoost
      ? 'COALESCE(r.review_discovery_boost, 1) DESC, r.content_quality_level DESC, r.created_at DESC'
      : 'r.content_quality_level DESC, r.created_at DESC';
  }

  const paramsForQuery = [minLevel, ...params, limitNum, offset];

  const [reviews] = await pool.execute(
    `SELECT r.*, u.nickname, u.avatar_url, u.level as user_level,
       s.shop_id, s.name as shop_name, s.logo as shop_logo, s.address as shop_address, s.district as shop_district,
       s.latitude as shop_lat, s.longitude as shop_lng,
       o.repair_plan, o.quoted_amount, o.actual_amount, o.completion_evidence,
       o.pre_quote_snapshot, o.accepted_at
     FROM reviews r
     JOIN users u ON r.user_id = u.user_id
     JOIN orders o ON r.order_id = o.order_id
     JOIN shops s ON r.shop_id = s.shop_id AND s.status = 1 AND (s.qualification_status = 1 OR s.qualification_status IS NULL)
     WHERE ${baseWhere}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    paramsForQuery
  );

  const countParams = [minLevel, ...params];
  const countSql = `SELECT COUNT(*) as total FROM reviews r
     JOIN orders o ON r.order_id = o.order_id
     JOIN shops s ON r.shop_id = s.shop_id AND s.status = 1 AND (s.qualification_status = 1 OR s.qualification_status IS NULL)
     WHERE ${baseWhere}`;
  const [countRows] = await pool.execute(countSql, countParams);
  const total = countRows[0]?.total ?? 0;

  const reviewIds = reviews.map(r => r.review_id);
  let likeStats = {};
  let userLikedIds = new Set();

  try {
    likeStats = await reviewLikeService.getReviewLikeStats(pool, reviewIds);
  } catch (_) {}

  if (currentUserId && reviewIds.length > 0) {
    try {
      const placeholders = reviewIds.map(() => '?').join(',');
      const [likeRows] = await pool.execute(
        `SELECT review_id FROM review_likes WHERE review_id IN (${placeholders}) AND user_id = ?`,
        [...reviewIds, currentUserId]
      );
      userLikedIds = new Set((likeRows || []).map(l => l.review_id));
    } catch (_) {}
  }

  /** 到店多轮报价：随评价公示 */
  const proposalsByOrderId = new Map();
  try {
    if (reviews.length > 0 && (await orderQuoteProposalService.proposalsTableExists(pool))) {
      const oids = [...new Set(reviews.map((row) => row.order_id))];
      await Promise.all(
        oids.map(async (oid) => {
          const list = await orderQuoteProposalService.listFormatted(pool, oid);
          if (list && list.length) proposalsByOrderId.set(oid, list);
        })
      );
    }
  } catch (_) {}

  return {
    success: true,
    data: {
      list: reviews.map(r => {
        const stats = likeStats[r.review_id] || {};
        let amount = r.actual_amount != null ? parseFloat(r.actual_amount) : (r.quoted_amount != null ? parseFloat(r.quoted_amount) : null);
        let { material_photos } = parseCompletionEvidence(r.completion_evidence);
        const { repairItems, part_promise_lines } = parseRepairPlanEnrichment(r.repair_plan, r.repair_project_key, {
          stripLinePrices: true,
        });
        const objAnswers = (() => {
          try {
            return typeof r.objective_answers === 'string' ? JSON.parse(r.objective_answers || '{}') : (r.objective_answers || {});
          } catch (_) { return {}; }
        })();
        const beforeImgs = (() => {
          try {
            return typeof r.before_images === 'string' ? JSON.parse(r.before_images || '[]') : (r.before_images || []);
          } catch (_) { return []; }
        })();
        const completionImgs = (() => {
          try {
            return typeof r.completion_images === 'string' ? JSON.parse(r.completion_images || '[]') : (r.completion_images || []);
          } catch (_) { return []; }
        })();
        const afterImgs = (() => {
          try {
            return typeof r.after_images === 'string' ? JSON.parse(r.after_images || '[]') : (r.after_images || []);
          } catch (_) { return []; }
        })();
        const faultImgs = (() => {
          try {
            return typeof r.fault_evidence_images === 'string'
              ? JSON.parse(r.fault_evidence_images || '[]')
              : r.fault_evidence_images || [];
          } catch (_) {
            return [];
          }
        })();

        const userLevel = r.user_level != null ? parseInt(r.user_level, 10) : 1;
        const levelName = LEVEL_NAMES[userLevel] || LEVEL_NAMES[1];

        let preSnap = null;
        try {
          preSnap =
            typeof r.pre_quote_snapshot === 'string' && r.pre_quote_snapshot
              ? JSON.parse(r.pre_quote_snapshot)
              : r.pre_quote_snapshot || null;
        } catch (_) {
          preSnap = null;
        }
        const headPlan = quoteProposalPublic.planHasDisplayablePreQuote(preSnap)
          ? preSnap
          : r.quoted_amount != null
            ? { amount: parseFloat(r.quoted_amount) }
            : null;
        let rawProps = proposalsByOrderId.get(r.order_id) || [];
        rawProps = quoteProposalPublic.prependPreQuoteProposalToList(rawProps, headPlan, r.accepted_at);
        rawProps = sanitizeQuoteProposalHistoryForPublicList(rawProps);

        const granular = applyGranularPublicImages(r, {
          before_images: beforeImgs,
          after_images: afterImgs,
          completion_images: completionImgs,
          material_photos: material_photos,
          fault_evidence_images: Array.isArray(faultImgs) ? faultImgs : [],
          settlement_list_image: r.settlement_list_image || null,
        });
        const {
          before_images: beforeOut,
          after_images: afterOut,
          completion_images: completionOut,
          material_photos: materialOut,
          settlement_list_image: settlementPub,
        } = granular;
        const quote_credential_urls = [];
        const settleUrl = settlementPub != null ? String(settlementPub).trim() : '';
        if (settleUrl) quote_credential_urls.push(settleUrl);

        return {
          review_id: r.review_id,
          order_id: r.order_id,
          is_my_review: !!currentUserId && r.user_id === currentUserId,
          user: {
            nickname: r.is_anonymous ? '匿名用户' : r.nickname,
            avatar_url: r.is_anonymous ? '' : r.avatar_url,
            level_name: levelName
          },
          rating: r.rating,
          ratings: {
            quality: r.ratings_quality,
            price: r.ratings_price,
            service: r.ratings_service,
            speed: r.ratings_speed,
            parts: r.ratings_parts,
          },
          content: r.content,
          repair_items: repairItems,
          part_promise_lines: part_promise_lines,
          material_photos: materialOut,
          amount,
          before_images: beforeOut,
          after_images: afterOut,
          completion_images: completionOut,
          objective_answers: objAnswers,
          ai_analysis: typeof r.ai_analysis === 'string' ? JSON.parse(r.ai_analysis || '{}') : (r.ai_analysis || {}),
          like_count: r.like_count ?? stats.like_count ?? 0,
          dislike_count: r.dislike_count ?? 0,
          is_liked: userLikedIds.has(r.review_id),
          is_disliked: false,
          post_verify_count: stats.post_verify_count ?? 0,
          has_owner_verify_badge: !!stats.has_owner_verify_badge,
          created_at: r.created_at,
          shop: {
            shop_id: r.shop_id,
            name: r.shop_name,
            logo: r.shop_logo,
            address: r.shop_address,
            district: r.shop_district,
          },
          quote_proposal_history: rawProps,
          quote_credential_urls,
          review_system_checks: sanitizeSystemChecksForUserFacing(r.review_system_checks),
        };
      }),
      total: Number(total),
      page: pageNum,
      limit: limitNum,
      /** 冷启动：全站严格条件下可展示条数不足时，已自动含 L1 评价并关闭 3 天新鲜度 */
      feed_relaxed: feedRelaxed,
    },
  };
}

/**
 * 记录评价聚合页浏览（新鲜度：3天内不重复展示）
 */
async function recordView(pool, userId, reviewId) {
  if (!userId || !reviewId) return { success: false };
  try {
    const [tables] = await pool.execute(
      "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'review_feed_views'"
    );
    if (tables.length === 0) return { success: true };
    await pool.execute(
      `INSERT INTO review_feed_views (user_id, review_id, viewed_at) VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE viewed_at = NOW()`,
      [userId, reviewId]
    );
    return { success: true };
  } catch (err) {
    console.error('[review-feed recordView]', err);
    return { success: false };
  }
}

module.exports = {
  getReviewFeed,
  recordView,
};
