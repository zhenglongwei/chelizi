/**
 * 竞价统一查询服务
 * 保证工作台 count 与竞价列表 list/total 使用同一套筛选逻辑，避免不一致
 * 详见 docs/竞价流程与状态流转.md
 *
 * 注意：MySQL/MariaDB 预编译语句中 LIMIT/OFFSET 使用占位符可能返回 0 行，
 * 故 list 查询使用字面量拼接（limit/offset 已用 parseInt 校验，防注入）
 */

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

    const countSql = `SELECT COUNT(DISTINCT b.bidding_id) as total FROM biddings b
      INNER JOIN damage_reports dr ON b.report_id = dr.report_id
      INNER JOIN users u ON b.user_id = u.user_id
      INNER JOIN shops s ON s.shop_id = ?
      WHERE ${baseWhere}
        AND (SELECT COUNT(*) FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.shop_id = ?) ${quoteCondition}`;
    const [countRows] = await pool.execute(countSql, [shopId, shopId]);
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
         AND (SELECT COUNT(*) FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.shop_id = ?) ${quoteCondition}
    ) t ORDER BY created_at DESC LIMIT ${limitNum} OFFSET ${offsetNum}`;
    const listParams = [shopId, shopId, shopId, shopId];
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
  const est = analysis.total_estimate;
  const estMid = Array.isArray(est) && est.length >= 2 ? (parseFloat(est[0]) + parseFloat(est[1])) / 2 : 5000;
  let complexityLevel = 'L2';
  if (estMid < 1000) complexityLevel = 'L1';
  else if (estMid < 5000) complexityLevel = 'L2';
  else if (estMid < 20000) complexityLevel = 'L3';
  else complexityLevel = 'L4';
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

module.exports = {
  countPendingBiddingsForShop,
  listBiddingsForShop,
  mapBiddingRowToItem,
  merchantVisibleWhereFragment
};
