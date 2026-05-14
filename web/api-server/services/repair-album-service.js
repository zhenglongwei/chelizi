'use strict';

const crypto = require('crypto');

const NODE_CODES = ['pre_teardown', 'teardown', 'parts', 'in_progress', 'completion'];
const BASE_URL = process.env.PUBLIC_SITE_BASE || 'https://simplewin.cn';

function newId(prefix) {
  return prefix + crypto.randomBytes(12).toString('hex');
}

function newSlug() {
  return crypto.randomBytes(9).toString('base64url').replace(/=/g, '').slice(0, 12);
}

async function albumsTableExists(pool) {
  try {
    const [r] = await pool.execute(
      `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'repair_albums'`
    );
    return r.length > 0;
  } catch (_) {
    return false;
  }
}

async function ensureDefaultNodes(pool, albumId) {
  let i = 0;
  for (const code of NODE_CODES) {
    await pool.execute(
      `INSERT IGNORE INTO repair_album_nodes (album_id, node_code, sort_order) VALUES (?, ?, ?)`,
      [albumId, code, i++]
    );
  }
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} shopId
 * @param {{ template_type?: string, order_id?: string|null }} body
 */
async function createAlbum(pool, shopId, body) {
  if (!(await albumsTableExists(pool))) {
    return { success: false, statusCode: 503, error: 'repair_albums 表未创建，请先执行数据库迁移' };
  }
  const templateType = (body && body.template_type) || 'accident_default';
  const orderId = body && body.order_id != null && String(body.order_id).trim() !== '' ? String(body.order_id).trim() : null;
  const albumId = newId('alb_');

  await pool.execute(
    `INSERT INTO repair_albums (album_id, shop_id, order_id, template_type, status) VALUES (?,?,?,?, 'draft')`,
    [albumId, shopId, orderId, templateType]
  );
  await ensureDefaultNodes(pool, albumId);
  return { success: true, data: { album_id: albumId } };
}

async function listAlbums(pool, shopId, query) {
  if (!(await albumsTableExists(pool))) {
    return { success: true, data: { list: [], table_ready: false } };
  }
  const status = query && query.status ? String(query.status) : null;
  let sql = `SELECT album_id, order_id, template_type, status, public_case_slug, created_at, updated_at FROM repair_albums WHERE shop_id = ?`;
  const args = [shopId];
  if (status) {
    sql += ` AND status = ?`;
    args.push(status);
  }
  sql += ` ORDER BY updated_at DESC LIMIT 200`;
  const [rows] = await pool.execute(sql, args);
  return { success: true, data: { list: rows, table_ready: true } };
}

async function getAlbumDetail(pool, shopId, albumId) {
  if (!(await albumsTableExists(pool))) {
    return { success: false, statusCode: 503, error: '相册表未就绪' };
  }
  const [a] = await pool.execute(
    `SELECT album_id, shop_id, order_id, template_type, status, public_case_slug, watermark_meta, created_at, updated_at
     FROM repair_albums WHERE album_id = ? AND shop_id = ?`,
    [albumId, shopId]
  );
  if (a.length === 0) return { success: false, statusCode: 404, error: '相册不存在' };
  const [nodes] = await pool.execute(
    `SELECT node_code, sort_order, note FROM repair_album_nodes WHERE album_id = ? ORDER BY sort_order, node_code`,
    [albumId]
  );
  const [media] = await pool.execute(
    `SELECT media_id, node_code, url, sort_order, qc_status, created_at FROM repair_album_media WHERE album_id = ? ORDER BY node_code, sort_order, id`,
    [albumId]
  );
  const [pub] = await pool.execute(
    `SELECT publication_id, review_status, published_url, created_at, updated_at FROM repair_case_publications WHERE album_id = ? LIMIT 1`,
    [albumId]
  );
  return {
    success: true,
    data: {
      album: a[0],
      nodes,
      media,
      publication: pub[0] || null,
    },
  };
}

async function patchAlbum(pool, shopId, albumId, body) {
  const fields = [];
  const vals = [];
  if (body && body.order_id !== undefined) {
    const v = body.order_id == null || body.order_id === '' ? null : String(body.order_id).trim();
    fields.push('order_id = ?');
    vals.push(v);
  }
  if (body && body.status) {
    fields.push('status = ?');
    vals.push(String(body.status));
  }
  if (fields.length === 0) return { success: false, statusCode: 400, error: '无更新字段' };
  vals.push(albumId, shopId);
  const [r] = await pool.execute(
    `UPDATE repair_albums SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE album_id = ? AND shop_id = ?`,
    vals
  );
  if (r.affectedRows === 0) return { success: false, statusCode: 404, error: '相册不存在' };
  return { success: true, data: { ok: true } };
}

async function updateNodeNote(pool, shopId, albumId, nodeCode, note) {
  const [r] = await pool.execute(
    `UPDATE repair_album_nodes n
     JOIN repair_albums a ON n.album_id = a.album_id
     SET n.note = ?, n.updated_at = CURRENT_TIMESTAMP
     WHERE n.album_id = ? AND n.node_code = ? AND a.shop_id = ?`,
    [note == null ? '' : String(note).slice(0, 2000), albumId, nodeCode, shopId]
  );
  if (r.affectedRows === 0) return { success: false, statusCode: 404, error: '节点不存在' };
  return { success: true, data: { ok: true } };
}

async function addMedia(pool, shopId, albumId, payload) {
  const nodeCode = payload && payload.node_code ? String(payload.node_code) : '';
  const url = payload && payload.url ? String(payload.url).trim() : '';
  if (!NODE_CODES.includes(nodeCode)) return { success: false, statusCode: 400, error: 'node_code 无效' };
  if (!url || url.length > 1024) return { success: false, statusCode: 400, error: 'url 无效' };
  const mediaId = newId('med_');
  const sortOrder = payload && payload.sort_order != null ? parseInt(payload.sort_order, 10) || 0 : 0;
  await pool.execute(
    `INSERT INTO repair_album_media (media_id, album_id, node_code, url, sort_order) VALUES (?,?,?,?,?)`,
    [mediaId, albumId, nodeCode, url, sortOrder]
  );
  await pool.execute(`UPDATE repair_albums SET status = IF(status='draft','active',status), updated_at = CURRENT_TIMESTAMP WHERE album_id = ? AND shop_id = ?`, [
    albumId,
    shopId,
  ]);
  return { success: true, data: { media_id: mediaId } };
}

async function deleteMedia(pool, shopId, albumId, mediaId) {
  const [r] = await pool.execute(
    `DELETE m FROM repair_album_media m
     JOIN repair_albums a ON m.album_id = a.album_id
     WHERE m.media_id = ? AND m.album_id = ? AND a.shop_id = ?`,
    [mediaId, albumId, shopId]
  );
  if (r.affectedRows === 0) return { success: false, statusCode: 404, error: '媒体不存在' };
  return { success: true, data: { ok: true } };
}

async function submitPublish(pool, shopId, albumId, body) {
  const snap = body && body.desensitized_snapshot != null ? body.desensitized_snapshot : {};
  const [a] = await pool.execute(`SELECT album_id, status FROM repair_albums WHERE album_id = ? AND shop_id = ?`, [albumId, shopId]);
  if (a.length === 0) return { success: false, statusCode: 404, error: '相册不存在' };

  const [existing] = await pool.execute(`SELECT publication_id FROM repair_case_publications WHERE album_id = ? LIMIT 1`, [albumId]);
  if (existing.length > 0) {
    await pool.execute(
      `UPDATE repair_case_publications SET desensitized_snapshot = ?, review_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE album_id = ?`,
      [JSON.stringify(snap), albumId]
    );
  } else {
    const pubId = newId('rcp_');
    await pool.execute(
      `INSERT INTO repair_case_publications (publication_id, album_id, desensitized_snapshot, review_status) VALUES (?,?,?, 'pending')`,
      [pubId, albumId, JSON.stringify(snap)]
    );
  }
  await pool.execute(`UPDATE repair_albums SET status = 'pending_review', updated_at = CURRENT_TIMESTAMP WHERE album_id = ?`, [albumId]);
  return { success: true, data: { review_status: 'pending' } };
}

/**
 * 审核通过并生成公网 slug（MVP：商家自审，生产环境建议改为运营后台审核）
 */
async function approvePublication(pool, shopId, albumId, opts) {
  const selfPublish =
    process.env.MERCHANT_SELF_PUBLISH_CASE === '1' || String(process.env.MERCHANT_SELF_PUBLISH_CASE || '').toLowerCase() === 'true';
  const allowSelf = selfPublish || process.env.NODE_ENV !== 'production';
  if (!allowSelf) {
    return { success: false, statusCode: 403, error: '公网发布需运营审核（生产环境请设置 MERCHANT_SELF_PUBLISH_CASE=1 或接入审核后台）' };
  }
  const [a] = await pool.execute(`SELECT album_id, status, public_case_slug FROM repair_albums WHERE album_id = ? AND shop_id = ?`, [albumId, shopId]);
  if (a.length === 0) return { success: false, statusCode: 404, error: '相册不存在' };

  let slug = a[0].public_case_slug;
  if (!slug) {
    for (let i = 0; i < 5; i++) {
      const candidate = newSlug();
      try {
        await pool.execute(`UPDATE repair_albums SET public_case_slug = ? WHERE album_id = ? AND public_case_slug IS NULL`, [candidate, albumId]);
        slug = candidate;
        break;
      } catch (e) {
        if (e && e.code !== 'ER_DUP_ENTRY') throw e;
      }
    }
    if (!slug) return { success: false, statusCode: 500, error: '生成 slug 失败' };
  }

  const publishedUrl = `${BASE_URL}/zhejian/case/${slug}`;
  await pool.execute(
    `UPDATE repair_case_publications SET review_status = 'approved', published_url = ?, reviewed_by = ?, updated_at = CURRENT_TIMESTAMP WHERE album_id = ?`,
    [publishedUrl, opts && opts.reviewer ? String(opts.reviewer) : 'merchant_self', albumId]
  );
  await pool.execute(`UPDATE repair_albums SET status = 'published', updated_at = CURRENT_TIMESTAMP WHERE album_id = ?`, [albumId]);

  return { success: true, data: { public_case_slug: slug, published_url: publishedUrl } };
}

async function getPublicCaseBySlug(pool, slug) {
  const [rows] = await pool.execute(
    `SELECT a.album_id, a.shop_id, a.public_case_slug, a.template_type, a.status,
            p.desensitized_snapshot, p.published_url, p.review_status,
            s.name AS shop_name, s.city, s.address
     FROM repair_albums a
     JOIN repair_case_publications p ON p.album_id = a.album_id
     JOIN shops s ON s.shop_id = a.shop_id
     WHERE a.public_case_slug = ? AND p.review_status = 'approved' AND a.status = 'published'`,
    [slug]
  );
  if (rows.length === 0) return { success: false, statusCode: 404, error: '案例未发布或不存在' };
  return { success: true, data: rows[0] };
}

/**
 * 已发布公网案例摘要（AI 定损「相似案例」用；不足条数时按时间补足）
 * @param {{ brand?: string, model?: string, limit?: number }} opts
 */
async function listSimilarPublishedCases(pool, opts) {
  const limit = Math.min(10, Math.max(1, parseInt((opts && opts.limit) || 3, 10) || 3));
  const brand = opts && opts.brand ? String(opts.brand).trim() : '';
  const model = opts && opts.model ? String(opts.model).trim() : '';
  if (!(await albumsTableExists(pool))) return [];
  const [rows] = await pool.execute(
    `SELECT a.public_case_slug AS slug, p.desensitized_snapshot AS snap, s.name AS shop_name, a.updated_at
     FROM repair_albums a
     JOIN repair_case_publications p ON p.album_id = a.album_id AND p.review_status = 'approved'
     JOIN shops s ON s.shop_id = a.shop_id
     WHERE a.status = 'published' AND a.public_case_slug IS NOT NULL AND a.public_case_slug <> ''
     ORDER BY a.updated_at DESC
     LIMIT 120`
  );
  const norm = (s) =>
    String(s || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '');
  const nb = norm(brand);
  const nm = norm(model);
  const scored = [];
  for (const row of rows) {
    let snap = {};
    try {
      snap = typeof row.snap === 'string' ? JSON.parse(row.snap) : row.snap || {};
    } catch (_) {
      snap = {};
    }
    const sb = norm(snap.brand || snap.vehicle_brand || '');
    const sm = norm(snap.model || snap.vehicle_model || '');
    let score = 0;
    if (nb && sb && (sb.includes(nb) || nb.includes(sb))) score += 2;
    if (nm && sm && (sm.includes(nm) || nm.includes(sm))) score += 2;
    const title = String(snap.title || snap.case_title || '维修案例').slice(0, 120);
    const teaser = String(snap.summary || snap.teaser || snap.damage_summary || '').slice(0, 240);
    const min = snap.actual_amount_min != null ? snap.actual_amount_min : snap.amount_range_min;
    const max = snap.actual_amount_max != null ? snap.actual_amount_max : snap.amount_range_max;
    let amount_range = null;
    if (min != null && max != null && !Number.isNaN(Number(min)) && !Number.isNaN(Number(max))) {
      amount_range = [Math.round(Number(min)), Math.round(Number(max))];
    }
    scored.push({
      score,
      slug: row.slug,
      shop_name: row.shop_name,
      title,
      teaser,
      amount_range,
      published_url: `${BASE_URL}/zhejian/case/${row.slug}`,
      updated_at: row.updated_at,
    });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
  });
  const out = [];
  const seen = new Set();
  for (const x of scored) {
    if (!x.slug || seen.has(x.slug)) continue;
    seen.add(x.slug);
    out.push({
      slug: x.slug,
      shop_name: x.shop_name,
      title: x.title,
      teaser: x.teaser,
      amount_range: x.amount_range,
      published_url: x.published_url,
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function getPublicShopSummary(pool, shopId) {
  const [s] = await pool.execute(
    `SELECT shop_id, name, logo, address, province, city, district, phone, rating, rating_count FROM shops WHERE shop_id = ? AND status = 1`,
    [shopId]
  );
  if (s.length === 0) return { success: false, statusCode: 404, error: '店铺不存在' };
  let cases = [];
  if (await albumsTableExists(pool)) {
    const [c] = await pool.execute(
      `SELECT a.public_case_slug, a.updated_at
       FROM repair_albums a
       JOIN repair_case_publications p ON p.album_id = a.album_id AND p.review_status = 'approved'
       WHERE a.shop_id = ? AND a.status = 'published' AND a.public_case_slug IS NOT NULL
       ORDER BY a.updated_at DESC LIMIT 50`,
      [shopId]
    );
    cases = c;
  }
  return { success: true, data: { shop: s[0], cases } };
}

module.exports = {
  albumsTableExists,
  createAlbum,
  listAlbums,
  getAlbumDetail,
  patchAlbum,
  updateNodeNote,
  addMedia,
  deleteMedia,
  submitPublish,
  approvePublication,
  getPublicCaseBySlug,
  getPublicShopSummary,
  listSimilarPublishedCases,
  NODE_CODES,
};
