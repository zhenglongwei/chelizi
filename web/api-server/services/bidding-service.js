/**
 * 竞价统一查询服务
 * 保证工作台 count 与竞价列表 list/total 使用同一套筛选逻辑，避免不一致
 * 详见 docs/竞价流程与状态流转.md
 * 全指标第六章：报价排序分 = 服务商综合匹配分 × 70% + 报价合理性分 × 30%
 */

const crypto = require('crypto');
const antifraud = require('../antifraud');
const rewardCalculator = require('../reward-calculator');
const biddingDistribution = require('./bidding-distribution');
const LOG_PREFIX = '[BiddingService]';

function merchantVisibleWhereFragment(tablePrefix = 'b') {
  const b = tablePrefix;
  const u = 'u';
  const s = 's';
  const acosArg = `cos(radians(${u}.latitude)) * cos(radians(${s}.latitude)) * cos(radians(${s}.longitude) - radians(${u}.longitude)) + sin(radians(${u}.latitude)) * sin(radians(${s}.latitude))`;
  return `${b}.status = 0 AND ${b}.expire_at > NOW()
    AND ${u}.latitude IS NOT NULL AND ${u}.longitude IS NOT NULL
    AND ${s}.latitude IS NOT NULL AND ${s}.longitude IS NOT NULL
    AND (6371 * acos(LEAST(1, GREATEST(-1, ${acosArg})))) <= ${b}.range_km`;
}

async function countPendingBiddingsForShop(pool, shopId, log = {}) {
  const { total } = await listBiddingsForShop(pool, shopId, 'pending', 1, 1, log);
  return total;
}

async function listBiddingsForShop(pool, shopId, status, page, limit, log = {}) {
  const reqId = log.reqId || '';
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
  const offsetNum = Math.max(0, ((parseInt(page, 10) || 1) - 1) * limitNum);

  let list = [];
  let total = 0;

  if (status === 'ended') {
    const [listRows] = await pool.execute(
      `SELECT b.bidding_id, b.report_id, b.vehicle_info, b.range_km, b.expire_at, b.created_at, b.status as bidding_status, b.selected_shop_id,
        dr.analysis_result,
        NULL as user_lat, NULL as user_lng, NULL as shop_lat, NULL as shop_lng,
        1 as quoted,
        q.quote_status as my_quote_status
       FROM biddings b
       INNER JOIN quotes q ON q.bidding_id = b.bidding_id AND q.shop_id = ?
       INNER JOIN damage_reports dr ON b.report_id = dr.report_id
       WHERE b.status = 1
       ORDER BY b.updated_at DESC, b.created_at DESC
       LIMIT ${limitNum} OFFSET ${offsetNum}`,
      [shopId]
    );
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) as total FROM biddings b
       INNER JOIN quotes q ON q.bidding_id = b.bidding_id AND q.shop_id = ?
       WHERE b.status = 1`,
      [shopId]
    );
    list = listRows || [];
    total = countRows[0]?.total || 0;
  } else {
    const baseWhere = merchantVisibleWhereFragment('b');
    const quoteCondition = status === 'quoted' ? '> 0' : '= 0';
    const visibilityFragment = `AND (
      NOT EXISTS (SELECT 1 FROM bidding_distribution bd2 WHERE bd2.bidding_id = b.bidding_id)
      OR EXISTS (
        SELECT 1 FROM bidding_distribution bd
        WHERE bd.bidding_id = b.bidding_id AND bd.shop_id = ?
        AND (
          bd.tier = 1
          OR (bd.tier = 2 AND (b.tier1_window_ends_at IS NULL OR NOW() >= b.tier1_window_ends_at))
          OR (bd.tier = 3 AND (b.tier1_window_ends_at IS NULL OR NOW() >= b.tier1_window_ends_at)
              AND (SELECT COUNT(*) FROM quotes q2 WHERE q2.bidding_id = b.bidding_id AND q2.quote_status = 0) < 3)
        )
      )
    )`;

    const countSql = `SELECT COUNT(DISTINCT b.bidding_id) as total FROM biddings b
      INNER JOIN damage_reports dr ON b.report_id = dr.report_id
      INNER JOIN users u ON b.user_id = u.user_id
      INNER JOIN shops s ON s.shop_id = ?
      WHERE ${baseWhere}
        ${visibilityFragment}
        AND (SELECT COUNT(*) FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.shop_id = ?) ${quoteCondition}`;
    const [countRows] = await pool.execute(countSql, [shopId, shopId, shopId]);
    total = countRows[0]?.total ?? 0;

    const listSql = `SELECT * FROM (
      SELECT b.bidding_id, b.report_id, b.vehicle_info, b.range_km, b.expire_at, b.created_at, b.status as bidding_status, b.selected_shop_id,
        dr.analysis_result,
        u.latitude as user_lat, u.longitude as user_lng,
        s.latitude as shop_lat, s.longitude as shop_lng,
        (SELECT COUNT(*) FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.shop_id = ?) as quoted,
        (SELECT q.quote_status FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.shop_id = ? LIMIT 1) as my_quote_status
       FROM biddings b
       INNER JOIN damage_reports dr ON b.report_id = dr.report_id
       INNER JOIN users u ON b.user_id = u.user_id
       INNER JOIN shops s ON s.shop_id = ?
       WHERE ${baseWhere}
         ${visibilityFragment}
         AND (SELECT COUNT(*) FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.shop_id = ?) ${quoteCondition}
    ) t ORDER BY created_at DESC LIMIT ${limitNum} OFFSET ${offsetNum}`;
    const listParams = [shopId, shopId, shopId, shopId, shopId];
    const [listRows] = await pool.execute(listSql, listParams);
    list = listRows || [];

    console.log(`${LOG_PREFIX} [listBiddings] shopId=${shopId} status=${status} page=${page} limit=${limitNum} offset=${offsetNum} total=${total} listLen=${list.length} ${reqId}`);
  }

  return { list, total };
}

function mapBiddingRowToItem(row) {
  let vehicleInfo = {};
  try {
    vehicleInfo = typeof row.vehicle_info === 'string' ? JSON.parse(row.vehicle_info) : (row.vehicle_info || {});
  } catch (_) {}
  let analysis = {};
  try {
    analysis = typeof row.analysis_result === 'string' ? JSON.parse(row.analysis_result || '{}') : (row.analysis_result || {});
  } catch (_) {}
  let distance = null;
  if (row.user_lat != null && row.shop_lat != null) {
    const R = 6371;
    const dLat = (row.shop_lat - row.user_lat) * Math.PI / 180;
    const dLng = (row.shop_lng - row.user_lng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(row.user_lat * Math.PI / 180) * Math.cos(row.shop_lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    distance = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
  }
  // 列表展示用默认 L2，具体复杂度在选厂下单时由 reward-calculator 从 repair_complexity_levels 匹配
  const complexityLevel = 'L2';
  return {
    bidding_id: row.bidding_id,
    report_id: row.report_id,
    vehicle_info: vehicleInfo,
    analysis_result: analysis,
    range_km: row.range_km,
    expire_at: row.expire_at,
    created_at: row.created_at,
    distance_km: distance,
    quoted: (row.quoted || 0) > 0,
    complexity_level: complexityLevel,
    bidding_status: row.bidding_status,
    selected_shop_id: row.selected_shop_id,
    my_quote_status: row.my_quote_status != null ? row.my_quote_status : 0
  };
}

/**
 * 报价合理性分（0-100）
 * 以定损预估中值为基准，报价 ±10% 内满分，偏离线性扣分
 */
function calcQuoteReasonablenessScore(quoteAmount, benchmarkAmount) {
  if (benchmarkAmount == null || benchmarkAmount <= 0) return 100;
  const amount = parseFloat(quoteAmount) || 0;
  const ratio = amount / benchmarkAmount;
  if (ratio >= 0.9 && ratio <= 1.1) return 100;
  if (ratio <= 0.5 || ratio >= 2) return 0;
  const dev = ratio < 1 ? (1 - ratio) : (ratio - 1);
  return Math.round((1 - Math.min(dev / 0.5, 1)) * 1000) / 10;
}

/**
 * 综合匹配分（0-100）
 * 全指标 6.2：店铺综合得分 × 场景权重 + 同项目完单量分 + 报价历史准确度分 + 时效履约率分
 * 简化：shop_score + deviation_rate 扣分 + total_orders 加分
 */
function calcMatchScore(shop) {
  const score = shop.shop_score != null ? parseFloat(shop.shop_score) : (shop.rating != null ? parseFloat(shop.rating) * 20 : 50);
  const deviation = shop.deviation_rate != null ? parseFloat(shop.deviation_rate) : 0;
  const orders = shop.total_orders != null ? parseInt(shop.total_orders, 10) : 0;
  let s = Math.min(100, Math.max(0, score));
  if (deviation > 30) s -= 20;
  else if (deviation > 10) s -= (deviation - 10);
  if (orders >= 100) s = Math.min(100, s + 5);
  return Math.max(0, Math.min(100, s));
}

/**
 * 按全指标 6.4 对报价列表排序
 * 报价排序分 = 服务商综合匹配分 × 70% + 报价合理性分 × 30%
 * @param {Array} quotes - 报价列表（含 shop 字段：shop_score, rating, deviation_rate, total_orders）
 * @param {number} benchmarkAmount - 公允价/定损预估中值（元）
 */
function sortQuotesByScore(quotes, benchmarkAmount) {
  if (!quotes || quotes.length === 0) return quotes;
  const bench = parseFloat(benchmarkAmount) || 0;
  const scored = quotes.map((q) => {
    const matchScore = calcMatchScore(q);
    const reasonScore = calcQuoteReasonablenessScore(q.amount, bench);
    const sortScore = matchScore * 0.7 + reasonScore * 0.3;
    return { ...q, _quote_sort_score: sortScore };
  });
  scored.sort((a, b) => (b._quote_sort_score || 0) - (a._quote_sort_score || 0));
  return scored;
}

function normalizePlate(s) {
  return (String(s || '').replace(/[\s·\-]/g, '')).toUpperCase();
}

/**
 * 创建竞价
 * 规则：同一用户+同一车牌号只能有一个进行中的竞价；未填车牌禁止提交；发现重复则返回已有竞价
 */
async function createBidding(pool, userId, body) {
  const { report_id, range, insurance_info, vehicle_info, latitude, longitude } = body || {};
  if (!report_id) {
    return { success: false, error: '定损报告ID不能为空', statusCode: 400 };
  }
  // 0 级禁止下单（点赞追加奖金方案：0级仅浏览，禁止下单/评价；点赞保持开放）
  const trust = await antifraud.getUserTrustLevel(pool, userId);
  if (trust.level === 0) {
    return { success: false, error: '您的账号等级不足，完成实名认证和车辆绑定后可发起竞价', statusCode: 403 };
  }
  const vi = vehicle_info && typeof vehicle_info === 'object' ? vehicle_info : {};
  const plate = (vi.plate_number || vi.plateNumber || '').trim();
  if (!plate) {
    return { success: false, error: '请填写车牌号', statusCode: 400 };
  }
  const plateNorm = normalizePlate(plate);

  const [existingByReport] = await pool.execute(
    'SELECT bidding_id FROM biddings WHERE report_id = ? AND user_id = ? AND status = 0 LIMIT 1',
    [report_id, userId]
  );
  if (existingByReport.length > 0) {
    return {
      success: true,
      data: { bidding_id: existingByReport[0].bidding_id, duplicate: true },
      message: '该定损单已发起竞价，正在跳转'
    };
  }

  const [ongoingBiddings] = await pool.execute(
    'SELECT bidding_id, vehicle_info FROM biddings WHERE user_id = ? AND status = 0',
    [userId]
  );
  for (const row of ongoingBiddings || []) {
    let vInfo = {};
    try {
      vInfo = typeof row.vehicle_info === 'string' ? JSON.parse(row.vehicle_info) : (row.vehicle_info || {});
    } catch (_) {}
    const existingPlate = (vInfo.plate_number || vInfo.plateNumber || '').trim();
    if (existingPlate && normalizePlate(existingPlate) === plateNorm) {
      return {
        success: true,
        data: { bidding_id: row.bidding_id, duplicate: true },
        message: '该车牌已有进行中的竞价，正在跳转'
      };
    }
  }
  const lat = latitude != null && !isNaN(Number(latitude)) ? Number(latitude) : null;
  const lng = longitude != null && !isNaN(Number(longitude)) ? Number(longitude) : null;
  if (lat != null && lng != null) {
    await pool.execute(
      'UPDATE users SET latitude = ?, longitude = ?, updated_at = NOW() WHERE user_id = ?',
      [lat, lng, userId]
    );
  }
  const biddingId = 'BID' + Date.now();
  const expireAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const config = await biddingDistribution.getBiddingDistributionConfig(pool);
  const tier1Minutes = config.tier1ExclusiveMinutes || 15;
  const tier1WindowEndsAt = new Date(Date.now() + tier1Minutes * 60 * 1000);
  await pool.execute(
    `INSERT INTO biddings (bidding_id, user_id, report_id, vehicle_info, 
     insurance_info, range_km, status, expire_at, tier1_window_ends_at, created_at) 
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NOW())`,
    [biddingId, userId, report_id, JSON.stringify(vehicle_info || {}), JSON.stringify(insurance_info || {}), range || 5, expireAt, tier1WindowEndsAt]
  );
  try {
    await biddingDistribution.runBiddingDistribution(pool, biddingId);
  } catch (distErr) {
    console.warn(`${LOG_PREFIX} runBiddingDistribution error:`, distErr.message);
  }
  return { success: true, data: { bidding_id: biddingId } };
}

/**
 * 选择维修厂（选厂下单）
 */
async function selectQuote(pool, req) {
  const id = (req.params || {}).id;
  const { shop_id } = req.body || {};
  const userId = req.userId;

  if (!id || !shop_id) {
    return { success: false, error: id ? '维修厂ID不能为空' : '竞价ID不能为空', statusCode: 400 };
  }
  // 0 级禁止下单
  const trust = await antifraud.getUserTrustLevel(pool, userId);
  if (trust.level === 0) {
    return { success: false, error: '您的账号等级不足，完成实名认证和车辆绑定后可下单', statusCode: 403 };
  }

  const [existingOrder] = await pool.execute(
    'SELECT order_id FROM orders WHERE bidding_id = ? AND status != 4 LIMIT 1',
    [id]
  );
  if (existingOrder.length > 0) {
    return { success: false, error: '该竞价已选择维修厂，请勿重复操作', statusCode: 400 };
  }

  const [biddingCheck] = await pool.execute('SELECT status FROM biddings WHERE bidding_id = ?', [id]);
  if (biddingCheck.length > 0 && biddingCheck[0].status !== 0) {
    return { success: false, error: '该竞价已结束', statusCode: 400 };
  }

  const [quotes] = await pool.execute('SELECT * FROM quotes WHERE bidding_id = ? AND shop_id = ?', [id, shop_id]);
  if (quotes.length === 0) {
    return { success: false, error: '报价不存在', statusCode: 404 };
  }
  const quote = quotes[0];

  const [shopRows] = await pool.execute('SELECT qualification_status FROM shops WHERE shop_id = ?', [shop_id]);
  if (shopRows.length === 0 || (shopRows[0].qualification_status !== 1 && shopRows[0].qualification_status !== '1')) {
    return { success: false, error: '该维修厂暂未通过资质审核，无法选择', statusCode: 403 };
  }

  const ip = req.ip || req.headers?.['x-forwarded-for'] || '';
  const [userRow] = await pool.execute('SELECT phone FROM users WHERE user_id = ?', [userId]);
  const bl = await antifraud.checkBlacklist(pool, userId, userRow[0]?.phone, ip);
  if (bl.blocked) {
    return { success: false, error: bl.reason || '账号存在异常，暂无法下单', statusCode: 403 };
  }

  const afConfig = await antifraud.getAntifraudConfig(pool);
  const [userCreatedRow] = await pool.execute('SELECT created_at FROM users WHERE user_id = ?', [userId]);
  const userCreatedAt = userCreatedRow.length > 0 ? new Date(userCreatedRow[0].created_at) : null;
  const now = new Date();
  const sameShopDaysAgo = new Date(now.getTime() - afConfig.orderSameShopDays * 24 * 60 * 60 * 1000);
  const newUserDaysAgo = new Date(now.getTime() - afConfig.newUserDays * 24 * 60 * 60 * 1000);

  const [sameShopCount] = await pool.execute(
    `SELECT COUNT(*) as c FROM orders WHERE user_id = ? AND shop_id = ? AND created_at >= ? AND status != 4`,
    [userId, shop_id, sameShopDaysAgo]
  );
  if ((sameShopCount[0]?.c || 0) >= afConfig.orderSameShopMax) {
    return { success: false, error: `您在该商户 ${afConfig.orderSameShopDays} 天内已有 ${afConfig.orderSameShopMax} 笔订单，为保障交易真实性暂无法继续下单`, statusCode: 400 };
  }

  const isNewUser = userCreatedAt && userCreatedAt > newUserDaysAgo;
  if (isNewUser) {
    const [recentOrders] = await pool.execute(
      `SELECT COUNT(*) as c FROM orders WHERE user_id = ? AND created_at >= ? AND status != 4`,
      [userId, newUserDaysAgo]
    );
    if ((recentOrders[0]?.c || 0) >= afConfig.newUserOrderMax) {
      return { success: false, error: `新用户 ${afConfig.newUserDays} 天内最多下单 ${afConfig.newUserOrderMax} 笔，为保障交易真实性请稍后再试`, statusCode: 400 };
    }
  }

  const orderId = 'ORD' + Date.now();
  await pool.execute(
    `INSERT INTO orders (order_id, bidding_id, user_id, shop_id, quote_id, quoted_amount, status, created_at) 
     VALUES (?, ?, ?, ?, ?, ?, 0, NOW())`,
    [orderId, id, userId, shop_id, quote.quote_id, quote.amount]
  );

  try {
    const [biddings] = await pool.execute('SELECT vehicle_info FROM biddings WHERE bidding_id = ?', [id]);
    let vehicleInfo = {};
    if (biddings.length > 0 && biddings[0].vehicle_info) {
      try {
        vehicleInfo = typeof biddings[0].vehicle_info === 'string' ? JSON.parse(biddings[0].vehicle_info) : biddings[0].vehicle_info;
      } catch (_) {}
    }
    let quoteItems = [];
    if (quote.items) {
      try {
        quoteItems = typeof quote.items === 'string' ? JSON.parse(quote.items) : quote.items;
      } catch (_) {}
    }
    const [shops] = await pool.execute('SELECT compliance_rate, complaint_rate FROM shops WHERE shop_id = ?', [shop_id]);
    const shop = shops.length > 0 ? shops[0] : {};
    const orderRow = { quoted_amount: quote.amount, actual_amount: null, order_tier: null, complexity_level: null, vehicle_price_tier: null };
    const result = await rewardCalculator.calculateReward(pool, orderRow, vehicleInfo, quoteItems, shop);
    await pool.execute(
      `UPDATE orders SET order_tier = ?, complexity_level = ?, vehicle_price_tier = ?,
       reward_preview = ?, commission_rate = ? WHERE order_id = ?`,
      [result.order_tier, result.complexity_level, result.vehicle_price_tier, result.reward_pre, result.commission_rate * 100, orderId]
    );
  } catch (err) {
    console.error('[BiddingService] 奖励金/佣金计算失败:', err.message);
  }

  await pool.execute(
    'UPDATE quotes SET quote_status = 1 WHERE bidding_id = ? AND shop_id = ?',
    [id, shop_id]
  );
  await pool.execute(
    'UPDATE quotes SET quote_status = 2 WHERE bidding_id = ? AND shop_id != ?',
    [id, shop_id]
  );
  await pool.execute(
    'UPDATE biddings SET status = 1, selected_shop_id = ?, updated_at = NOW() WHERE bidding_id = ?',
    [shop_id, id]
  );

  try {
    const [merchantRows] = await pool.execute(
      'SELECT merchant_id FROM merchant_users WHERE shop_id = ? LIMIT 1',
      [shop_id]
    );
    if (merchantRows.length > 0) {
      const msgId = 'mmsg_' + crypto.randomBytes(12).toString('hex');
      await pool.execute(
        `INSERT INTO merchant_messages (message_id, merchant_id, type, title, content, related_id, is_read)
         VALUES (?, ?, 'order', ?, ?, ?, 0)`,
        [msgId, merchantRows[0].merchant_id, '新订单待接单', `您有一笔新订单待接单，报价金额 ¥${quote.amount}。`, orderId]
      );
    }
  } catch (msgErr) {
    if (!String((msgErr && msgErr.message) || '').includes('merchant_messages')) {
      console.warn('[BiddingService] 创建服务商消息失败:', msgErr && msgErr.message);
    }
  }

  return { success: true, data: { order_id: orderId } };
}

/**
 * 结束竞价
 */
async function endBidding(pool, biddingId, userId) {
  const [biddings] = await pool.execute(
    'SELECT bidding_id, status FROM biddings WHERE bidding_id = ? AND user_id = ?',
    [biddingId, userId]
  );
  if (biddings.length === 0) {
    return { success: false, error: '竞价不存在', statusCode: 404 };
  }
  if (biddings[0].status !== 0) {
    return { success: false, error: '该竞价已结束', statusCode: 400 };
  }

  const [quoteCount] = await pool.execute('SELECT COUNT(*) as c FROM quotes WHERE bidding_id = ?', [biddingId]);
  const quotesAffected = quoteCount[0]?.c || 0;

  await pool.execute(
    'UPDATE biddings SET status = 1, updated_at = NOW() WHERE bidding_id = ?',
    [biddingId]
  );
  await pool.execute(
    'UPDATE quotes SET quote_status = 2 WHERE bidding_id = ?',
    [biddingId]
  );

  return { success: true, data: { quotesInvalidated: quotesAffected } };
}

module.exports = {
  countPendingBiddingsForShop,
  listBiddingsForShop,
  mapBiddingRowToItem,
  merchantVisibleWhereFragment,
  sortQuotesByScore,
  calcQuoteReasonablenessScore,
  calcMatchScore,
  createBidding,
  selectQuote,
  endBidding,
};
