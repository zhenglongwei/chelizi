/**
 * 到店报价多轮：每轮须证明材料，车主确认；评价页公示全历史
 */

const { getShopNthQuoteLabel, getShopRoundStageCode } = require('../utils/quote-nomenclature');

async function proposalsTableExists(pool) {
  try {
    const [r] = await pool.execute(
      `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_quote_proposals'`
    );
    return r.length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * @returns {{ ok: boolean, error?: string, evidence?: object }}
 */
function normalizeEvidence(body, isIns) {
  const raw = body.evidence && typeof body.evidence === 'object' ? body.evidence : {};
  let photos = Array.isArray(raw.photo_urls) ? raw.photo_urls : [];
  photos = photos.filter((u) => typeof u === 'string' && u.trim().startsWith('http'));

  const ev = { ...raw, photo_urls: photos };

  if (isIns) {
    let loss = raw.loss_assessment_documents || body.loss_assessment_documents;
    const urls = Array.isArray(loss) ? loss : loss && loss.urls;
    if (!Array.isArray(urls) || urls.length < 1) {
      return { ok: false, error: '保险事故车须上传定损单照片（作为本轮证明材料）' };
    }
    const cleanUrls = urls.filter((u) => typeof u === 'string' && u.trim().startsWith('http'));
    if (cleanUrls.length < 1) {
      return { ok: false, error: '定损单须为有效图片地址' };
    }
    ev.loss_assessment_documents =
      loss && typeof loss === 'object' && !Array.isArray(loss) ? { ...loss, urls: cleanUrls } : { urls: cleanUrls };
    if (photos.length < 1) {
      ev.photo_urls = cleanUrls.slice();
    }
  } else {
    if (photos.length < 1) {
      return { ok: false, error: '请上传至少 1 张报价证明材料（如环车、拆解部位、检测记录等）' };
    }
  }

  const sup = String(body.supplement_note || raw.supplement_note || '').trim();
  if (sup) ev.supplement_note = sup;

  return { ok: true, evidence: ev };
}

async function getNextRevisionNo(pool, orderId) {
  const [[row]] = await pool.execute(
    'SELECT COALESCE(MAX(revision_no), 0) AS m FROM order_quote_proposals WHERE order_id = ?',
    [orderId]
  );
  const m = row && row.m != null ? parseInt(row.m, 10) : 0;
  return (Number.isNaN(m) ? 0 : m) + 1;
}

async function getPending(pool, orderId) {
  const [rows] = await pool.execute(
    'SELECT * FROM order_quote_proposals WHERE order_id = ? AND status = 0 ORDER BY revision_no DESC LIMIT 1',
    [orderId]
  );
  return rows[0] || null;
}

async function getLastConfirmed(pool, orderId) {
  const [rows] = await pool.execute(
    'SELECT * FROM order_quote_proposals WHERE order_id = ? AND status = 1 ORDER BY revision_no DESC LIMIT 1',
    [orderId]
  );
  return rows[0] || null;
}

function parseJson(v, fallback = null) {
  if (v == null || v === '') return fallback;
  try {
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch (_) {
    return fallback;
  }
}

const STATUS_TEXT = { 0: '待车主确认', 1: '车主已确认', 2: '车主已拒绝' };

async function listFormatted(pool, orderId) {
  const [rows] = await pool.execute(
    `SELECT proposal_id, revision_no, quote_snapshot, evidence, status, submitted_at, resolved_at
     FROM order_quote_proposals WHERE order_id = ? ORDER BY revision_no ASC`,
    [orderId]
  );
  return (rows || []).map((r) => ({
    proposal_id: r.proposal_id,
    revision_no: r.revision_no,
    /** 产品展示名：revision_no=1 → 二次报价（到店后），与小程序 utils/quote-nomenclature 一致 */
    display_round_label: getShopNthQuoteLabel(r.revision_no),
    quote_stage_code: getShopRoundStageCode(r.revision_no),
    quote_snapshot: parseJson(r.quote_snapshot),
    evidence: parseJson(r.evidence),
    status: r.status,
    status_text: STATUS_TEXT[r.status] || '',
    submitted_at: r.submitted_at,
    resolved_at: r.resolved_at,
  }));
}

module.exports = {
  proposalsTableExists,
  normalizeEvidence,
  getNextRevisionNo,
  getPending,
  getLastConfirmed,
  listFormatted,
  parseJson,
  STATUS_TEXT,
};
