/**
 * 车主商品直购订单 + 微信支付 JSAPI（与维修竞价 orders 分离）
 * 分账：占位，当前全款记单；平台抽成比例见 settings product_order_platform_fee_rate（未配置视为 0）
 */

const crypto = require('crypto');
const wechatPay = require('./wechat-pay-service');
const shopProductService = require('./shop-product-service');
const shopIncomeService = require('./shop-income-service');

function publicBaseUrl() {
  const raw = process.env.PUBLIC_API_BASE_URL || process.env.BASE_URL || '';
  return String(raw).replace(/\/$/, '');
}

function productOrderNotifyPath() {
  return '/api/v1/pay/wechat/product-order-notify';
}

function genProductOrderId() {
  return 'PORD' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex').slice(0, 8);
}

function genOutTradeNo() {
  return ('PO' + Date.now() + crypto.randomBytes(3).toString('hex')).slice(0, 32);
}

function roundMoney(y) {
  return Math.round(parseFloat(y) * 100) / 100;
}

function yuanToFen(y) {
  const n = roundMoney(y);
  const fen = Math.round(n * 100);
  return Math.max(1, fen);
}

async function createOrder(pool, userId, body) {
  const { shop_id: shopId, product_id: productId, quantity: qtyRaw } = body || {};
  if (!shopId || !productId) {
    return { success: false, error: '缺少店铺或商品', statusCode: 400 };
  }
  const quantity = Math.min(99, Math.max(1, parseInt(qtyRaw, 10) || 1));

  const product = await shopProductService.getPublicById(pool, shopId, productId);
  if (!product) {
    return { success: false, error: '商品不存在或已下架', statusCode: 404 };
  }

  const unit = roundMoney(product.price);
  const amountTotal = roundMoney(unit * quantity);
  if (amountTotal < 0.01) {
    return { success: false, error: '金额无效', statusCode: 400 };
  }

  const productOrderId = genProductOrderId();
  await pool.execute(
    `INSERT INTO product_orders (
      product_order_id, user_id, shop_id, product_id,
      product_name_snapshot, product_price_snapshot, quantity, amount_total, payment_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_pay')`,
    [productOrderId, userId, shopId, productId, product.name, unit, quantity, amountTotal]
  );

  return {
    success: true,
    data: {
      product_order_id: productOrderId,
      shop_id: shopId,
      product_id: productId,
      product_name: product.name,
      product_price: unit,
      quantity,
      amount_total: amountTotal,
      payment_status: 'pending_pay',
    },
  };
}

async function getByIdForUser(pool, userId, productOrderId) {
  const [rows] = await pool.execute(
    `SELECT * FROM product_orders WHERE product_order_id = ? AND user_id = ?`,
    [productOrderId, userId]
  );
  return rows[0] || null;
}

/** 已支付标品单详情（预约页展示）；未支付或不属于该用户返回 null */
async function getPaidDetailForUser(pool, userId, productOrderId) {
  const [rows] = await pool.execute(
    `SELECT po.*, s.name AS shop_name
     FROM product_orders po
     JOIN shops s ON s.shop_id = po.shop_id
     WHERE po.product_order_id = ? AND po.user_id = ? AND po.payment_status = 'paid'`,
    [productOrderId, userId]
  );
  if (!rows.length) return null;
  return mapRow(rows[0]);
}

async function listForUser(pool, userId, query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  const [rows] = await pool.execute(
    `SELECT po.*, s.name as shop_name
     FROM product_orders po
     JOIN shops s ON s.shop_id = po.shop_id
     WHERE po.user_id = ?
     ORDER BY po.created_at DESC
     LIMIT ? OFFSET ?`,
    [userId, limit, offset]
  );
  const [cnt] = await pool.execute('SELECT COUNT(*) as c FROM product_orders WHERE user_id = ?', [userId]);
  return {
    list: rows.map(mapRow),
    total: cnt[0]?.c || 0,
    page,
    limit,
  };
}

async function listForMerchant(pool, shopId, query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  const [rows] = await pool.execute(
    `SELECT po.*, u.nickname as user_nickname
     FROM product_orders po
     LEFT JOIN users u ON u.user_id = po.user_id
     WHERE po.shop_id = ?
     ORDER BY po.created_at DESC
     LIMIT ? OFFSET ?`,
    [shopId, limit, offset]
  );
  const [cnt] = await pool.execute('SELECT COUNT(*) as c FROM product_orders WHERE shop_id = ?', [shopId]);
  return {
    list: rows.map(mapRow),
    total: cnt[0]?.c || 0,
    page,
    limit,
  };
}

function mapRow(r) {
  return {
    product_order_id: r.product_order_id,
    user_id: r.user_id,
    shop_id: r.shop_id,
    shop_name: r.shop_name != null ? r.shop_name : undefined,
    user_nickname: r.user_nickname != null ? r.user_nickname : undefined,
    product_id: r.product_id,
    product_name: r.product_name_snapshot,
    product_price: parseFloat(r.product_price_snapshot),
    quantity: r.quantity,
    amount_total: parseFloat(r.amount_total),
    payment_status: r.payment_status,
    created_at: r.created_at,
    paid_at: r.paid_at || null,
  };
}

/**
 * 拉起微信支付：需车主 openid（小程序 code 换 openid）
 */
async function createPrepay(pool, userId, productOrderId, openid) {
  if (!wechatPay.isConfigured()) {
    return { success: false, error: '未配置微信支付商户参数', statusCode: 503 };
  }
  const base = publicBaseUrl();
  if (!base) {
    return { success: false, error: '请配置 PUBLIC_API_BASE_URL 作为支付回调域名', statusCode: 503 };
  }
  const notifyUrl = base + productOrderNotifyPath();

  const row = await getByIdForUser(pool, userId, productOrderId);
  if (!row) {
    return { success: false, error: '订单不存在', statusCode: 404 };
  }
  if (row.payment_status !== 'pending_pay') {
    return { success: false, error: '当前订单不可支付', statusCode: 400 };
  }

  const amountTotal = roundMoney(row.amount_total);
  const fen = yuanToFen(amountTotal);
  const outTradeNo = genOutTradeNo();

  await pool.execute(
    `UPDATE product_orders SET out_trade_no = ?, prepay_id = NULL WHERE product_order_id = ? AND user_id = ? AND payment_status = 'pending_pay'`,
    [outTradeNo, productOrderId, userId]
  );

  const prepay = await wechatPay.jsapiPrepay({
    description: `辙见-${String(row.product_name_snapshot || '商品').slice(0, 40)}`,
    outTradeNo,
    amountFen: fen,
    openid,
    notifyUrl,
  });
  const mini = wechatPay.buildMiniProgramPayParams(prepay.prepay_id);
  await pool.execute('UPDATE product_orders SET prepay_id = ? WHERE product_order_id = ?', [
    prepay.prepay_id,
    productOrderId,
  ]);

  return {
    success: true,
    data: {
      product_order_id: productOrderId,
      out_trade_no: outTradeNo,
      amount_total: amountTotal,
      ...mini,
    },
  };
}

async function handleProductOrderNotify(pool, rawBody, headers) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    throw new Error('invalid notify body', { cause: e });
  }
  if (!wechatPay.verifyNotifySignature(headers, rawBody)) {
    throw new Error('notify signature verify failed');
  }
  if (body.event_type !== 'TRANSACTION.SUCCESS' || !body.resource) {
    return { ignored: true };
  }
  const data = wechatPay.decryptNotifyResource(body.resource);
  const { out_trade_no: outTradeNo, transaction_id: transactionId, trade_state: tradeState } = data;
  if (tradeState && tradeState !== 'SUCCESS') return { ignored: true };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[po]] = await conn.execute(
      'SELECT * FROM product_orders WHERE out_trade_no = ? FOR UPDATE',
      [outTradeNo]
    );
    if (!po) {
      await conn.commit();
      return { ok: true, note: 'unknown trade' };
    }
    const alreadyPaid = po.payment_status === 'paid';
    if (!alreadyPaid) {
      await conn.execute(
        `UPDATE product_orders SET payment_status = 'paid', wx_transaction_id = ?, paid_at = NOW() WHERE product_order_id = ?`,
        [transactionId || null, po.product_order_id]
      );
    }

    await shopIncomeService.settlePaidProductOrder(conn, po.product_order_id);

    await conn.commit();
    return { ok: true, idempotent: alreadyPaid };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  createOrder,
  createPrepay,
  getByIdForUser,
  getPaidDetailForUser,
  listForUser,
  listForMerchant,
  handleProductOrderNotify,
  productOrderNotifyPath,
};
