/**
 * 车主端：可预约依据查询（与 appointment-service 条件对齐）
 */

const LIMIT_PER_SHOP = 10;

function repairStatusLabel(status) {
  const n = parseInt(status, 10);
  const m = { 1: '维修中', 2: '待确认完成', 3: '已完成' };
  return m[n] || '已接单';
}

/**
 * 某店可预约的标品单（已付）与维修单（已接单、未取消、且未完工）
 * 维修单不含 status=3（已完成），避免详情页点预约仍列出已结束订单。
 */
async function bookingOptionsForShop(pool, userId, shopId) {
  if (!shopId) {
    return { product_orders: [], repair_orders: [] };
  }
  const [productRows] = await pool.execute(
    `SELECT po.product_order_id, po.shop_id, po.product_name_snapshot, po.quantity, po.amount_total,
            po.paid_at, po.created_at, s.name AS shop_name
     FROM product_orders po
     JOIN shops s ON s.shop_id = po.shop_id
     WHERE po.user_id = ? AND po.shop_id = ? AND po.payment_status = 'paid'
     ORDER BY po.paid_at DESC, po.created_at DESC
     LIMIT ${LIMIT_PER_SHOP}`,
    [userId, shopId]
  );
  const [repairRows] = await pool.execute(
    `SELECT o.order_id, o.shop_id, o.status, o.quoted_amount, o.created_at, s.name AS shop_name
     FROM orders o
     JOIN shops s ON s.shop_id = o.shop_id
     WHERE o.user_id = ? AND o.shop_id = ? AND o.status IN (1, 2)
     ORDER BY o.created_at DESC
     LIMIT ${LIMIT_PER_SHOP}`,
    [userId, shopId]
  );

  const product_orders = (productRows || []).map((r) => ({
    kind: 'product_order',
    product_order_id: r.product_order_id,
    shop_id: r.shop_id,
    shop_name: r.shop_name,
    product_name: r.product_name_snapshot,
    quantity: r.quantity,
    amount_total: parseFloat(r.amount_total),
    paid_at: r.paid_at,
    sheet_title: `标品：${r.product_name_snapshot || '商品'} · 已付款`,
  }));

  const repair_orders = (repairRows || []).map((r) => ({
    kind: 'repair_order',
    order_id: r.order_id,
    shop_id: r.shop_id,
    shop_name: r.shop_name,
    status: r.status,
    status_label: repairStatusLabel(r.status),
    quoted_amount: r.quoted_amount != null ? parseFloat(r.quoted_amount) : null,
    created_at: r.created_at,
    sheet_title: `维修单 · ${repairStatusLabel(r.status)}`,
  }));

  return { product_orders, repair_orders };
}

/**
 * 登录后提示：全平台最近可预约摘要，最多 3 条（跨店）
 */
async function bookingSummary(pool, userId) {
  const [productRows] = await pool.execute(
    `SELECT po.product_order_id, po.shop_id, po.product_name_snapshot, po.paid_at, po.created_at,
            s.name AS shop_name
     FROM product_orders po
     JOIN shops s ON s.shop_id = po.shop_id
     WHERE po.user_id = ? AND po.payment_status = 'paid'
     ORDER BY COALESCE(po.paid_at, po.created_at) DESC
     LIMIT 2`,
    [userId]
  );
  const [repairRows] = await pool.execute(
    `SELECT o.order_id, o.shop_id, o.status, o.created_at, s.name AS shop_name
     FROM orders o
     JOIN shops s ON s.shop_id = o.shop_id
     WHERE o.user_id = ? AND o.status IN (1, 2)
     ORDER BY o.created_at DESC
     LIMIT 2`,
    [userId]
  );

  const items = [];
  for (const r of productRows || []) {
    items.push({
      kind: 'product_order',
      shop_id: r.shop_id,
      shop_name: r.shop_name,
      id: r.product_order_id,
      title: r.product_name_snapshot || '标品订单',
      subtitle: '已付款，可预约到店',
      sort_at: r.paid_at || r.created_at,
    });
  }
  for (const r of repairRows || []) {
    items.push({
      kind: 'repair_order',
      shop_id: r.shop_id,
      shop_name: r.shop_name,
      id: r.order_id,
      title: '维修单',
      subtitle: r.shop_name ? `${r.shop_name} · ${repairStatusLabel(r.status)}` : repairStatusLabel(r.status),
      sort_at: r.created_at,
    });
  }
  items.sort((a, b) => new Date(b.sort_at) - new Date(a.sort_at));
  const top = items.slice(0, 3).map(({ sort_at, ...rest }) => rest);

  return { has_any: top.length > 0, items: top };
}

const LIMIT_ALL = 15;

/**
 * 当前用户全平台可预约项（不限店），用于「我的」等无 shop 上下文入口
 */
async function bookingOptionsAll(pool, userId) {
  const [productRows] = await pool.execute(
    `SELECT po.product_order_id, po.shop_id, po.product_name_snapshot, po.quantity, po.amount_total,
            po.paid_at, po.created_at, s.name AS shop_name
     FROM product_orders po
     JOIN shops s ON s.shop_id = po.shop_id
     WHERE po.user_id = ? AND po.payment_status = 'paid'
     ORDER BY COALESCE(po.paid_at, po.created_at) DESC
     LIMIT ${LIMIT_ALL}`,
    [userId]
  );
  const [repairRows] = await pool.execute(
    `SELECT o.order_id, o.shop_id, o.status, o.quoted_amount, o.created_at, s.name AS shop_name
     FROM orders o
     JOIN shops s ON s.shop_id = o.shop_id
     WHERE o.user_id = ? AND o.status IN (1, 2)
     ORDER BY o.created_at DESC
     LIMIT ${LIMIT_ALL}`,
    [userId]
  );

  const product_orders = (productRows || []).map((r) => ({
    kind: 'product_order',
    product_order_id: r.product_order_id,
    shop_id: r.shop_id,
    shop_name: r.shop_name,
    product_name: r.product_name_snapshot,
    quantity: r.quantity,
    amount_total: parseFloat(r.amount_total),
    paid_at: r.paid_at,
    sheet_title: `${r.shop_name || '维修厂'} · 标品：${r.product_name_snapshot || '商品'} · 已付款`,
  }));

  const repair_orders = (repairRows || []).map((r) => ({
    kind: 'repair_order',
    order_id: r.order_id,
    shop_id: r.shop_id,
    shop_name: r.shop_name,
    status: r.status,
    status_label: repairStatusLabel(r.status),
    quoted_amount: r.quoted_amount != null ? parseFloat(r.quoted_amount) : null,
    created_at: r.created_at,
    sheet_title: `${r.shop_name || '维修厂'} · 维修单 · ${repairStatusLabel(r.status)}`,
  }));

  return { product_orders, repair_orders };
}

module.exports = {
  bookingOptionsForShop,
  bookingOptionsAll,
  bookingSummary,
};
