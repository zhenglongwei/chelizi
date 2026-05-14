'use strict';

const crypto = require('crypto');
const { hasColumn } = require('../utils/db-utils');
const lightCommerce = require('./light-commerce-service');

function newId() {
  return 'led_' + crypto.randomBytes(12).toString('hex');
}

async function tableExists(pool) {
  const [r] = await pool.execute(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shop_appointment_leads'`
  );
  return r.length > 0;
}

async function createLead(pool, shopId, body) {
  if (!(await tableExists(pool))) {
    return { success: false, statusCode: 503, error: 'shop_appointment_leads 表未创建' };
  }
  const phone = body && body.contact_phone ? String(body.contact_phone).trim() : '';
  if (!phone || phone.length < 5) return { success: false, statusCode: 400, error: '请填写联系电话' };
  const leadId = newId();
  await pool.execute(
    `INSERT INTO shop_appointment_leads (lead_id, shop_id, user_id, contact_name, contact_phone, vehicle_plate, vehicle_model, note, source, status)
     VALUES (?,?,?,?,?,?,?,?,?, 'new')`,
    [
      leadId,
      shopId,
      body && body.user_id ? String(body.user_id) : null,
      body && body.contact_name ? String(body.contact_name).slice(0, 64) : null,
      phone.slice(0, 32),
      body && body.vehicle_plate ? String(body.vehicle_plate).slice(0, 32) : null,
      body && body.vehicle_model ? String(body.vehicle_model).slice(0, 128) : null,
      body && body.note ? String(body.note).slice(0, 1000) : null,
      (body && body.source) || 'miniapp',
    ]
  );
  return { success: true, data: { lead_id: leadId } };
}

function leadSelectColumns(pool) {
  const base =
    'lead_id, contact_name, contact_phone, vehicle_plate, vehicle_model, note, source, status, created_at';
  return hasColumn(pool, 'shop_appointment_leads', 'lead_fee_yuan').then((ok) =>
    ok ? base + ', lead_fee_yuan, fee_note' : base
  );
}

async function listLeads(pool, shopId) {
  if (!(await tableExists(pool))) return { success: true, data: { list: [], table_ready: false } };
  const cols = await leadSelectColumns(pool);
  const [rows] = await pool.execute(
    `SELECT ${cols} FROM shop_appointment_leads WHERE shop_id = ? ORDER BY created_at DESC LIMIT 200`,
    [shopId]
  );
  return { success: true, data: { list: rows, table_ready: true } };
}

/**
 * 更新线索状态（F10：done 时可写入平台线索费）
 * @param {{ status: string }} body status ∈ new|confirmed|cancelled|done
 */
async function updateLeadStatus(pool, shopId, leadId, body) {
  if (!(await tableExists(pool))) {
    return { success: false, statusCode: 503, error: 'shop_appointment_leads 表未创建' };
  }
  const id = String(leadId || '').trim();
  if (!id) return { success: false, statusCode: 400, error: 'lead_id 无效' };
  const status = body && body.status ? String(body.status).trim() : '';
  const allowed = ['new', 'confirmed', 'cancelled', 'done'];
  if (!allowed.includes(status)) {
    return { success: false, statusCode: 400, error: 'status 须为 new / confirmed / cancelled / done' };
  }
  const [rows] = await pool.execute(
    `SELECT lead_id, status FROM shop_appointment_leads WHERE lead_id = ? AND shop_id = ? LIMIT 1`,
    [id, shopId]
  );
  if (!rows.length) return { success: false, statusCode: 404, error: '线索不存在' };
  const prev = String(rows[0].status || '').trim();
  if (prev === 'cancelled' && status !== 'cancelled') {
    return { success: false, statusCode: 400, error: '已取消的线索不可再变更' };
  }

  let feeYuan = null;
  let feeNote = null;
  if (status === 'done' && prev !== 'done' && lightCommerce.shouldPersistLeadFeeOnDone()) {
    feeYuan = lightCommerce.getLightCommerceConfig().lead_fee_yuan;
    feeNote = 'F10 线索费（配置 ZHEJIAN_LEAD_FEE_YUAN）'.slice(0, 200);
  }

  const hasFee = await hasColumn(pool, 'shop_appointment_leads', 'lead_fee_yuan');
  if (hasFee && feeYuan != null && feeYuan > 0) {
    await pool.execute(
      `UPDATE shop_appointment_leads SET status = ?, lead_fee_yuan = ?, fee_note = ?, updated_at = CURRENT_TIMESTAMP WHERE lead_id = ? AND shop_id = ?`,
      [status, feeYuan, feeNote, id, shopId]
    );
  } else {
    await pool.execute(
      `UPDATE shop_appointment_leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE lead_id = ? AND shop_id = ?`,
      [status, id, shopId]
    );
  }
  return { success: true, data: { lead_id: id, status, lead_fee_yuan: feeYuan } };
}

module.exports = { createLead, listLeads, tableExists, updateLeadStatus };
