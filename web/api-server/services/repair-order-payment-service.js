/**
 * 车主竞价维修自费单：完工后商户提交结算，车主 JSAPI 支付维修款，回调分账入 income_balance
 */

const crypto = require('crypto');
const wechatPay = require('./wechat-pay-service');
const shopIncomeService = require('./shop-income-service');

function publicBaseUrl() {
  const raw = process.env.PUBLIC_API_BASE_URL || process.env.BASE_URL || '';
  return String(raw).replace(/\/$/, '');
}

function repairOrderNotifyPath() {
  return '/api/v1/pay/wechat/repair-order-notify';
}

function genIntentId() {
  return 'ROP' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex').slice(0, 8);
}

function genOutTradeNo() {
  return ('RO' + Date.now() + crypto.randomBytes(3).toString('hex')).slice(0, 32);
}

function roundMoney(y) {
  return Math.round(parseFloat(y) * 100) / 100;
}

function yuanToFen(y) {
  const n = roundMoney(y);
  const fen = Math.round(n * 100);
  return Math.max(1, fen);
}

async function createRepairOrderPrepay(pool, userId, orderId, openid) {
  if (!wechatPay.isConfigured()) {
    return { success: false, error: '未配置微信支付商户参数', statusCode: 503 };
  }
  const base = publicBaseUrl();
  if (!base) {
    return { success: false, error: '请配置 PUBLIC_API_BASE_URL 作为支付回调域名', statusCode: 503 };
  }
  const notifyUrl = base + repairOrderNotifyPath();

  const [rows] = await pool.execute(
    `SELECT order_id, user_id, shop_id, status, is_insurance_accident, commission_status,
            actual_amount, commission_final, commission, repair_payment_status, repair_out_trade_no
     FROM orders WHERE order_id = ? AND user_id = ?`,
    [orderId, userId]
  );
  if (!rows.length) return { success: false, error: '订单不存在', statusCode: 404 };
  const o = rows[0];
  if (o.status !== 3) return { success: false, error: '订单未完成，暂不能支付维修款', statusCode: 400 };
  if (o.is_insurance_accident === 1 || o.is_insurance_accident === '1') {
    return { success: false, error: '保险理赔单无需在此支付维修款', statusCode: 400 };
  }
  if (o.commission_status !== 'pending_owner_repair_pay') {
    return { success: false, error: '请等待维修厂提交结算金额后再支付', statusCode: 400 };
  }
  if (o.repair_payment_status === 'paid') {
    return { success: false, error: '该单维修款已支付', statusCode: 400 };
  }

  const amountTotal = roundMoney(o.actual_amount);
  if (amountTotal < 0.01) {
    return { success: false, error: '应付金额无效，请联系维修厂确认结算', statusCode: 400 };
  }

  const fen = yuanToFen(amountTotal);
  const outTradeNo = genOutTradeNo();
  const intentId = genIntentId();

  await pool.execute(
    `INSERT INTO repair_order_payment_intents (intent_id, order_id, user_id, out_trade_no, amount_fen, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    [intentId, orderId, userId, outTradeNo, fen]
  );
  await pool.execute(
    `UPDATE orders SET repair_out_trade_no = ?, repair_prepay_id = NULL, repair_payment_status = 'pending_pay' WHERE order_id = ?`,
    [outTradeNo, orderId]
  );

  const prepay = await wechatPay.jsapiPrepay({
    description: `辙见-维修款${String(orderId).slice(-8)}`,
    outTradeNo,
    amountFen: fen,
    openid,
    notifyUrl,
  });
  const mini = wechatPay.buildMiniProgramPayParams(prepay.prepay_id);
  await pool.execute('UPDATE repair_order_payment_intents SET prepay_id = ? WHERE intent_id = ?', [
    prepay.prepay_id,
    intentId,
  ]);
  await pool.execute('UPDATE orders SET repair_prepay_id = ? WHERE order_id = ?', [prepay.prepay_id, orderId]);

  return {
    success: true,
    data: {
      order_id: orderId,
      out_trade_no: outTradeNo,
      amount_total: amountTotal,
      ...mini,
    },
  };
}

async function handleRepairOrderNotify(pool, rawBody, headers) {
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
    const [[intent]] = await conn.execute(
      'SELECT * FROM repair_order_payment_intents WHERE out_trade_no = ? FOR UPDATE',
      [outTradeNo]
    );
    if (!intent) {
      await conn.commit();
      return { ok: true, note: 'unknown trade' };
    }
    if (intent.status === 'success') {
      await conn.commit();
      return { ok: true, idempotent: true };
    }

    const [[ordCheck]] = await conn.execute(
      'SELECT actual_amount FROM orders WHERE order_id = ? FOR UPDATE',
      [intent.order_id]
    );
    const expectedFen = yuanToFen(ordCheck && ordCheck.actual_amount != null ? ordCheck.actual_amount : 0);
    if (Math.abs(expectedFen - intent.amount_fen) > 1) {
      await conn.rollback();
      throw new Error('repair notify amount mismatch');
    }

    await conn.execute(
      `UPDATE repair_order_payment_intents SET status = 'success', wx_transaction_id = ?, raw_notify = ? WHERE intent_id = ?`,
      [transactionId || null, JSON.stringify(data), intent.intent_id]
    );

    await shopIncomeService.settlePaidRepairOrder(conn, intent.order_id, {
      wx_transaction_id: transactionId || null,
    });

    await conn.commit();
    return { ok: true };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  createRepairOrderPrepay,
  handleRepairOrderNotify,
  repairOrderNotifyPath,
};
