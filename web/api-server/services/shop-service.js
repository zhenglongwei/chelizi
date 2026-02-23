/**
 * 店铺服务
 * 附近、搜索、详情、评价列表
 * 依赖 shop-sort-service、antifraud
 */

const shopSortService = require('../shop-sort-service');
const antifraud = require('../antifraud');

async function getSetting(pool, key, defaultValue = '') {
  try {
    const [rows] = await pool.execute('SELECT `value` FROM settings WHERE `key` = ?', [key]);
    return rows.length > 0 ? String(rows[0].value || '').trim() : defaultValue;
  } catch {
    return defaultValue;
  }
}

function mapShop(s, hasDistance = false) {
  const base = {
    shop_id: s.shop_id,
    name: s.name,
    logo: s.logo,
    address: s.address,
    district: s.district,
    rating: s.rating,
    rating_count: s.rating_count,
    total_orders: s.total_orders,
    deviation_rate: s.deviation_rate,
    is_certified: !!s.is_certified,
    categories: JSON.parse(s.categories || '[]'),
    compliance_rate: s.compliance_rate,
    complaint_rate: s.complaint_rate,
    qualification_level: s.qualification_level,
    technician_certs: typeof s.technician_certs === 'string' ? (s.technician_certs ? JSON.parse(s.technician_certs) : null) : s.technician_certs,
  };
  if (hasDistance) {
    base.distance = s.distance != null ? Math.round(s.distance * 10) / 10 : null;
  }
  if (s.shop_score != null) {
    base.shop_score = s.shop_score;
  }
  return base;
}

/**
 * 附近维修厂
 */
async function getNearby(pool, query) {
  const { latitude, longitude, page = 1, limit = 20, category, max_km, sort = 'default', scene = 'L1L2' } = query;
  const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
  const pageNum = Math.max(parseInt(page) || 1, 1);
  const offset = (pageNum - 1) * limitNum;

  let whereClause = 'WHERE status = 1 AND (qualification_status = 1 OR qualification_status IS NULL)';
  const params = [];

  if (category) {
    whereClause += ' AND JSON_CONTAINS(categories, ?)';
    params.push(`"${category}"`);
  }

  const maxKmFromSettings = parseFloat(await getSetting(pool, 'nearby_max_km', '50')) || 50;
  const effectiveMaxKm = max_km != null ? Math.min(Math.max(parseFloat(max_km) || 50, 1), 500) : maxKmFromSettings;

  if (latitude && longitude) {
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    let sql = `SELECT *, 
        (6371 * acos(cos(radians(?)) * cos(radians(latitude)) * 
        cos(radians(longitude) - radians(?)) + sin(radians(?)) * sin(radians(latitude)))) AS distance
       FROM shops ${whereClause}`;
    const sqlParams = [lat, lng, lat, ...params];
    sql += ' HAVING distance <= ?';
    sqlParams.push(effectiveMaxKm);

    let shops;
    let totalCount;
    if (sort === 'default') {
      sql += ' LIMIT 200';
      const [rows] = await pool.execute(sql, sqlParams);
      await shopSortService.ensureShopScores(pool, rows);
      const sorted = await shopSortService.sortShopsByScore(pool, rows, {
        maxKm: effectiveMaxKm,
        scene: scene === 'L3L4' ? 'L3L4' : scene === 'brand' ? 'brand' : 'L1L2',
      });
      totalCount = sorted.length;
      shops = sorted.slice(offset, offset + limitNum);
    } else {
      const countSql = `SELECT COUNT(*) as c FROM (
        SELECT shop_id FROM shops ${whereClause}
        HAVING (6371 * acos(LEAST(1, GREATEST(-1, cos(radians(?)) * cos(radians(latitude)) * cos(radians(longitude) - radians(?)) + sin(radians(?)) * sin(radians(latitude))))) <= ?
      ) x`;
      const [cnt] = await pool.execute(countSql, [lat, lng, lat, ...params, effectiveMaxKm]);
      totalCount = cnt[0]?.c ?? 0;
      sql += ' ORDER BY distance LIMIT ? OFFSET ?';
      sqlParams.push(limitNum, offset);
      const [rows] = await pool.execute(sql, sqlParams);
      shops = rows;
    }

    return {
      success: true,
      data: {
        list: shops.map(s => mapShop(s, true)),
        total: totalCount,
      },
    };
  }

  // 无位置
  let orderBy = 'total_orders DESC';
  if (sort === 'default') {
    const [rows] = await pool.execute(`SELECT * FROM shops ${whereClause} LIMIT 200`, params);
    await shopSortService.ensureShopScores(pool, rows);
    const shops = await shopSortService.sortShopsByScore(pool, rows, { scene: scene === 'L3L4' ? 'L3L4' : scene === 'brand' ? 'brand' : 'L1L2' });
    const paged = shops.slice(offset, offset + limitNum);
    return {
      success: true,
      data: {
        list: paged.map(s => mapShop(s, false)),
        total: shops.length,
      },
    };
  }
  if (sort === 'rating') orderBy = 'rating DESC, total_orders DESC';
  else if (sort === 'orders') orderBy = 'total_orders DESC';
  else if (sort === 'compliance_rate') orderBy = 'COALESCE(compliance_rate, 0) DESC, total_orders DESC';
  else if (sort === 'complaint_rate') orderBy = 'COALESCE(complaint_rate, 100) ASC, total_orders DESC';

  const [shops] = await pool.execute(
    `SELECT * FROM shops ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, limitNum, offset]
  );

  return {
    success: true,
    data: {
      list: shops.map(s => mapShop(s, false)),
      total: shops.length,
    },
  };
}

/**
 * 搜索维修厂
 */
async function search(pool, query) {
  const { keyword, category, sort = 'default', page = 1, limit = 20, latitude, longitude, max_km = 50, scene = 'L1L2' } = query;
  const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
  const pageNum = Math.max(parseInt(page) || 1, 1);
  const offset = (pageNum - 1) * limitNum;

  let whereClause = 'WHERE status = 1 AND (qualification_status = 1 OR qualification_status IS NULL)';
  const params = [];

  if (keyword && keyword.trim()) {
    whereClause += ' AND (name LIKE ? OR address LIKE ?)';
    const q = '%' + keyword.trim() + '%';
    params.push(q, q);
  }
  if (category) {
    whereClause += ' AND JSON_CONTAINS(categories, ?)';
    params.push(`"${category}"`);
  }

  const effectiveMaxKm = Math.min(Math.max(parseFloat(max_km) || 50, 1), 500);

  if (latitude && longitude) {
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    let sql = `SELECT *, 
        (6371 * acos(cos(radians(?)) * cos(radians(latitude)) * 
        cos(radians(longitude) - radians(?)) + sin(radians(?)) * sin(radians(latitude)))) AS distance
       FROM shops ${whereClause}`;
    const sqlParams = [lat, lng, lat, ...params];

    let shops;
    if (sort === 'default') {
      sql += ' LIMIT 200';
      const [rows] = await pool.execute(sql, sqlParams);
      await shopSortService.ensureShopScores(pool, rows);
      shops = await shopSortService.sortShopsByScore(pool, rows, {
        maxKm: effectiveMaxKm,
        scene: scene === 'L3L4' ? 'L3L4' : scene === 'brand' ? 'brand' : 'L1L2',
      });
      shops = shops.slice(offset, offset + limitNum);
    } else {
      let orderBy = 'distance';
      if (sort === 'rating') orderBy = 'rating DESC, total_orders DESC';
      else if (sort === 'orders') orderBy = 'total_orders DESC';
      else if (sort === 'compliance_rate') orderBy = 'COALESCE(compliance_rate, 0) DESC, total_orders DESC';
      else if (sort === 'complaint_rate') orderBy = 'COALESCE(complaint_rate, 100) ASC, total_orders DESC';
      sql += ` ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
      sqlParams.push(limitNum, offset);
      const [rows] = await pool.execute(sql, sqlParams);
      shops = rows;
    }

    return {
      success: true,
      data: {
        list: shops.map(s => mapShop(s, true)),
        total: shops.length,
      },
    };
  }

  let orderBy = 'total_orders DESC';
  if (sort === 'default') {
    const [rows] = await pool.execute(`SELECT * FROM shops ${whereClause} LIMIT 200`, params);
    await shopSortService.ensureShopScores(pool, rows);
    const shops = await shopSortService.sortShopsByScore(pool, rows, { scene: scene === 'L3L4' ? 'L3L4' : scene === 'brand' ? 'brand' : 'L1L2' });
    const paged = shops.slice(offset, offset + limitNum);
    return {
      success: true,
      data: {
        list: paged.map(s => mapShop(s, false)),
        total: shops.length,
      },
    };
  }
  if (sort === 'rating') orderBy = 'rating DESC, total_orders DESC';
  else if (sort === 'orders') orderBy = 'total_orders DESC';
  else if (sort === 'compliance_rate') orderBy = 'COALESCE(compliance_rate, 0) DESC, total_orders DESC';
  else if (sort === 'complaint_rate') orderBy = 'COALESCE(complaint_rate, 100) ASC, total_orders DESC';

  const [shops] = await pool.execute(
    `SELECT * FROM shops ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, limitNum, offset]
  );

  return {
    success: true,
    data: {
      list: shops.map(s => mapShop(s, false)),
      total: shops.length,
    },
  };
}

/**
 * 店铺详情
 */
async function getDetail(pool, shopId) {
  const [shops] = await pool.execute(
    'SELECT * FROM shops WHERE shop_id = ? AND status = 1 AND (qualification_status = 1 OR qualification_status IS NULL)',
    [shopId]
  );

  if (shops.length === 0) {
    return { success: false, error: '维修厂不存在', statusCode: 404 };
  }

  const shop = shops[0];

  const [reviewStats] = await pool.execute(
    `SELECT 
      COUNT(*) as total_reviews,
      AVG(rating) as avg_rating,
      AVG(ratings_quality) as avg_quality,
      AVG(ratings_price) as avg_price,
      AVG(ratings_service) as avg_service
     FROM reviews WHERE shop_id = ?`,
    [shopId]
  );

  const weightedScore = await antifraud.computeShopWeightedScore(pool, shopId);

  return {
    success: true,
    data: {
      shop_id: shop.shop_id,
      name: shop.name,
      logo: shop.logo,
      address: shop.address,
      province: shop.province,
      city: shop.city,
      district: shop.district,
      latitude: shop.latitude,
      longitude: shop.longitude,
      phone: shop.phone,
      business_hours: shop.business_hours,
      categories: JSON.parse(shop.categories || '[]'),
      certifications: JSON.parse(shop.certifications || '[]'),
      services: JSON.parse(shop.services || '[]'),
      rating: shop.rating,
      rating_count: shop.rating_count,
      deviation_rate: shop.deviation_rate,
      total_orders: shop.total_orders,
      is_certified: shop.is_certified,
      compliance_rate: shop.compliance_rate,
      complaint_rate: shop.complaint_rate,
      qualification_level: shop.qualification_level,
      technician_certs: typeof shop.technician_certs === 'string' ? (shop.technician_certs ? JSON.parse(shop.technician_certs) : null) : shop.technician_certs,
      review_stats: reviewStats[0],
      weighted_score: weightedScore.score,
      weighted_score_count: weightedScore.count,
    },
  };
}

/**
 * 店铺评价列表
 */
async function getReviews(pool, shopId, query) {
  const { sort = 'completeness', page = 1, limit = 20 } = query;
  const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
  const pageNum = Math.max(parseInt(page) || 1, 1);
  const offset = (pageNum - 1) * limitNum;

  const orderBy = sort === 'latest'
    ? 'r.created_at DESC'
    : '(CASE WHEN r.settlement_list_image IS NOT NULL AND r.settlement_list_image != "" THEN 1 ELSE 0 END) DESC, r.created_at DESC';

  const [reviews] = await pool.execute(
    `SELECT r.*, u.nickname, u.avatar_url 
     FROM reviews r 
     JOIN users u ON r.user_id = u.user_id 
     WHERE r.shop_id = ? AND r.type = 1
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [shopId, limitNum, offset]
  );

  const [countResult] = await pool.execute(
    'SELECT COUNT(*) as total FROM reviews WHERE shop_id = ? AND type = 1',
    [shopId]
  );

  return {
    success: true,
    data: {
      list: reviews.map(r => ({
        review_id: r.review_id,
        user: {
          nickname: r.is_anonymous ? '匿名用户' : r.nickname,
          avatar_url: r.is_anonymous ? '' : r.avatar_url,
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
        after_images: JSON.parse(r.after_images || '[]'),
        ai_analysis: JSON.parse(r.ai_analysis || '{}'),
        like_count: r.like_count,
        created_at: r.created_at,
      })),
      total: countResult[0].total,
      page: pageNum,
      limit: limitNum,
    },
  };
}

module.exports = {
  getNearby,
  search,
  getDetail,
  getReviews,
};
