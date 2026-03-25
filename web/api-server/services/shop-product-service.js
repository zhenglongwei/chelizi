/**
 * 服务商商品服务
 * 上架/下架需后台审核通过
 */

const crypto = require('crypto');
const { auditShopProductWithQwen } = require('../qwen-analyzer');

const PRODUCT_CATEGORIES = ['钣金喷漆', '发动机维修', '电路维修', '保养服务'];

/** 与车主商品支付订单一致：单价须 ≥ 0.01 元 */
const MIN_PRODUCT_PRICE = 0.01;

function validatePriceYuan(priceNum) {
  if (isNaN(priceNum) || priceNum < MIN_PRODUCT_PRICE) {
    return { ok: false, error: `价格不能低于 ${MIN_PRODUCT_PRICE} 元` };
  }
  return { ok: true };
}

function genProductId() {
  return 'PRD' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex').slice(0, 8);
}

/** 环境变量 SHOP_PRODUCT_AUTO_AUDIT=0/false/off 关闭智能审核，仅人工 */
function isShopProductAutoAuditEnabled() {
  const v = String(process.env.SHOP_PRODUCT_AUTO_AUDIT || '').toLowerCase().trim();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return true;
}

/**
 * 新建/重新提交后：尝试千问自动审核；失败或未配置 Key 则保持 pending 转人工
 */
async function tryAutoAuditProduct(pool, productId) {
  if (!isShopProductAutoAuditEnabled()) {
    return {
      status: 'pending',
      message: '已提交审核，请等待后台审核通过',
    };
  }
  const apiKey = process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '';
  if (!String(apiKey).trim()) {
    return {
      status: 'pending',
      message: '已提交审核，请等待后台审核通过',
    };
  }

  const [rows] = await pool.execute(
    `SELECT product_id, name, category, description, images, status FROM shop_products WHERE product_id = ?`,
    [productId]
  );
  const row = rows[0];
  if (!row || row.status !== 'pending') {
    const st = row?.status || 'pending';
    return {
      status: st,
      message: st === 'approved' ? '商品已上架' : '已提交审核，请等待后台审核通过',
    };
  }

  let imageUrls = [];
  try {
    imageUrls = typeof row.images === 'string' ? JSON.parse(row.images || '[]') : row.images || [];
  } catch (_) {
    imageUrls = [];
  }
  if (!Array.isArray(imageUrls)) imageUrls = [];

  try {
    const result = await auditShopProductWithQwen({
      name: row.name,
      category: row.category,
      description: row.description,
      imageUrls,
      apiKey: String(apiKey).trim(),
    });
    if (result.pass) {
      await pool.execute(
        `UPDATE shop_products SET status = 'approved', audit_reason = NULL, audited_at = NOW() WHERE product_id = ? AND status = 'pending'`,
        [productId]
      );
      return { status: 'approved', message: '已通过智能审核，商品已上架' };
    }
    const note = (`[自动审核] ${result.reason || '未通过'}`).slice(0, 500);
    await pool.execute(
      `UPDATE shop_products SET audit_reason = ? WHERE product_id = ? AND status = 'pending'`,
      [note, productId]
    );
    return {
      status: 'pending',
      message: '未通过自动审核，已转人工审核，请耐心等待',
    };
  } catch (e) {
    console.error('[shop-product auto-audit]', productId, e && e.message);
    return {
      status: 'pending',
      message: '已提交审核（智能审核暂不可用），请等待人工审核',
    };
  }
}

function mapPublicProductRow(row) {
  const images = typeof row.images === 'string' ? JSON.parse(row.images || '[]') : (row.images || []);
  return {
    product_id: row.product_id,
    name: row.name,
    category: row.category,
    price: parseFloat(row.price),
    description: row.description,
    images,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 车主端：某店已上架（审核通过）商品列表
 */
async function listPublicForShop(pool, shopId) {
  const [rows] = await pool.execute(
    `SELECT product_id, name, category, price, description, images, created_at, updated_at
     FROM shop_products WHERE shop_id = ? AND status = 'approved' ORDER BY created_at DESC`,
    [shopId]
  );
  return rows.map(mapPublicProductRow);
}

/**
 * 车主端：校验商品可售（本店且已审核通过）
 */
async function getPublicById(pool, shopId, productId) {
  const [rows] = await pool.execute(
    `SELECT product_id, shop_id, name, category, price, description, images, created_at, updated_at
     FROM shop_products WHERE product_id = ? AND shop_id = ? AND status = 'approved'`,
    [productId, shopId]
  );
  if (!rows.length) return null;
  return mapPublicProductRow(rows[0]);
}

/**
 * 服务商：获取本店商品列表
 */
async function listByShop(pool, shopId) {
  const [rows] = await pool.execute(
    `SELECT product_id, name, category, price, description, images, status, audit_reason, created_at, updated_at
     FROM shop_products WHERE shop_id = ? ORDER BY created_at DESC`,
    [shopId]
  );
  return {
    success: true,
    data: {
      list: rows.map(row => ({
        product_id: row.product_id,
        name: row.name,
        category: row.category,
        price: parseFloat(row.price),
        description: row.description,
        images: typeof row.images === 'string' ? JSON.parse(row.images || '[]') : (row.images || []),
        status: row.status,
        audit_reason: row.audit_reason,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
    },
  };
}

/**
 * 服务商：上架商品（提交审核）
 */
async function create(pool, shopId, body) {
  const { name, category, price, description, images } = body || {};
  if (!name || !String(name).trim()) {
    return { success: false, error: '请填写商品名称', statusCode: 400 };
  }
  if (!category || !PRODUCT_CATEGORIES.includes(category)) {
    return { success: false, error: '请选择有效分类', statusCode: 400 };
  }
  const priceNum = parseFloat(price);
  const pv = validatePriceYuan(priceNum);
  if (!pv.ok) {
    return { success: false, error: pv.error, statusCode: 400 };
  }

  const productId = genProductId();
  const imgArr = Array.isArray(images) ? images : JSON.parse(images || '[]');

  await pool.execute(
    `INSERT INTO shop_products (product_id, shop_id, name, category, price, description, images, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [productId, shopId, String(name).trim(), category, priceNum, description || null, JSON.stringify(imgArr)]
  );

  const auto = await tryAutoAuditProduct(pool, productId);
  return {
    success: true,
    data: {
      product_id: productId,
      status: auto.status,
      message: auto.message,
    },
  };
}

/**
 * 服务商：编辑商品
 * 已上架（approved）不可直接改，须先下架；已下架（off_shelf）/待审/驳回可编辑并重新送审
 */
async function update(pool, shopId, productId, body) {
  const [rows] = await pool.execute(
    'SELECT product_id FROM shop_products WHERE product_id = ? AND shop_id = ?',
    [productId, shopId]
  );
  if (rows.length === 0) {
    return { success: false, error: '商品不存在', statusCode: 404 };
  }
  const [statusRows] = await pool.execute(
    'SELECT status FROM shop_products WHERE product_id = ?',
    [productId]
  );
  const status = statusRows[0]?.status;
  if (status === 'approved') {
    return { success: false, error: '已上架商品请先下架后再编辑', statusCode: 400 };
  }

  const { name, category, price, description, images } = body || {};
  const updates = [];
  const params = [];

  if (name != null && String(name).trim()) {
    updates.push('name = ?');
    params.push(String(name).trim());
  }
  if (category != null && PRODUCT_CATEGORIES.includes(category)) {
    updates.push('category = ?');
    params.push(category);
  }
  if (price != null) {
    const priceNum = parseFloat(price);
    const pv = validatePriceYuan(priceNum);
    if (!pv.ok) {
      return { success: false, error: pv.error, statusCode: 400 };
    }
    updates.push('price = ?');
    params.push(priceNum);
  }
  if (description !== undefined) {
    updates.push('description = ?');
    params.push(description || null);
  }
  if (images !== undefined) {
    const imgArr = Array.isArray(images) ? images : JSON.parse(images || '[]');
    updates.push('images = ?');
    params.push(JSON.stringify(imgArr));
  }
  if (updates.length > 0) {
    updates.push('audit_reason = ?');
    params.push(null);
    updates.push('status = ?');
    params.push('pending');
    params.push(productId);
    await pool.execute(
      `UPDATE shop_products SET ${updates.join(', ')} WHERE product_id = ?`,
      params
    );
    const auto = await tryAutoAuditProduct(pool, productId);
    return {
      success: true,
      data: {
        product_id: productId,
        status: auto.status,
        message: auto.message,
      },
    };
  }

  return { success: true, data: { product_id: productId, status: status, message: '无变更' } };
}

/**
 * 服务商：下架商品（仅已上架 approved）
 */
async function offShelf(pool, shopId, productId) {
  const [rows] = await pool.execute(
    'SELECT status FROM shop_products WHERE product_id = ? AND shop_id = ?',
    [productId, shopId]
  );
  if (rows.length === 0) {
    return { success: false, error: '商品不存在', statusCode: 404 };
  }
  if (rows[0].status !== 'approved') {
    return { success: false, error: '仅已上架商品可下架', statusCode: 400 };
  }

  await pool.execute(
    "UPDATE shop_products SET status = 'off_shelf' WHERE product_id = ? AND shop_id = ?",
    [productId, shopId]
  );
  return { success: true, data: { product_id: productId, status: 'off_shelf' } };
}

/**
 * 服务商：撤回待审核商品（删除记录）
 */
async function deletePending(pool, shopId, productId) {
  const [rows] = await pool.execute(
    'SELECT status FROM shop_products WHERE product_id = ? AND shop_id = ?',
    [productId, shopId]
  );
  if (rows.length === 0) {
    return { success: false, error: '商品不存在', statusCode: 404 };
  }
  if (rows[0].status !== 'pending') {
    return { success: false, error: '仅待审核中的商品可撤回', statusCode: 400 };
  }
  await pool.execute('DELETE FROM shop_products WHERE product_id = ? AND shop_id = ?', [productId, shopId]);
  return { success: true, data: { product_id: productId } };
}

/**
 * 后台：待审核商品列表
 */
async function listPendingForAdmin(pool, query) {
  const { page = 1, limit = 20 } = query;
  const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limitNum;

  const [rows] = await pool.execute(
    `SELECT p.product_id, p.shop_id, p.name, p.category, p.price, p.description, p.images, p.status, p.audit_reason, p.created_at, s.name as shop_name
     FROM shop_products p
     JOIN shops s ON s.shop_id = p.shop_id
     WHERE p.status = 'pending'
     ORDER BY p.created_at ASC
     LIMIT ? OFFSET ?`,
    [limitNum, offset]
  );

  const [countRows] = await pool.execute(
    "SELECT COUNT(*) as total FROM shop_products WHERE status = 'pending'"
  );
  const total = countRows[0]?.total || 0;

  return {
    success: true,
    data: {
      list: rows.map(r => ({
        product_id: r.product_id,
        shop_id: r.shop_id,
        shop_name: r.shop_name,
        name: r.name,
        category: r.category,
        price: parseFloat(r.price),
        description: r.description,
        images: typeof r.images === 'string' ? JSON.parse(r.images || '[]') : (r.images || []),
        status: r.status,
        audit_reason: r.audit_reason,
        created_at: r.created_at,
      })),
      total,
      page: Math.floor(offset / limitNum) + 1,
      limit: limitNum,
    },
  };
}

/**
 * 后台：审核通过/驳回
 */
async function audit(pool, productId, body) {
  const { action, reason } = body || {};
  if (!['approve', 'reject'].includes(action)) {
    return { success: false, error: '无效的审核操作', statusCode: 400 };
  }

  const [rows] = await pool.execute(
    'SELECT product_id FROM shop_products WHERE product_id = ? AND status = ?',
    [productId, 'pending']
  );
  if (rows.length === 0) {
    return { success: false, error: '商品不存在或非待审核状态', statusCode: 404 };
  }

  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  const auditReason = action === 'reject' ? (reason || '不符合上架要求') : null;

  await pool.execute(
    'UPDATE shop_products SET status = ?, audit_reason = ?, audited_at = NOW() WHERE product_id = ?',
    [newStatus, auditReason, productId]
  );

  return {
    success: true,
    data: { product_id: productId, status: newStatus, message: action === 'approve' ? '已通过审核' : '已驳回' },
  };
}

/**
 * 按分类获取已上架商品（供搜索页展示）
 */
async function getApprovedByCategory(pool, category) {
  const [rows] = await pool.execute(
    `SELECT p.product_id, p.shop_id, p.name, p.category, p.price, p.description, p.images, s.name as shop_name, s.address, s.district
     FROM shop_products p
     JOIN shops s ON s.shop_id = p.shop_id
     WHERE p.category = ? AND p.status = 'approved' AND s.status = 1 AND (s.qualification_status = 1 OR s.qualification_status IS NULL)
     ORDER BY p.price ASC`,
    [category]
  );
  return rows;
}

module.exports = {
  PRODUCT_CATEGORIES,
  MIN_PRODUCT_PRICE,
  listByShop,
  listPublicForShop,
  getPublicById,
  create,
  update,
  offShelf,
  deletePending,
  listPendingForAdmin,
  audit,
  getApprovedByCategory,
};
