/**
 * 维修关键节点：商户写入、车主时间线；通知见 createMilestone
 */

const crypto = require('crypto');
const { hasColumn } = require('../utils/db-utils');
const { isValidMilestoneCode, getMilestoneLabel } = require('../constants/repair-milestones');

/** 零配件验真节点：仅用 photo_urls，张数上限 */
const MAX_PARTS_VERIFY_PHOTOS = 8;

async function milestonesTableExists(pool) {
  try {
    const [r] = await pool.execute(
      `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_repair_milestones'`
    );
    return r.length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * 数据库存/接口下发的图片地址，用于展示时统一为可用 URL。
 * 协议相对地址 `//` 在旧逻辑里被 `startsWith('http')` 误过滤，导致有「附图 N 张」但无缩略图。
 */
function normalizeDisplayImageUrl(u) {
  if (typeof u !== 'string') return null;
  const s = u.trim();
  if (!s) return null;
  if (s.startsWith('https://') || s.startsWith('http://')) return s;
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('cloud://')) return s;
  return null;
}

function normalizePhotoUrls(body) {
  const raw = body && body.photo_urls != null ? body.photo_urls : body && body.photos;
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .map((u) => normalizeDisplayImageUrl(u))
    .filter(Boolean);
}

function normalizePartsPhotoUrls(body) {
  const raw = body && body.parts_photo_urls != null ? body.parts_photo_urls : body && body.parts_photos;
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .map((u) => normalizeDisplayImageUrl(u))
    .filter(Boolean);
}

function parseUrlArray(val) {
  let out = [];
  try {
    if (Array.isArray(val)) out = val;
    else if (typeof val === 'string') out = JSON.parse(val || '[]');
  } catch (_) {
    out = [];
  }
  return out
    .map((u) => (typeof u === 'string' ? normalizeDisplayImageUrl(u.trim()) : null))
    .filter(Boolean);
}

function formatRow(row) {
  const photoUrls = parseUrlArray(row.photo_urls);
  const partsPhotoUrls = row.parts_photo_urls != null ? parseUrlArray(row.parts_photo_urls) : [];
  return {
    milestone_id: row.milestone_id,
    milestone_code: row.milestone_code,
    milestone_label: getMilestoneLabel(row.milestone_code),
    photo_urls: photoUrls,
    parts_photo_urls: partsPhotoUrls,
    parts_verify_note: row.parts_verify_note != null ? String(row.parts_verify_note) : '',
    note: row.note || '',
    created_at: row.created_at,
  };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} orderId
 */
async function listForOrder(pool, orderId) {
  if (!(await milestonesTableExists(pool))) return [];
  const hasParts = await hasColumn(pool, 'order_repair_milestones', 'parts_photo_urls');
  const cols = hasParts
    ? 'milestone_id, order_id, shop_id, milestone_code, photo_urls, parts_photo_urls, note, parts_verify_note, created_at'
    : 'milestone_id, order_id, shop_id, milestone_code, photo_urls, note, created_at';
  const [rows] = await pool.execute(
    `SELECT ${cols} FROM order_repair_milestones WHERE order_id = ? ORDER BY created_at ASC, milestone_id ASC`,
    [orderId]
  );
  return rows.map((r) => {
    if (!hasParts) return formatRow({ ...r, parts_photo_urls: null, parts_verify_note: null });
    return formatRow(r);
  });
}

/**
 * @param {string} merchantId - JWT merchantId，可空
 */
async function createMilestone(pool, orderId, shopId, body, merchantId) {
  if (!(await milestonesTableExists(pool))) {
    return { success: false, error: '当前环境未启用维修进展功能', statusCode: 503 };
  }
  const code = body && typeof body.milestone_code === 'string' ? body.milestone_code.trim() : '';
  if (!isValidMilestoneCode(code)) {
    return { success: false, error: '无效的进展节点类型', statusCode: 400 };
  }
  const hasParts = await hasColumn(pool, 'order_repair_milestones', 'parts_photo_urls');

  const bodyPartsUrls = normalizePartsPhotoUrls(body);
  if (bodyPartsUrls.length > 0) {
    if (code === 'during_process') {
      return {
        success: false,
        error: '零配件与验真请使用「零配件验真」节点单独上传，不再挂在维修过程节点下',
        statusCode: 400,
      };
    }
    if (code === 'parts_verify_process') {
      return {
        success: false,
        error: '零配件验真节点请使用 photo_urls 传图，勿再传 parts_photo_urls',
        statusCode: 400,
      };
    }
    return { success: false, error: '请勿使用已废弃的 parts_photo_urls 字段', statusCode: 400 };
  }

  const photoUrls = normalizePhotoUrls(body);
  let partsUrls = [];

  if (code === 'parts_verify_process') {
    if (photoUrls.length < 1) {
      return { success: false, error: '零配件验真请至少上传 1 张照片', statusCode: 400 };
    }
    if (photoUrls.length > MAX_PARTS_VERIFY_PHOTOS) {
      return { success: false, error: `零配件验真单次最多 ${MAX_PARTS_VERIFY_PHOTOS} 张`, statusCode: 400 };
    }
  } else {
    if (photoUrls.length < 1) {
      return { success: false, error: '请至少上传 1 张照片', statusCode: 400 };
    }
    if (photoUrls.length > 12) {
      return { success: false, error: '过程照片单次最多 12 张', statusCode: 400 };
    }
  }

  let note = body && body.note != null ? String(body.note).trim() : '';
  if (note.length > 200) note = note.slice(0, 200);

  let partsVerifyNote = '';
  if (hasParts && code === 'parts_verify_process' && body && body.parts_verify_note != null) {
    partsVerifyNote = String(body.parts_verify_note).trim();
    if (partsVerifyNote.length > 500) partsVerifyNote = partsVerifyNote.slice(0, 500);
  }

  const [orders] = await pool.execute(
    'SELECT order_id, user_id, shop_id, status FROM orders WHERE order_id = ?',
    [orderId]
  );
  if (orders.length === 0) {
    return { success: false, error: '订单不存在', statusCode: 404 };
  }
  const o = orders[0];
  if (String(o.shop_id) !== String(shopId)) {
    return { success: false, error: '无权操作该订单', statusCode: 403 };
  }
  if (parseInt(o.status, 10) !== 1) {
    return { success: false, error: '仅维修中订单可记录进展', statusCode: 400 };
  }

  const milestoneId = 'mrms_' + crypto.randomBytes(12).toString('hex');
  const photosJson = JSON.stringify(photoUrls);
  const partsJson = null;
  const mid = merchantId != null && merchantId !== '' ? String(merchantId) : null;

  if (hasParts) {
    await pool.execute(
      `INSERT INTO order_repair_milestones (milestone_id, order_id, shop_id, milestone_code, photo_urls, parts_photo_urls, note, parts_verify_note, created_by_merchant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [milestoneId, orderId, shopId, code, photosJson, partsJson, note || null, partsVerifyNote || null, mid]
    );
  } else {
    await pool.execute(
      `INSERT INTO order_repair_milestones (milestone_id, order_id, shop_id, milestone_code, photo_urls, note, created_by_merchant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [milestoneId, orderId, shopId, code, photosJson, note || null, mid]
    );
  }

  const label = getMilestoneLabel(code);
  const hasUserMessages = await hasColumn(pool, 'user_messages', 'message_id');
  if (hasUserMessages && o.user_id) {
    try {
      const msgId = 'umsg_' + crypto.randomBytes(12).toString('hex');
      const photoPart =
        code === 'parts_verify_process'
          ? `零配件${photoUrls.length}张`
          : `过程${photoUrls.length}张`;
      let contentBase = `${label}，${photoPart}${note ? '。' + note : '。'}`;
      if (partsVerifyNote) {
        contentBase += `验真：${partsVerifyNote}`;
      }
      const content = contentBase.length > 500 ? contentBase.slice(0, 497) + '…' : contentBase;
      await pool.execute(
        `INSERT INTO user_messages (message_id, user_id, type, title, content, related_id, is_read)
         VALUES (?, ?, 'order', '维修新进展', ?, ?, 0)`,
        [msgId, o.user_id, content, orderId]
      );
    } catch (msgErr) {
      console.warn('[repair-milestone] user_messages:', msgErr && msgErr.message);
    }
  }

  try {
    const subMsg = require('./subscribe-message-service');
    const n = photoUrls.length;
    const subTitle = '维修进展';
    const subContent = `${label} ${n}张`.slice(0, 20);
    subMsg
      .sendToUser(
        pool,
        o.user_id,
        'user_order_update',
        { title: subTitle, content: subContent, relatedId: orderId, anchor: 'milestones' },
        process.env.WX_APPID,
        process.env.WX_SECRET
      )
      .catch(() => {});
  } catch (e) {
    console.warn('[repair-milestone] subscribe:', e && e.message);
  }

  const selCols = hasParts
    ? 'milestone_id, milestone_code, photo_urls, parts_photo_urls, note, parts_verify_note, created_at'
    : 'milestone_id, milestone_code, photo_urls, note, created_at';
  const [inserted] = await pool.execute(
    `SELECT ${selCols} FROM order_repair_milestones WHERE milestone_id = ?`,
    [milestoneId]
  );
  const row = inserted[0];
  return {
    success: true,
    data: formatRow(hasParts ? row : { ...row, parts_photo_urls: null, parts_verify_note: null }),
  };
}

module.exports = {
  milestonesTableExists,
  listForOrder,
  createMilestone,
};
