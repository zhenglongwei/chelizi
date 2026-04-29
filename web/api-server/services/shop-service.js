/**
 * 店铺服务
 * 附近、搜索、详情、评价列表
 * 依赖 shop-sort-service、antifraud
 * 06 文档：纯浏览无价格排序；有 keyword/category 时可按价格最低排序
 */

const shopSortService = require('../shop-sort-service');
const antifraud = require('../antifraud');
const shopProductService = require('./shop-product-service');
const { parseCompletionEvidence, parseRepairPlanEnrichment } = require('../utils/review-order-display');
const orderQuoteProposalService = require('./order-quote-proposal-service');
const quoteProposalPublic = require('../utils/quote-proposal-public-list');
const { sanitizeQuoteProposalHistoryForPublicList } = require('../utils/quote-proposal-public-sanitize');
const { applyGranularPublicImages, sanitizeSystemChecksForUserFacing } = require('../utils/review-public-system-sanitize');

/**
 * 从 shops.services JSON 中取匹配 category 的 min_price（06 文档：有产品搜索时价格排序）
 * @param {object|string} services - shops.services
 * @param {string} category - 如 钣金喷漆、发动机维修
 * @returns {number|null} 最低价或 null
 */
function getMinPriceForCategory(services, category) {
  if (!services || !category) return null;
  let arr;
  try {
    arr = typeof services === 'string' ? JSON.parse(services || '[]') : services;
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const cat = String(category).trim();
  let minPrice = null;
  for (const s of arr) {
    const name = (s.name || '').toString();
    if (!name.includes(cat) && !cat.includes(name)) continue;
    const p = parseFloat(s.min_price);
    if (!isNaN(p) && (minPrice == null || p < minPrice)) minPrice = p;
  }
  return minPrice;
}

/**
 * 有效最低价：已上架商品价与 shops.services JSON 中匹配价取更小者（任一侧有则参与）
 */
function effectiveMinPriceForShop(shop, category, productMinByShop) {
  const fromJson = getMinPriceForCategory(shop.services, category);
  const fromProd = productMinByShop && productMinByShop.get ? productMinByShop.get(shop.shop_id) : null;
  const nums = [fromJson, fromProd].filter((x) => x != null && !isNaN(x));
  if (nums.length === 0) return null;
  return Math.min(...nums);
}

/**
 * 按价格排序店铺（06 文档：有产品/服务搜索时）
 * 含 shop_products 已审核最低价；无价格时按 deviation_rate 升序
 */
function sortShopsByPrice(shops, category, productMinByShop) {
  if (!shops || shops.length === 0) return shops;
  return [...shops].sort((a, b) => {
    const pa = effectiveMinPriceForShop(a, category, productMinByShop);
    const pb = effectiveMinPriceForShop(b, category, productMinByShop);
    const da = a.deviation_rate != null ? parseFloat(a.deviation_rate) : 999;
    const db = b.deviation_rate != null ? parseFloat(b.deviation_rate) : 999;
    if (pa != null && pb != null) return pa - pb;
    if (pa != null) return -1;
    if (pb != null) return 1;
    return da - db;
  });
}

/**
 * 根据 category/keyword 推断场景（06 文档：有产品/服务搜索时）
 * 纯浏览无 category/keyword 时返回 L1L2
 */
function inferScene(category, keyword) {
  const kw = (keyword || '').toString().toLowerCase();
  if (/事故车|大修|发动机大修|变速箱/i.test(kw)) return 'L3L4';
  if (/新能源|豪华车|特斯拉|蔚来|理想|比亚迪|宝马|奔驰|奥迪/i.test(kw)) return 'brand';
  const cat = (category || '').toString();
  if (['钣金喷漆', '保养服务', '发动机维修', '电路维修'].includes(cat)) return 'L1L2';
  return 'L1L2';
}

/** 搜索/附近列表：自费意图时综合排序使用 06 文档「付款方」权重 */
function normalizePayerIntent(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'self_pay' || s === 'selfpay') return 'self_pay';
  return null;
}

async function getSetting(pool, key, defaultValue = '') {
  try {
    const [rows] = await pool.execute('SELECT `value` FROM settings WHERE `key` = ?', [key]);
    return rows.length > 0 ? String(rows[0].value || '').trim() : defaultValue;
  } catch {
    return defaultValue;
  }
}

const LATEST_REVIEW_EXCERPT_LEN = 60;

/**
 * 批量获取店铺最新短评摘要（评价为核心定位：列表项附 1 条最新短评）
 * @param {object} pool
 * @param {string[]} shopIds
 * @returns {Promise<Map<string, {latest_review_summary: string, latest_review_negative: boolean}>>}
 */
async function getLatestReviewSummaries(pool, shopIds) {
  if (!shopIds || shopIds.length === 0) return new Map();
  const placeholders = shopIds.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT r.shop_id, r.content, r.rating
     FROM reviews r
     INNER JOIN (
       SELECT shop_id, MAX(id) as max_id
       FROM reviews
       WHERE type = 1 AND status = 1
         AND content IS NOT NULL AND TRIM(content) != ''
         AND shop_id IN (${placeholders})
       GROUP BY shop_id
     ) t ON r.shop_id = t.shop_id AND r.id = t.max_id
     WHERE r.type = 1 AND r.status = 1`,
    shopIds
  );
  const map = new Map();
  for (const r of rows) {
    const content = (r.content || '').trim();
    const excerpt = content.length > LATEST_REVIEW_EXCERPT_LEN
      ? content.slice(0, LATEST_REVIEW_EXCERPT_LEN) + '…'
      : content;
    const isNegative = (r.rating != null && parseInt(r.rating, 10) <= 2);
    map.set(r.shop_id, {
      latest_review_summary: excerpt || null,
      latest_review_negative: isNegative,
    });
  }
  return map;
}

/**
 * 批量：各店在某类目下已上架商品的最低单价（元）
 */
async function batchMinProductPriceByCategory(pool, shopIds, category) {
  const map = new Map();
  if (!shopIds || !shopIds.length || !category) return map;
  const ph = shopIds.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT shop_id, MIN(price) as min_p FROM shop_products
     WHERE status = 'approved' AND category = ? AND shop_id IN (${ph})
     GROUP BY shop_id`,
    [category, ...shopIds]
  );
  for (const r of rows) {
    const v = parseFloat(r.min_p);
    if (!isNaN(v)) map.set(r.shop_id, v);
  }
  return map;
}

/**
 * 批量：各店名称/描述匹配关键词的已上架商品最低单价
 */
async function batchMinProductPriceByKeyword(pool, shopIds, keyword) {
  const map = new Map();
  if (!shopIds || !shopIds.length || !keyword || !String(keyword).trim()) return map;
  const kw = '%' + String(keyword).trim() + '%';
  const ph = shopIds.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT shop_id, MIN(price) as min_p FROM shop_products
     WHERE status = 'approved' AND shop_id IN (${ph})
       AND (name LIKE ? OR IFNULL(description,'') LIKE ?)
     GROUP BY shop_id`,
    [...shopIds, kw, kw]
  );
  for (const r of rows) {
    const v = parseFloat(r.min_p);
    if (!isNaN(v)) map.set(r.shop_id, v);
  }
  return map;
}

/**
 * 合并类目价与关键词匹配价的最低价（同一店）
 */
function mergeMinPriceMaps(a, b) {
  if (!a || !a.size) return b || new Map();
  if (!b || !b.size) return a;
  const out = new Map(a);
  for (const [k, v] of b) {
    const cur = out.get(k);
    out.set(k, cur == null || v < cur ? v : cur);
  }
  return out;
}

/** 价格排序：合并类目维度与关键词匹配的商品最低价 */
async function buildProductMinMapForPriceSort(pool, rows, category, keyword) {
  const ids = (rows || []).map((r) => r.shop_id).filter(Boolean);
  if (!ids.length) return new Map();
  let map = new Map();
  if (category) {
    map = await batchMinProductPriceByCategory(pool, ids, category);
  }
  if (keyword && String(keyword).trim()) {
    const kwMap = await batchMinProductPriceByKeyword(pool, ids, keyword);
    map = mergeMinPriceMaps(map, kwMap);
  }
  return map;
}

/**
 * 为店铺列表附加已上架商品摘要（每店最多 2 条，用于列表/口碑卡片）
 */
async function enrichShopsWithProductSnippets(pool, shopList) {
  if (!shopList || shopList.length === 0) return shopList;
  const ids = [...new Set(shopList.map((s) => s.shop_id).filter(Boolean))];
  if (!ids.length) return shopList;
  const ph = ids.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT shop_id, product_id, name, category, price
     FROM shop_products
     WHERE status = 'approved' AND shop_id IN (${ph})
     ORDER BY shop_id, created_at DESC`,
    ids
  );
  const byShop = new Map();
  for (const r of rows) {
    const arr = byShop.get(r.shop_id) || [];
    if (arr.length >= 2) continue;
    arr.push({
      product_id: r.product_id,
      name: r.name,
      category: r.category,
      price: parseFloat(r.price),
    });
    byShop.set(r.shop_id, arr);
  }
  return shopList.map((s) => {
    const snippets = byShop.get(s.shop_id) || [];
    const text =
      snippets.length === 0
        ? null
        : snippets.length === 1
          ? `${snippets[0].name} ¥${Number(snippets[0].price).toFixed(2)}`
          : `${snippets[0].name} 等${snippets.length}项服务`;
    return {
      ...s,
      product_snippets: snippets,
      product_snippet_text: text,
    };
  });
}

/** 车主列表：最新短评 + 商品摘要 */
async function enrichShopListForOwner(pool, shopList) {
  let list = await enrichShopsWithLatestReview(pool, shopList);
  list = await enrichShopsWithProductSnippets(pool, list);
  return list;
}

/**
 * 为店铺列表附加最新短评摘要
 */
async function enrichShopsWithLatestReview(pool, shopList) {
  if (!shopList || shopList.length === 0) return shopList;
  const ids = shopList.map((s) => s.shop_id).filter(Boolean);
  const summaries = await getLatestReviewSummaries(pool, ids);
  return shopList.map((s) => {
    const sum = summaries.get(s.shop_id);
    return {
      ...s,
      latest_review_summary: sum?.latest_review_summary || null,
      latest_review_negative: sum?.latest_review_negative || false,
    };
  });
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
  const { latitude, longitude, page = 1, limit = 20, category, max_km, sort = 'default', payer_intent } = query;
  const payerIntent = normalizePayerIntent(payer_intent);
  const scene = inferScene(category, '');
  const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
  const pageNum = Math.max(parseInt(page) || 1, 1);
  const offset = (pageNum - 1) * limitNum;
  const lim = Math.trunc(limitNum);
  const off = Math.trunc(offset);

  let whereClause = 'WHERE status = 1 AND (qualification_status = 1 OR qualification_status IS NULL)';
  const params = [];

  if (category) {
    whereClause += ` AND (JSON_CONTAINS(categories, ?) OR EXISTS (SELECT 1 FROM shop_products sp WHERE sp.shop_id = shops.shop_id AND sp.category = ? AND sp.status = 'approved'))`;
    params.push(`"${category}"`, category);
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
        payerIntent,
      });
      totalCount = sorted.length;
      shops = sorted.slice(offset, offset + limitNum);
    } else if (sort === 'price' && category) {
      sql += ' LIMIT 200';
      const [rows] = await pool.execute(sql, sqlParams);
      const productMin = await buildProductMinMapForPriceSort(pool, rows, category, '');
      const sorted = sortShopsByPrice(rows, category, productMin);
      totalCount = sorted.length;
      shops = sorted.slice(offset, offset + limitNum);
    } else if (sort === 'value' && category) {
      sql += ' LIMIT 200';
      const [rows] = await pool.execute(sql, sqlParams);
      const sorted = await shopSortService.sortShopsByValue(pool, rows);
      totalCount = sorted.length;
      shops = sorted.slice(offset, offset + limitNum);
    } else {
      const countSql = `SELECT COUNT(*) as c FROM (
        SELECT shop_id FROM shops ${whereClause}
        HAVING (6371 * acos(LEAST(1, GREATEST(-1, cos(radians(?)) * cos(radians(latitude)) * cos(radians(longitude) - radians(?)) + sin(radians(?)) * sin(radians(latitude))))) <= ?
      ) x`;
      const [cnt] = await pool.execute(countSql, [lat, lng, lat, ...params, effectiveMaxKm]);
      totalCount = cnt[0]?.c ?? 0;
      sql += ` ORDER BY distance LIMIT ${lim} OFFSET ${off}`;
      const [rows] = await pool.execute(sql, sqlParams);
      shops = rows;
    }

    let list = shops.map(s => mapShop(s, true));
    list = await enrichShopListForOwner(pool, list);
    return {
      success: true,
      data: {
        list,
        total: totalCount,
      },
    };
  }

  // 无位置
  let orderBy = 'total_orders DESC';
  if (sort === 'default') {
    const [rows] = await pool.execute(`SELECT * FROM shops ${whereClause} LIMIT 200`, params);
    await shopSortService.ensureShopScores(pool, rows);
    const shops = await shopSortService.sortShopsByScore(pool, rows, {
      scene: scene === 'L3L4' ? 'L3L4' : scene === 'brand' ? 'brand' : 'L1L2',
      payerIntent,
    });
    const paged = shops.slice(offset, offset + limitNum);
    let list = paged.map(s => mapShop(s, false));
    list = await enrichShopListForOwner(pool, list);
    return {
      success: true,
      data: {
        list,
        total: shops.length,
      },
    };
  }
  if (sort === 'value' && category) {
    const [rows] = await pool.execute(`SELECT * FROM shops ${whereClause} LIMIT 200`, params);
    const shops = await shopSortService.sortShopsByValue(pool, rows);
    const paged = shops.slice(offset, offset + limitNum);
    let list = paged.map(s => mapShop(s, false));
    list = await enrichShopListForOwner(pool, list);
    return {
      success: true,
      data: {
        list,
        total: shops.length,
      },
    };
  }
  if (sort === 'price' && category) {
    const [rows] = await pool.execute(`SELECT * FROM shops ${whereClause} LIMIT 200`, params);
    const productMin = await buildProductMinMapForPriceSort(pool, rows, category, '');
    const sorted = sortShopsByPrice(rows, category, productMin);
    const paged = sorted.slice(offset, offset + limitNum);
    let list = paged.map(s => mapShop(s, false));
    list = await enrichShopListForOwner(pool, list);
    return {
      success: true,
      data: {
        list,
        total: sorted.length,
      },
    };
  }
  if (sort === 'rating') orderBy = 'rating DESC, total_orders DESC';
  else if (sort === 'orders') orderBy = 'total_orders DESC';
  else if (sort === 'compliance_rate') orderBy = 'COALESCE(compliance_rate, 0) DESC, total_orders DESC';
  else if (sort === 'complaint_rate') orderBy = 'COALESCE(complaint_rate, 100) ASC, total_orders DESC';

  const [shops] = await pool.execute(
    `SELECT * FROM shops ${whereClause} ORDER BY ${orderBy} LIMIT ${lim} OFFSET ${off}`,
    [...params]
  );

  let list = shops.map(s => mapShop(s, false));
  list = await enrichShopListForOwner(pool, list);
  return {
    success: true,
    data: {
      list,
      total: shops.length,
    },
  };
}

/**
 * 搜索维修厂
 */
async function search(pool, query) {
  const { keyword, category, sort = 'default', page = 1, limit = 20, latitude, longitude, max_km = 50, payer_intent } = query;
  const payerIntent = normalizePayerIntent(payer_intent);
  const scene = inferScene(category, keyword);
  const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
  const pageNum = Math.max(parseInt(page) || 1, 1);
  const offset = (pageNum - 1) * limitNum;
  const lim = Math.trunc(limitNum);
  const off = Math.trunc(offset);

  let whereClause = 'WHERE status = 1 AND (qualification_status = 1 OR qualification_status IS NULL)';
  const params = [];

  if (keyword && keyword.trim()) {
    const q = '%' + keyword.trim() + '%';
    whereClause +=
      ' AND (name LIKE ? OR address LIKE ? OR EXISTS (SELECT 1 FROM shop_products sp_kw WHERE sp_kw.shop_id = shops.shop_id AND sp_kw.status = \'approved\' AND (sp_kw.name LIKE ? OR IFNULL(sp_kw.description,\'\') LIKE ?)))';
    params.push(q, q, q, q);
  }
  if (category) {
    // 按分类筛选：shops.categories 包含该分类，或 shop_products 有已上架商品
    whereClause += ` AND (JSON_CONTAINS(categories, ?) OR EXISTS (SELECT 1 FROM shop_products sp WHERE sp.shop_id = shops.shop_id AND sp.category = ? AND sp.status = 'approved'))`;
    params.push(`"${category}"`, category);
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
        payerIntent,
      });
      shops = shops.slice(offset, offset + limitNum);
    } else if (sort === 'price' && (keyword || category)) {
      sql += ' LIMIT 200';
      const [rows] = await pool.execute(sql, sqlParams);
      const productMin = await buildProductMinMapForPriceSort(pool, rows, category || '', keyword);
      const sorted = sortShopsByPrice(rows, category || '', productMin);
      const totalCount = sorted.length;
      shops = sorted.slice(offset, offset + limitNum);
      let listPrice = shops.map(s => mapShop(s, true));
      listPrice = await enrichShopListForOwner(pool, listPrice);
      return {
        success: true,
        data: {
          list: listPrice,
          total: totalCount,
        },
      };
    } else if (sort === 'value' && (keyword || category)) {
      sql += ' LIMIT 200';
      const [rows] = await pool.execute(sql, sqlParams);
      const sorted = await shopSortService.sortShopsByValue(pool, rows);
      const totalCount = sorted.length;
      shops = sorted.slice(offset, offset + limitNum);
      let listVal = shops.map(s => mapShop(s, true));
      listVal = await enrichShopListForOwner(pool, listVal);
      return {
        success: true,
        data: {
          list: listVal,
          total: totalCount,
        },
      };
    } else if (sort === 'score') {
      sql += ' LIMIT 200';
      const [rows] = await pool.execute(sql, sqlParams);
      await shopSortService.ensureShopScores(pool, rows);
      const sorted = rows.sort((a, b) => {
        const sa = a.shop_score != null ? parseFloat(a.shop_score) : (a.rating != null ? parseFloat(a.rating) * 20 : 0);
        const sb = b.shop_score != null ? parseFloat(b.shop_score) : (b.rating != null ? parseFloat(b.rating) * 20 : 0);
        if (sb !== sa) return sb - sa;
        const oa = a.total_orders || 0;
        const ob = b.total_orders || 0;
        return ob - oa;
      });
      shops = sorted.slice(offset, offset + limitNum);
    } else {
      let orderBy = 'distance';
      if (sort === 'rating') orderBy = 'rating DESC, total_orders DESC';
      else if (sort === 'orders') orderBy = 'total_orders DESC';
      else if (sort === 'compliance_rate') orderBy = 'COALESCE(compliance_rate, 0) DESC, total_orders DESC';
      else if (sort === 'complaint_rate') orderBy = 'COALESCE(complaint_rate, 100) ASC, total_orders DESC';
      sql += ` ORDER BY ${orderBy} LIMIT ${lim} OFFSET ${off}`;
      const [rows] = await pool.execute(sql, sqlParams);
      shops = rows;
    }

    let listWithLoc = shops.map(s => mapShop(s, true));
    listWithLoc = await enrichShopListForOwner(pool, listWithLoc);
    return {
      success: true,
      data: {
        list: listWithLoc,
        total: shops.length,
      },
    };
  }

  let orderBy = 'total_orders DESC';
  if (sort === 'default') {
    const [rows] = await pool.execute(`SELECT * FROM shops ${whereClause} LIMIT 200`, params);
    await shopSortService.ensureShopScores(pool, rows);
    const shops = await shopSortService.sortShopsByScore(pool, rows, {
      scene: scene === 'L3L4' ? 'L3L4' : scene === 'brand' ? 'brand' : 'L1L2',
      payerIntent,
    });
    const paged = shops.slice(offset, offset + limitNum);
    let listDef = paged.map(s => mapShop(s, false));
    listDef = await enrichShopListForOwner(pool, listDef);
    return {
      success: true,
      data: {
        list: listDef,
        total: shops.length,
      },
    };
  }
  if (sort === 'value' && (keyword || category)) {
    const [rows] = await pool.execute(`SELECT * FROM shops ${whereClause} LIMIT 200`, params);
    const sorted = await shopSortService.sortShopsByValue(pool, rows);
    const paged = sorted.slice(offset, offset + limitNum);
    let listVal2 = paged.map(s => mapShop(s, false));
    listVal2 = await enrichShopListForOwner(pool, listVal2);
    return {
      success: true,
      data: {
        list: listVal2,
        total: sorted.length,
      },
    };
  }
  if (sort === 'price' && (keyword || category)) {
    const [rows] = await pool.execute(`SELECT * FROM shops ${whereClause} LIMIT 200`, params);
    const productMin = await buildProductMinMapForPriceSort(pool, rows, category || '', keyword);
    const sorted = sortShopsByPrice(rows, category || '', productMin);
    const paged = sorted.slice(offset, offset + limitNum);
    let listPrice2 = paged.map(s => mapShop(s, false));
    listPrice2 = await enrichShopListForOwner(pool, listPrice2);
    return {
      success: true,
      data: {
        list: listPrice2,
        total: sorted.length,
      },
    };
  }
  if (sort === 'score') {
    const [rows] = await pool.execute(`SELECT * FROM shops ${whereClause} LIMIT 200`, params);
    await shopSortService.ensureShopScores(pool, rows);
    const sorted = rows.sort((a, b) => {
      const sa = a.shop_score != null ? parseFloat(a.shop_score) : (a.rating != null ? parseFloat(a.rating) * 20 : 0);
      const sb = b.shop_score != null ? parseFloat(b.shop_score) : (b.rating != null ? parseFloat(b.rating) * 20 : 0);
      if (sb !== sa) return sb - sa;
      const oa = a.total_orders || 0;
      const ob = b.total_orders || 0;
      return ob - oa;
    });
    const paged = sorted.slice(offset, offset + limitNum);
    let listScore = paged.map(s => mapShop(s, false));
    listScore = await enrichShopListForOwner(pool, listScore);
    return {
      success: true,
      data: {
        list: listScore,
        total: sorted.length,
      },
    };
  }
  if (sort === 'rating') orderBy = 'rating DESC, total_orders DESC';
  else if (sort === 'orders') orderBy = 'total_orders DESC';
  else if (sort === 'compliance_rate') orderBy = 'COALESCE(compliance_rate, 0) DESC, total_orders DESC';
  else if (sort === 'complaint_rate') orderBy = 'COALESCE(complaint_rate, 100) ASC, total_orders DESC';

  const [shops] = await pool.execute(
    `SELECT * FROM shops ${whereClause} ORDER BY ${orderBy} LIMIT ${lim} OFFSET ${off}`,
    [...params]
  );

  let listFinal = shops.map(s => mapShop(s, false));
  listFinal = await enrichShopListForOwner(pool, listFinal);
  return {
    success: true,
    data: {
      list: listFinal,
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

  // 评价为核心定位优化：统计时默认排除 L1 复杂度评价
  const [reviewStats] = await pool.execute(
    `SELECT 
      COUNT(*) as total_reviews,
      AVG(r.rating) as avg_rating,
      AVG(r.ratings_quality) as avg_quality,
      AVG(r.ratings_price) as avg_price,
      AVG(r.ratings_service) as avg_service
     FROM reviews r
     JOIN orders o ON r.order_id = o.order_id
     WHERE r.shop_id = ? AND r.type = 1 AND r.status = 1 AND (o.complexity_level IS NULL OR o.complexity_level != 'L1')`,
    [shopId]
  );

  const weightedScore = await antifraud.computeShopWeightedScore(pool, shopId);
  const products = await shopProductService.listPublicForShop(pool, shopId);

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
      products,
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
 * 店铺评价列表（含点赞追加奖金体系：post_verify_count、车主验证标签）
 * 评价为核心定位优化：默认排除 L1 复杂度评价（exclude_l1=1）
 */
async function getReviews(pool, shopId, query) {
  const reviewLikeService = require('./review-like-service');
  const { sort = 'completeness', page = 1, limit = 20, exclude_l1, currentUserId, repair_project_key, repair_project_item } = query;
  const excludeL1 = exclude_l1 !== '0' && exclude_l1 !== 'false'; // 默认 true
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (pageNum - 1) * limitNum;
  const lim = Math.trunc(limitNum);
  const off = Math.trunc(offset);
  if (!Number.isFinite(lim) || !Number.isFinite(off) || lim < 1 || lim > 100 || off < 0) {
    return { success: false, error: '分页参数非法', statusCode: 400 };
  }

  const orderBy = sort === 'latest'
    ? 'r.created_at DESC'
    : '(CASE WHEN r.settlement_list_image IS NOT NULL AND r.settlement_list_image != "" THEN 1 ELSE 0 END) DESC, r.created_at DESC';

  const l1Filter = excludeL1 ? ' AND (o.complexity_level IS NULL OR o.complexity_level != \'L1\')' : '';
  const projectParam = (repair_project_item || repair_project_key || '').trim();
  const projectFilter = projectParam
    ? ' AND (r.repair_project_key = ? OR r.repair_project_key LIKE ? OR r.repair_project_key LIKE ? OR r.repair_project_key LIKE ?)' : '';
  const params = [shopId];
  if (projectFilter) params.push(projectParam, projectParam + '|%', '%|' + projectParam, '%|' + projectParam + '|%');
  // LIMIT/OFFSET 不用占位符：避免部分环境下 mysql2 预处理报 Incorrect arguments to mysqld_stmt_execute

  const [reviews] = await pool.execute(
    `SELECT r.*, u.nickname, u.avatar_url, o.repair_plan, o.quoted_amount, o.actual_amount, o.completion_evidence,
            o.pre_quote_snapshot, o.accepted_at
     FROM reviews r 
     JOIN users u ON r.user_id = u.user_id 
     JOIN orders o ON r.order_id = o.order_id
     WHERE r.shop_id = ? AND r.type = 1 AND r.status = 1${l1Filter}${projectFilter}
     ORDER BY ${orderBy}
     LIMIT ${lim} OFFSET ${off}`,
    params
  );

  const countWhere = excludeL1 ? ' AND (o.complexity_level IS NULL OR o.complexity_level != \'L1\')' : '';
  const countProjectFilter = projectFilter;
  const countParams = [shopId];
  if (countProjectFilter) countParams.push(projectParam, projectParam + '|%', '%|' + projectParam, '%|' + projectParam + '|%');
  const [countResult] = await pool.execute(
    `SELECT COUNT(*) as total FROM reviews r JOIN orders o ON r.order_id = o.order_id WHERE r.shop_id = ? AND r.type = 1 AND r.status = 1${countWhere}${countProjectFilter}`,
    countParams
  );

  let repairProjectKeys = [];
  try {
    const [pkRows] = await pool.execute(
      `SELECT DISTINCT r.repair_project_key FROM reviews r JOIN orders o ON r.order_id = o.order_id
       WHERE r.shop_id = ? AND r.type = 1 AND r.status = 1 AND r.repair_project_key IS NOT NULL AND r.repair_project_key != ''${l1Filter}`,
      [shopId]
    );
    const fullKeys = (pkRows || []).map((r) => r.repair_project_key).filter(Boolean);
    const uniqueItems = new Set();
    fullKeys.forEach((k) => {
      (k || '').split('|').filter(Boolean).forEach((item) => uniqueItems.add(item));
    });
    repairProjectKeys = [...uniqueItems].sort();
  } catch (_) {}

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
      userLikedIds = new Set((likeRows || []).map((l) => l.review_id));
    } catch (_) {}
  }

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

        let afterImgsRaw;
        try {
          afterImgsRaw = typeof r.after_images === 'string' ? JSON.parse(r.after_images || '[]') : (r.after_images || []);
        } catch (_) {
          afterImgsRaw = [];
        }
        let faultImgsRaw;
        try {
          faultImgsRaw =
            typeof r.fault_evidence_images === 'string'
              ? JSON.parse(r.fault_evidence_images || '[]')
              : r.fault_evidence_images || [];
        } catch (_) {
          faultImgsRaw = [];
        }
        const granular = applyGranularPublicImages(r, {
          before_images: beforeImgs,
          after_images: afterImgsRaw,
          completion_images: completionImgs,
          material_photos: material_photos,
          fault_evidence_images: Array.isArray(faultImgsRaw) ? faultImgsRaw : [],
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
          ai_analysis: JSON.parse(r.ai_analysis || '{}'),
          like_count: r.like_count ?? stats.like_count ?? 0,
          dislike_count: r.dislike_count ?? 0,
          is_liked: userLikedIds.has(r.review_id),
          is_disliked: false,
          post_verify_count: stats.post_verify_count ?? 0,
          has_owner_verify_badge: !!stats.has_owner_verify_badge,
          created_at: r.created_at,
          quote_proposal_history: rawProps,
          quote_credential_urls,
          review_system_checks: sanitizeSystemChecksForUserFacing(r.review_system_checks),
        };
      }),
      total: countResult[0].total,
      page: pageNum,
      limit: limitNum,
      repair_project_keys: repairProjectKeys,
    },
  };
}

/**
 * 口碑榜单（价格最透明 TOP10、师傅最专业 TOP10）
 * 优先用 ratings_price/ratings_quality，为空时回退到 rating（兼容历史评价）
 * @param {object} pool
 * @param {object} query - { dimension: 'price'|'quality', limit: 10 }
 */
async function getRank(pool, query) {
  const { dimension = 'price', limit = 10 } = query;
  const limitNum = Math.min(Math.max(parseInt(limit) || 10, 1), 50);
  const limRank = Math.trunc(limitNum);
  const col = (dimension === 'quality' ? 'ratings_quality' : 'ratings_price');
  const avgExpr = `AVG(COALESCE(r.${col}, r.rating))`;

  const [rows] = await pool.execute(
    `SELECT s.shop_id, s.name, s.logo, s.rating, s.rating_count, s.total_orders, s.shop_score,
       ${avgExpr} as avg_dim
     FROM shops s
     INNER JOIN reviews r ON r.shop_id = s.shop_id AND r.type = 1 AND r.status = 1
       AND (r.${col} IS NOT NULL OR r.rating IS NOT NULL)
     WHERE s.status = 1 AND (s.qualification_status = 1 OR s.qualification_status IS NULL)
     GROUP BY s.shop_id
     HAVING COUNT(r.review_id) >= 3
     ORDER BY avg_dim DESC, s.total_orders DESC
     LIMIT ${limRank}`,
    []
  );

  await shopSortService.ensureShopScores(pool, rows);
  let rankList = rows.map(s => mapShop(s, false));
  rankList = await enrichShopListForOwner(pool, rankList);
  return {
    success: true,
    data: {
      list: rankList,
      dimension: dimension === 'quality' ? 'quality' : 'price',
    },
  };
}

module.exports = {
  getNearby,
  search,
  getDetail,
  getReviews,
  getRank,
};
