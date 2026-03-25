/**
 * 预约服务：须关联已支付标品单或已接单维修单（与 docs/产品/支付与结算总览 一致）
 */

const VALID_CATEGORIES = ['maintenance', 'wash', 'repair', 'other'];

/**
 * 提交预约
 * @param {object} body - { shop_id, appointment_date, time_slot, service_category, services, remark, product_order_id? | order_id? }
 */
async function createAppointment(pool, userId, body) {
  const {
    shop_id,
    appointment_date,
    time_slot,
    service_category,
    services,
    remark,
    product_order_id: productOrderIdRaw,
    order_id: orderIdRaw,
  } = body || {};

  const productOrderId = (productOrderIdRaw || '').trim() || null;
  const orderId = (orderIdRaw || '').trim() || null;

  if (!shop_id || !appointment_date || !time_slot) {
    return { success: false, error: '预约信息不完整', statusCode: 400 };
  }

  if (!productOrderId && !orderId) {
    return {
      success: false,
      error: '请先完成标品支付，或从「我的订单」进入已接单的维修单再预约',
      statusCode: 400,
    };
  }
  if (productOrderId && orderId) {
    return { success: false, error: '请只选择一种预约依据（标品订单或维修订单）', statusCode: 400 };
  }

  const [shops] = await pool.execute('SELECT shop_id FROM shops WHERE shop_id = ? AND status = 1', [shop_id]);
  if (shops.length === 0) {
    return { success: false, error: '维修厂不存在', statusCode: 404 };
  }

  if (productOrderId) {
    const [pos] = await pool.execute(
      `SELECT product_order_id, user_id, shop_id, payment_status FROM product_orders WHERE product_order_id = ?`,
      [productOrderId]
    );
    if (!pos.length) {
      return { success: false, error: '标品订单不存在', statusCode: 404 };
    }
    const po = pos[0];
    if (po.user_id !== userId) {
      return { success: false, error: '该标品订单不属于当前账号', statusCode: 403 };
    }
    if (po.shop_id !== shop_id) {
      return { success: false, error: '该标品订单不是在本店购买，无法预约本店', statusCode: 400 };
    }
    if (po.payment_status !== 'paid') {
      return { success: false, error: '请先完成标品支付后再预约', statusCode: 400 };
    }
  }

  if (orderId) {
    const [ords] = await pool.execute(
      `SELECT order_id, user_id, shop_id, status FROM orders WHERE order_id = ?`,
      [orderId]
    );
    if (!ords.length) {
      return { success: false, error: '维修订单不存在', statusCode: 404 };
    }
    const ord = ords[0];
    if (ord.user_id !== userId) {
      return { success: false, error: '该维修订单不属于当前账号', statusCode: 403 };
    }
    if (ord.shop_id !== shop_id) {
      return { success: false, error: '该维修订单不是本店订单，无法预约本店', statusCode: 400 };
    }
    const st = parseInt(ord.status, 10);
    if (st < 1 || st === 4) {
      return { success: false, error: '请等维修厂接单后再预约', statusCode: 400 };
    }
    if (st === 3) {
      return { success: false, error: '该维修单已完工，无需再预约到店', statusCode: 400 };
    }
  }

  const cat = VALID_CATEGORIES.includes(service_category) ? service_category : 'other';
  const appointmentId = 'APT' + Date.now();

  await pool.execute(
    `INSERT INTO appointments (appointment_id, user_id, shop_id, appointment_date, time_slot, service_category, services, remark, product_order_id, order_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      appointmentId,
      userId,
      shop_id,
      appointment_date,
      time_slot,
      cat,
      JSON.stringify(services || []),
      remark || null,
      productOrderId,
      orderId,
    ]
  );

  return { success: true, data: { appointment_id: appointmentId } };
}

module.exports = {
  createAppointment,
};
