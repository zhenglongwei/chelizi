/**
 * 电子质保凭证（服务商出具 + 辙见存证）：分项质保来自锁价后 repair_plan；正式存证仅在车主确认完成（status>=3）后写入且不可变。
 * status=2：仅卡面样式预览，无分项内容、无防伪码。
 */

const crypto = require('crypto');
const { hasColumn } = require('../utils/db-utils');

const CARD_TEMPLATES = [
  { id: 1, name: '经典金', theme: 'gold', theme_label: '金色' },
  { id: 2, name: '极简白', theme: 'light', theme_label: '浅色' },
  { id: 3, name: '商务蓝', theme: 'blue', theme_label: '蓝色' },
  { id: 4, name: '建档米', theme: 'archive', theme_label: '建档纸' },
  { id: 5, name: '辙痕蓝', theme: 'track', theme_label: '辙痕' },
  { id: 6, name: '墨线白', theme: 'ink', theme_label: '墨线' }
];

function listTemplates() {
  return CARD_TEMPLATES;
}

function normalizeTemplateId(n) {
  const x = parseInt(n, 10);
  if (x >= 1 && x <= CARD_TEMPLATES.length) return x;
  return 1;
}

function normalizeAntiFakeInput(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function planItemsFromOrderRow(order) {
  let rp = order.repair_plan;
  if (typeof rp === 'string') {
    try {
      rp = JSON.parse(rp);
    } catch (_) {
      rp = null;
    }
  }
  if (rp && Array.isArray(rp.items) && rp.items.length) return rp.items;
  return [];
}

function buildItemsSnapshot(items) {
  return items.map((it) => ({
    damage_part: String(it.damage_part || it.name || it.item || '项目').trim() || '项目',
    repair_type: String(it.repair_type || '维修').trim() || '维修',
    parts_type: it.repair_type === '换' ? String(it.parts_type || '').trim() : '',
    price: it.price != null && !Number.isNaN(Number(it.price)) ? Number(it.price) : null,
    warranty_months:
      it.warranty_months != null && !Number.isNaN(parseInt(it.warranty_months, 10))
        ? parseInt(it.warranty_months, 10)
        : null
  }));
}

function stableHash(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

function parseJsonCol(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch (_) {
    return null;
  }
}

async function loadVehicleInfo(pool, biddingId) {
  if (!biddingId) return {};
  const [b] = await pool.execute('SELECT vehicle_info FROM biddings WHERE bidding_id = ?', [biddingId]);
  if (!b.length || !b[0].vehicle_info) return {};
  try {
    return typeof b[0].vehicle_info === 'string' ? JSON.parse(b[0].vehicle_info || '{}') : b[0].vehicle_info || {};
  } catch (_) {
    return {};
  }
}

function vehicleSummaryFromInfo(vehicleInfo) {
  return [vehicleInfo.brand, vehicleInfo.model, vehicleInfo.plate_number]
    .map((x) => (x != null ? String(x).trim() : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
}

/**
 * 正式卡快照 → API 响应（只读，不合并 live repair_plan）
 */
function storedSnapshotToResponse(stored, orderId) {
  const templateId = normalizeTemplateId(stored.template_id);
  const templateMeta = CARD_TEMPLATES.find((t) => t.id === templateId) || CARD_TEMPLATES[0];
  const items = stored.items_snapshot || stored.items || [];
  const contentHash = stored.content_hash || '';
  return {
    version: stored.version || 1,
    order_id: orderId,
    shop_id: stored.shop_id,
    shop_name: stored.shop_name || '',
    shop_logo: stored.shop_logo != null ? stored.shop_logo : null,
    template_id: templateId,
    template: templateMeta,
    templates: CARD_TEMPLATES,
    vehicle_summary: stored.vehicle_summary || '—',
    warranty_start_rule: stored.warranty_start_rule || '分项质保期自车主确认维修完成之日起计算',
    warranty_start_at: stored.warranty_start_at || null,
    pending_owner_confirm: false,
    items,
    disclaimer:
      stored.disclaimer ||
      '分项质保由本单维修厂向您作出，以订单已确认的锁价方案为准。辙见仅提供本凭证的展示与防篡改存证，便于保存与核验，不构成对维修质量的额外担保。商户可另传纸质凭证照片作为补充。',
    generated_at: stored.generated_at || null,
    content_hash: contentHash,
    anti_fake_code: contentHash,
    card_phase: 'official',
    share_hint: stored.share_hint || '建议截图保存；可在「我的—质保卡核验」核对与订单存证是否一致'
  };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} orderId
 * @param {{ userId?: string, shopId?: string }} auth
 */
async function getWarrantyCard(pool, orderId, auth = {}) {
  const { userId, shopId } = auth;
  const [rows] = await pool.execute(
    `SELECT o.*, s.name AS shop_name, s.logo AS shop_logo, s.warranty_card_template_id AS shop_warranty_template_id
     FROM orders o
     LEFT JOIN shops s ON o.shop_id = s.shop_id
     WHERE o.order_id = ?`,
    [orderId]
  );
  if (!rows.length) return { ok: false, statusCode: 404, error: '订单不存在' };
  const order = rows[0];
  if (userId && order.user_id !== userId) return { ok: false, statusCode: 403, error: '无权查看' };
  if (shopId && order.shop_id !== shopId) return { ok: false, statusCode: 403, error: '无权查看' };

  const st = parseInt(order.status, 10);
  if (st < 2) {
    return { ok: false, statusCode: 400, error: '订单尚未提交完工凭证，暂无电子质保凭证' };
  }

  const orderTpl =
    order.warranty_card_template_id != null && order.warranty_card_template_id !== ''
      ? parseInt(order.warranty_card_template_id, 10)
      : null;
  const shopTpl =
    order.shop_warranty_template_id != null && order.shop_warranty_template_id !== ''
      ? parseInt(order.shop_warranty_template_id, 10)
      : null;
  const templateId = normalizeTemplateId(orderTpl != null && !Number.isNaN(orderTpl) ? orderTpl : shopTpl);
  const templateMeta = CARD_TEMPLATES.find((t) => t.id === templateId) || CARD_TEMPLATES[0];

  const vehicleInfo = await loadVehicleInfo(pool, order.bidding_id);
  const vehicleSummary = vehicleSummaryFromInfo(vehicleInfo) || '—';

  /** 待车主确认：仅样式预览，不含分项与防伪码 */
  if (st === 2) {
    return {
      ok: true,
      data: {
        version: 1,
        order_id: order.order_id,
        shop_id: order.shop_id,
        shop_name: order.shop_name || '',
        shop_logo: order.shop_logo || null,
        template_id: templateId,
        template: templateMeta,
        templates: CARD_TEMPLATES,
        vehicle_summary: vehicleSummary,
        warranty_start_rule: '分项质保期自车主确认维修完成之日起计算',
        warranty_start_at: null,
        pending_owner_confirm: true,
        preview_message:
          '分项质保由维修厂向您作出，以本单锁价方案为准。正式电子凭证与存证防伪码将在车主确认维修完成后，由辙见根据已确认方案固化存证。当前仅展示卡面样式，不具有凭证效力。',
        items: [],
        disclaimer:
          '预览仅供参考。正式凭证以您确认完工后辙见固化的存证为准；质保履行请联系接单维修厂。',
        generated_at: null,
        content_hash: null,
        anti_fake_code: null,
        card_phase: 'style_preview',
        share_hint: null
      }
    };
  }

  const hasCardCol = await hasColumn(pool, 'orders', 'platform_warranty_card');
  let existing = hasCardCol ? parseJsonCol(order.platform_warranty_card) : null;

  if (existing && existing.content_hash) {
    return { ok: true, data: storedSnapshotToResponse(existing, orderId) };
  }

  /** 首次生成正式卡（仅 status>=3 且库中尚无快照） */
  const rawItems = planItemsFromOrderRow(order);
  const items = buildItemsSnapshot(rawItems);
  let warrantyStartAt = null;
  if (order.completed_at) {
    try {
      warrantyStartAt = new Date(order.completed_at).toISOString();
    } catch (_) {}
  }

  const hashInput = {
    order_id: orderId,
    template_id: templateId,
    items,
    warranty_start_at: warrantyStartAt
  };
  const contentHash = stableHash(hashInput);

  const data = {
    version: 1,
    order_id: order.order_id,
    shop_id: order.shop_id,
    shop_name: order.shop_name || '',
    shop_logo: order.shop_logo || null,
    template_id: templateId,
    template: templateMeta,
    templates: CARD_TEMPLATES,
    vehicle_summary: vehicleSummary,
    warranty_start_rule: '分项质保期自车主确认维修完成之日起计算',
    warranty_start_at: warrantyStartAt,
    pending_owner_confirm: false,
    items,
    disclaimer:
      '分项质保由本单维修厂向您作出，以订单已确认的锁价方案为准。辙见仅提供本凭证的展示与防篡改存证，便于保存与核验，不构成对维修质量的额外担保。商户可另传纸质凭证照片作为补充。',
    generated_at: new Date().toISOString(),
    content_hash: contentHash,
    anti_fake_code: contentHash,
    card_phase: 'official',
    share_hint: '建议截图保存；可在「我的—质保卡核验」输入订单号与存证防伪码，核对与订单存证是否一致'
  };

  if (hasCardCol) {
    const toStore = { ...data, items_snapshot: items };
    delete toStore.templates;
    const jsonStr = JSON.stringify(toStore);
    try {
      const [upd] = await pool.execute(
        'UPDATE orders SET platform_warranty_card = ? WHERE order_id = ? AND platform_warranty_card IS NULL',
        [jsonStr, orderId]
      );
      if (upd.affectedRows === 0) {
        const [again] = await pool.execute(
          'SELECT platform_warranty_card FROM orders WHERE order_id = ?',
          [orderId]
        );
        const snap = again.length ? parseJsonCol(again[0].platform_warranty_card) : null;
        if (snap && snap.content_hash) {
          return { ok: true, data: storedSnapshotToResponse(snap, orderId) };
        }
      }
    } catch (e) {
      console.warn('[order-warranty-card] persist snapshot failed:', e.message);
    }
  }

  return { ok: true, data };
}

/**
 * 公开核验：订单号 + 防伪码（与快照 content_hash 一致）
 */
async function verifyAntiFakeCode(pool, orderIdRaw, codeRaw) {
  const orderId = String(orderIdRaw || '').trim();
  const code = normalizeAntiFakeInput(codeRaw);
  if (!orderId || !code) {
    return { ok: false, error: '请输入订单号与防伪码' };
  }

  const [rows] = await pool.execute(
    'SELECT order_id, status, platform_warranty_card FROM orders WHERE order_id = ? LIMIT 1',
    [orderId]
  );
  if (!rows.length) return { ok: false, error: '未找到该订单' };

  const st = parseInt(rows[0].status, 10);
  if (st < 3) {
    return { ok: false, error: '该订单尚未生成正式电子质保凭证（需车主确认维修完成后）' };
  }

  const snap = parseJsonCol(rows[0].platform_warranty_card);
  const expected = snap && snap.content_hash ? normalizeAntiFakeInput(snap.content_hash) : '';
  if (!expected) {
    return { ok: false, error: '暂无该订单存证记录，请稍后再试或联系客服' };
  }
  if (code !== expected) {
    return { ok: false, error: '防伪码与订单存证不一致，请核对卡面或订单号' };
  }

  return {
    ok: true,
    data: {
      valid: true,
      order_id: orderId,
      shop_name: snap.shop_name || '',
      vehicle_summary: snap.vehicle_summary || '',
      generated_at: snap.generated_at || null
    }
  };
}

module.exports = {
  listTemplates,
  normalizeTemplateId,
  getWarrantyCard,
  verifyAntiFakeCode,
  CARD_TEMPLATES
};
