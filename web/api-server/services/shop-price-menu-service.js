'use strict';

const crypto = require('crypto');

function newId() {
  return 'spm_' + crypto.randomBytes(12).toString('hex');
}

async function tableExists(pool) {
  const [r] = await pool.execute(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shop_service_price_menu'`
  );
  return r.length > 0;
}

async function listMenu(pool, shopId) {
  if (!(await tableExists(pool))) return { success: true, data: { list: [], table_ready: false } };
  const [rows] = await pool.execute(
    `SELECT menu_row_id, service_name, parts_type, craft_standard, ref_min, ref_max, warranty_note, typical_days, sort_order, is_active
     FROM shop_service_price_menu WHERE shop_id = ? ORDER BY sort_order, id`,
    [shopId]
  );
  return { success: true, data: { list: rows, table_ready: true } };
}

async function addRow(pool, shopId, body) {
  const serviceName = body && body.service_name ? String(body.service_name).trim() : '';
  if (!serviceName) return { success: false, statusCode: 400, error: 'service_name 必填' };
  const partsType = (body && body.parts_type) || 'unspecified';
  const craft = (body && body.craft_standard) || 'standard';
  const refMin = parseFloat(body && body.ref_min);
  const refMax = parseFloat(body && body.ref_max);
  if (Number.isNaN(refMin) || Number.isNaN(refMax) || refMin < 0 || refMax < refMin) {
    return { success: false, statusCode: 400, error: 'ref_min / ref_max 无效' };
  }
  const rowId = newId();
  await pool.execute(
    `INSERT INTO shop_service_price_menu (menu_row_id, shop_id, service_name, parts_type, craft_standard, ref_min, ref_max, warranty_note, typical_days, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      rowId,
      shopId,
      serviceName,
      String(partsType).slice(0, 64),
      String(craft).slice(0, 64),
      refMin,
      refMax,
      body && body.warranty_note != null ? String(body.warranty_note).slice(0, 500) : null,
      body && body.typical_days != null ? parseInt(body.typical_days, 10) || null : null,
      body && body.sort_order != null ? parseInt(body.sort_order, 10) || 0 : 0,
    ]
  );
  return { success: true, data: { menu_row_id: rowId } };
}

async function deleteRow(pool, shopId, menuRowId) {
  const [r] = await pool.execute(`DELETE FROM shop_service_price_menu WHERE menu_row_id = ? AND shop_id = ?`, [menuRowId, shopId]);
  if (r.affectedRows === 0) return { success: false, statusCode: 404, error: '记录不存在' };
  return { success: true, data: { ok: true } };
}

module.exports = { listMenu, addRow, deleteRow, tableExists };
