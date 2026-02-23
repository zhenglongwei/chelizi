/**
 * 预约服务
 */

const VALID_CATEGORIES = ['maintenance', 'wash', 'repair', 'other'];

/**
 * 提交预约
 * @param {object} pool - 数据库连接池
 * @param {string} userId - 用户ID
 * @param {object} body - { shop_id, appointment_date, time_slot, service_category, services, remark }
 * @returns {Promise<{ success: boolean, data?: { appointment_id }, error?: string, statusCode?: number }>}
 */
async function createAppointment(pool, userId, body) {
  const { shop_id, appointment_date, time_slot, service_category, services, remark } = body || {};

  if (!shop_id || !appointment_date || !time_slot) {
    return { success: false, error: '预约信息不完整', statusCode: 400 };
  }

  const [shops] = await pool.execute('SELECT shop_id FROM shops WHERE shop_id = ? AND status = 1', [shop_id]);
  if (shops.length === 0) {
    return { success: false, error: '维修厂不存在', statusCode: 404 };
  }

  const cat = VALID_CATEGORIES.includes(service_category) ? service_category : 'other';
  const appointmentId = 'APT' + Date.now();

  await pool.execute(
    `INSERT INTO appointments (appointment_id, user_id, shop_id, appointment_date, time_slot, service_category, services, remark, status) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [appointmentId, userId, shop_id, appointment_date, time_slot, cat, JSON.stringify(services || []), remark || null]
  );

  return { success: true, data: { appointment_id: appointmentId } };
}

module.exports = {
  createAppointment,
};
