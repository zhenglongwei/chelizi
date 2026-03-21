/**
 * 服务商佣金钱包、两阶段计佣、微信支付对接
 */

const crypto = require('crypto');
const wechatPay = require('./wechat-pay-service');
const subscribeMsg = require('./subscribe-message-service');

function publicBaseUrl() {
  // 与微信 notify_url 一致：仅站点根，不含 /api；未单独配置时沿用已有 BASE_URL（与 server 其它逻辑一致）
  const raw = process.env.PUBLIC_API_BASE_URL || process.env.BASE_URL || '';
  return String(raw).replace(/\/$/, '');
}

function notifyPath() {
  return '/api/v1/pay/wechat/commission-notify';
}

async function getSetting(pool, key, def) {
  try {
    const [rows] = await pool.execute('SELECT `value` FROM settings WHERE `key` = ?', [key]);
    if (rows.length) return String(rows[0].value);
  } catch (_) {}
  return def;
}

async function getPrimaryMerchantId(pool, shopId) {
  const [rows] = await pool.execute(
    'SELECT merchant_id FROM merchant_users WHERE shop_id = ? AND status = 1 ORDER BY id ASC LIMIT 1',
    [shopId]
  );
  return rows.length ? rows[0].merchant_id : null;
}

function genId(prefix) {
  return prefix + Date.now() + crypto.randomBytes(4).toString('hex');
}

function yuanToFen(y) {
  return Math.max(1, Math.round(parseFloat(y) * 100));
}

function roundMoney(y) {
  return Math.round(parseFloat(y) * 100) / 100;
}

async function ensureWallet(conn, shopId) {
  await conn.execute(
    'INSERT INTO merchant_commission_wallets (shop_id) VALUES (?) ON DUPLICATE KEY UPDATE shop_id = shop_id',
    [shopId]
  );
}

/**
 * 订单确认完工后：写暂计佣金并尝试收款
 */
async function afterOrderCompleted(pool, orderRow) {
  const {
    order_id: orderId,
    shop_id: shopId,
    commission: commissionVal,
    is_insurance_accident: insRaw,
  } = orderRow;

  const waiveInsurance = (await getSetting(pool, 'commission_waive_insurance', '1')) === '1';
  const isInsurance = insRaw === 1 || insRaw === '1';

  if (waiveInsurance && isInsurance) {
    await pool.execute(
      `UPDATE orders SET commission_status = 'waived_insurance', commission_provisional = NULL, commission_final = NULL
       WHERE order_id = ?`,
      [orderId]
    );
    return { status: 'waived_insurance' };
  }

  const provisional = roundMoney(commissionVal);
  await pool.execute(
    `UPDATE orders SET commission_provisional = ?, commission_paid_amount = COALESCE(commission_paid_amount, 0)
     WHERE order_id = ?`,
    [provisional, orderId]
  );

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await ensureWallet(conn, shopId);
    const [[wallet]] = await conn.execute(
      'SELECT balance, deduct_mode FROM merchant_commission_wallets WHERE shop_id = ? FOR UPDATE',
      [shopId]
    );
    const mode = wallet.deduct_mode || 'auto';

    if (mode === 'per_order') {
      await conn.execute(
        `UPDATE orders SET commission_status = 'awaiting_pay' WHERE order_id = ?`,
        [orderId]
      );
      await conn.commit();
      return { status: 'awaiting_pay', needPayYuan: provisional };
    }

    const bal = parseFloat(wallet.balance) || 0;
    if (bal >= provisional - 1e-6) {
      const newBal = roundMoney(bal - provisional);
      const ledgerId = genId('MCL');
      await conn.execute(
        'UPDATE merchant_commission_wallets SET balance = ?, updated_at = NOW() WHERE shop_id = ?',
        [newBal, shopId]
      );
      await conn.execute(
        `INSERT INTO merchant_commission_ledger (ledger_id, shop_id, type, amount, balance_after, order_id, remark)
         VALUES (?, ?, 'deduct_provisional', ?, ?, ?, ?)`,
        [ledgerId, shopId, -provisional, newBal, orderId, '阶段A自动扣佣']
      );
      await conn.execute(
        `UPDATE orders SET commission_status = 'paid_provisional', commission_paid_amount = ? WHERE order_id = ?`,
        [provisional, orderId]
      );
      await conn.commit();
      return { status: 'paid_provisional', walletDeductYuan: provisional };
    }

    await conn.execute(`UPDATE orders SET commission_status = 'arrears' WHERE order_id = ?`, [orderId]);
    await conn.commit();

    const merchantId = await getPrimaryMerchantId(pool, shopId);
    if (merchantId) {
      const msgId = genId('mmsg_');
      try {
        await pool.execute(
          `INSERT INTO merchant_messages (message_id, merchant_id, type, title, content, related_id, is_read)
           VALUES (?, ?, 'system', ?, ?, ?, 0)`,
          [
            msgId,
            merchantId,
            '佣金账户余额不足',
            `订单 ${orderId.slice(-8)} 确认完工，需扣佣金 ¥${provisional}，当前余额不足。请充值或改为逐单支付。`,
            orderId,
          ]
        );
      } catch (_) {}
      subscribeMsg
        .sendToMerchant(
          pool,
          merchantId,
          'merchant_commission_alert',
          {
            title: '佣金待缴',
            content: `余额不足¥${provisional}`.slice(0, 20),
            relatedId: orderId,
          },
          process.env.WX_APPID,
          process.env.WX_SECRET
        )
        .catch(() => {});
    }

    return { status: 'arrears', needPayYuan: provisional };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function getWallet(pool, shopId) {
  await pool.execute(
    'INSERT INTO merchant_commission_wallets (shop_id) VALUES (?) ON DUPLICATE KEY UPDATE shop_id = shop_id',
    [shopId]
  );
  const [[w]] = await pool.execute(
    'SELECT shop_id, balance, frozen, deduct_mode, updated_at FROM merchant_commission_wallets WHERE shop_id = ?',
    [shopId]
  );
  return w;
}

async function setDeductMode(pool, shopId, mode) {
  if (mode !== 'auto' && mode !== 'per_order') {
    return { success: false, error: 'deduct_mode 须为 auto 或 per_order', statusCode: 400 };
  }
  await pool.execute(
    'INSERT INTO merchant_commission_wallets (shop_id, deduct_mode) VALUES (?, ?) ON DUPLICATE KEY UPDATE deduct_mode = ?',
    [shopId, mode, mode]
  );
  return { success: true, data: { deduct_mode: mode } };
}

async function listLedger(pool, shopId, { page = 1, limit = 20 } = {}) {
  const off = (Math.max(1, page) - 1) * Math.min(100, Math.max(1, limit));
  const lim = Math.min(100, Math.max(1, limit));
  const [rows] = await pool.execute(
    `SELECT ledger_id, type, amount, balance_after, order_id, wx_transaction_id, remark, created_at
     FROM merchant_commission_ledger WHERE shop_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
    [shopId, lim, off]
  );
  const [[{ c }]] = await pool.execute(
    'SELECT COUNT(*) as c FROM merchant_commission_ledger WHERE shop_id = ?',
    [shopId]
  );
  return { list: rows, total: c };
}

function buildNotifyUrl() {
  const base = publicBaseUrl();
  if (!base) return '';
  return base + notifyPath();
}

async function createRechargePrepay(pool, shopId, merchantId, amountYuan, openid) {
  if (!wechatPay.isConfigured()) {
    return { success: false, error: '未配置微信支付商户参数（WECHAT_PAY_*）', statusCode: 503 };
  }
  const notifyUrl = buildNotifyUrl();
  if (!notifyUrl) {
    return { success: false, error: '请配置 PUBLIC_API_BASE_URL 作为支付回调域名', statusCode: 503 };
  }
  const amount = parseFloat(amountYuan);
  if (!(amount >= 1) || amount > 50000) {
    return { success: false, error: '充值金额须在 1～50000 元', statusCode: 400 };
  }
  const fen = yuanToFen(amount);
  const outTradeNo = genId('RC').slice(0, 32);
  const intentId = genId('MCI');

  await pool.execute(
    `INSERT INTO merchant_commission_payment_intents
     (intent_id, shop_id, merchant_id, kind, out_trade_no, amount_fen, status) VALUES (?, ?, ?, 'recharge', ?, ?, 'pending')`,
    [intentId, shopId, merchantId, outTradeNo, fen]
  );

  const prepay = await wechatPay.jsapiPrepay({
    description: '车厘子佣金账户充值',
    outTradeNo,
    amountFen: fen,
    openid,
    notifyUrl,
  });
  const mini = wechatPay.buildMiniProgramPayParams(prepay.prepay_id);
  await pool.execute('UPDATE merchant_commission_payment_intents SET prepay_id = ? WHERE intent_id = ?', [
    prepay.prepay_id,
    intentId,
  ]);

  return {
    success: true,
    data: {
      intent_id: intentId,
      out_trade_no: outTradeNo,
      ...mini,
    },
  };
}

async function createOrderCommissionPrepay(pool, shopId, merchantId, orderId, openid) {
  if (!wechatPay.isConfigured()) {
    return { success: false, error: '未配置微信支付商户参数', statusCode: 503 };
  }
  const notifyUrl = buildNotifyUrl();
  if (!notifyUrl) {
    return { success: false, error: '请配置 PUBLIC_API_BASE_URL', statusCode: 503 };
  }

  const [ords] = await pool.execute(
    `SELECT order_id, shop_id, commission_provisional, commission_final, commission_paid_amount, commission_status
     FROM orders WHERE order_id = ? AND shop_id = ?`,
    [orderId, shopId]
  );
  if (!ords.length) return { success: false, error: '订单不存在', statusCode: 404 };
  const o = ords[0];
  const due = parseFloat(o.commission_final) || parseFloat(o.commission_provisional) || 0;
  const paid = parseFloat(o.commission_paid_amount) || 0;
  const need = roundMoney(due - paid);
  if (need <= 0) return { success: false, error: '该订单无需再缴佣金', statusCode: 400 };
  if (!['awaiting_pay', 'arrears'].includes(o.commission_status)) {
    return { success: false, error: '当前订单状态不可发起佣金支付', statusCode: 400 };
  }

  const fen = yuanToFen(need);
  const outTradeNo = genId('OC').slice(0, 32);
  const intentId = genId('MCI');
  await pool.execute(
    `INSERT INTO merchant_commission_payment_intents
     (intent_id, shop_id, merchant_id, kind, order_id, out_trade_no, amount_fen, status)
     VALUES (?, ?, ?, 'order_commission', ?, ?, ?, 'pending')`,
    [intentId, shopId, merchantId, orderId, outTradeNo, fen]
  );

  const prepay = await wechatPay.jsapiPrepay({
    description: `订单佣金 ${orderId.slice(-8)}`,
    outTradeNo,
    amountFen: fen,
    openid,
    notifyUrl,
  });
  const mini = wechatPay.buildMiniProgramPayParams(prepay.prepay_id);
  await pool.execute('UPDATE merchant_commission_payment_intents SET prepay_id = ? WHERE intent_id = ?', [
    prepay.prepay_id,
    intentId,
  ]);
  return { success: true, data: { intent_id: intentId, out_trade_no: outTradeNo, need_yuan: need, ...mini } };
}

async function handleWechatPayNotify(pool, rawBody, headers) {
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
      'SELECT * FROM merchant_commission_payment_intents WHERE out_trade_no = ? FOR UPDATE',
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

    const amountFen = parseInt(data.amount?.payer_total ?? data.amount?.total, 10) || intent.amount_fen;

    if (intent.kind === 'recharge') {
      await ensureWallet(conn, intent.shop_id);
      const [[w]] = await conn.execute(
        'SELECT balance FROM merchant_commission_wallets WHERE shop_id = ? FOR UPDATE',
        [intent.shop_id]
      );
      const bal = parseFloat(w.balance) || 0;
      const add = roundMoney(amountFen / 100);
      const newBal = roundMoney(bal + add);
      const ledgerId = genId('MCL');
      await conn.execute(
        'UPDATE merchant_commission_wallets SET balance = ?, updated_at = NOW() WHERE shop_id = ?',
        [newBal, intent.shop_id]
      );
      await conn.execute(
        `INSERT INTO merchant_commission_ledger (ledger_id, shop_id, type, amount, balance_after, payment_intent_id, wx_transaction_id, remark)
         VALUES (?, ?, 'recharge', ?, ?, ?, ?, ?)`,
        [ledgerId, intent.shop_id, add, newBal, intent.intent_id, transactionId, '微信充值']
      );
    } else if (intent.kind === 'order_commission') {
      const orderId = intent.order_id;
      const [[o]] = await conn.execute(
        'SELECT commission_provisional, commission_paid_amount FROM orders WHERE order_id = ? FOR UPDATE',
        [orderId]
      );
      if (!o) throw new Error('order missing');
      const prov = parseFloat(o.commission_provisional) || 0;
      const paid = parseFloat(o.commission_paid_amount) || 0;
      const wxYuan = roundMoney(amountFen / 100);
      const newPaid = roundMoney(paid + wxYuan);
      const ledgerId = genId('MCL');
      await conn.execute(
        `INSERT INTO merchant_commission_ledger (ledger_id, shop_id, type, amount, balance_after, order_id, payment_intent_id, wx_transaction_id, remark)
         VALUES (?, ?, 'wx_order_pay', ?, NULL, ?, ?, ?, ?)`,
        [ledgerId, intent.shop_id, -wxYuan, orderId, intent.intent_id, transactionId, '微信支付佣金']
      );
      let newStatus = 'paid_provisional';
      if (newPaid + 1e-6 >= prov) newStatus = 'paid_provisional';
      await conn.execute(
        `UPDATE orders SET commission_paid_amount = ?, commission_status = ? WHERE order_id = ?`,
        [newPaid, newStatus, orderId]
      );
    }

    await conn.execute(
      'UPDATE merchant_commission_payment_intents SET status = ?, wx_transaction_id = ?, raw_notify = ? WHERE intent_id = ?',
      ['success', transactionId, JSON.stringify(data), intent.intent_id]
    );
    await conn.commit();
    return { ok: true };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * 阶段 B：提交最终实付金额与支付凭证，多退少补
 */
async function finalizeCommissionProof(pool, shopId, orderId, actualAmountYuan, proofUrls) {
  const [ords] = await pool.execute(
    `SELECT order_id, shop_id, status, commission_rate, commission_provisional, commission_paid_amount, commission_status
     FROM orders WHERE order_id = ? AND shop_id = ?`,
    [orderId, shopId]
  );
  if (!ords.length) return { success: false, error: '订单不存在', statusCode: 404 };
  const o = ords[0];
  if (o.status !== 3) return { success: false, error: '仅已完成订单可 finalize', statusCode: 400 };
  if (['waived_insurance', 'legacy_exempt'].includes(o.commission_status)) {
    return { success: false, error: '该订单无需佣金 finalize', statusCode: 400 };
  }

  const actual = roundMoney(actualAmountYuan);
  const rate = (parseFloat(o.commission_rate) || 0) / 100;
  const commissionFinal = roundMoney(actual * rate);
  const paid = parseFloat(o.commission_paid_amount) || 0;
  const outstanding = roundMoney(commissionFinal - paid);

  const proofJson = JSON.stringify(Array.isArray(proofUrls) ? proofUrls : []);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE orders SET actual_amount = ?, repair_payment_proof = ?, commission_final = ?, commission = ?
       WHERE order_id = ?`,
      [actual, proofJson, commissionFinal, commissionFinal, orderId]
    );

    if (outstanding <= 1e-6) {
      if (outstanding < -1e-6) {
        const credit = -outstanding;
        await ensureWallet(conn, shopId);
        const [[w]] = await conn.execute(
          'SELECT balance FROM merchant_commission_wallets WHERE shop_id = ? FOR UPDATE',
          [shopId]
        );
        const bal = parseFloat(w.balance) || 0;
        const newBal = roundMoney(bal + credit);
        const ledgerId = genId('MCL');
        await conn.execute(
          'UPDATE merchant_commission_wallets SET balance = ?, updated_at = NOW() WHERE shop_id = ?',
          [newBal, shopId]
        );
        await conn.execute(
          `INSERT INTO merchant_commission_ledger (ledger_id, shop_id, type, amount, balance_after, order_id, remark)
           VALUES (?, ?, 'adjust_credit', ?, ?, ?, ?)`,
          [ledgerId, shopId, credit, newBal, orderId, '阶段B佣金差额退回账户']
        );
      }
      await conn.execute(
        `UPDATE orders SET commission_status = 'finalized', commission_paid_amount = ? WHERE order_id = ?`,
        [commissionFinal, orderId]
      );
      await conn.commit();
      return { success: true, data: { commission_final: commissionFinal, outstanding: 0 } };
    }

    await ensureWallet(conn, shopId);
    const [[w]] = await conn.execute(
      'SELECT balance, deduct_mode FROM merchant_commission_wallets WHERE shop_id = ? FOR UPDATE',
      [shopId]
    );
    const bal = parseFloat(w.balance) || 0;
    if (bal >= outstanding - 1e-6) {
      const newBal = roundMoney(bal - outstanding);
      const ledgerId = genId('MCL');
      await conn.execute(
        'UPDATE merchant_commission_wallets SET balance = ?, updated_at = NOW() WHERE shop_id = ?',
        [newBal, shopId]
      );
      await conn.execute(
        `INSERT INTO merchant_commission_ledger (ledger_id, shop_id, type, amount, balance_after, order_id, remark)
         VALUES (?, ?, 'deduct_finalize', ?, ?, ?, ?)`,
        [ledgerId, shopId, -outstanding, newBal, orderId, '阶段B补扣佣金差额']
      );
      await conn.execute(
        `UPDATE orders SET commission_paid_amount = ?, commission_status = 'finalized' WHERE order_id = ?`,
        [commissionFinal, orderId]
      );
      await conn.commit();
      return { success: true, data: { commission_final: commissionFinal, wallet_deduct: outstanding } };
    }

    await conn.execute(
      `UPDATE orders SET commission_status = 'arrears', commission_final = ? WHERE order_id = ?`,
      [commissionFinal, orderId]
    );
    await conn.commit();

    const merchantId = await getPrimaryMerchantId(pool, shopId);
    if (merchantId) {
      subscribeMsg
        .sendToMerchant(
          pool,
          merchantId,
          'merchant_commission_alert',
          {
            title: '佣金待补缴',
            content: `差额¥${outstanding}`.slice(0, 20),
            relatedId: orderId,
          },
          process.env.WX_APPID,
          process.env.WX_SECRET
        )
        .catch(() => {});
    }

    return {
      success: true,
      data: { commission_final: commissionFinal, outstanding, need_extra_pay: true },
    };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * 余额原路退款（按充值单 FIFO 拆退）
 */
async function requestRefund(pool, shopId, merchantId, amountYuan) {
  if (!wechatPay.isConfigured()) {
    return { success: false, error: '未配置微信支付', statusCode: 503 };
  }
  const amount = roundMoney(amountYuan);
  await ensureWallet(pool, shopId);
  const [[w]] = await pool.execute(
    'SELECT balance, frozen FROM merchant_commission_wallets WHERE shop_id = ?',
    [shopId]
  );
  const bal = parseFloat(w.balance) || 0;
  const frozen = parseFloat(w.frozen) || 0;
  const available = roundMoney(bal - frozen);
  if (amount <= 0 || amount > available) {
    return { success: false, error: '退款金额超过可退余额（已扣除冻结）', statusCode: 400 };
  }

  let remainingFen = yuanToFen(amount);
  const [intents] = await pool.execute(
    `SELECT * FROM merchant_commission_payment_intents
     WHERE shop_id = ? AND kind = 'recharge' AND status = 'success' ORDER BY created_at ASC`,
    [shopId]
  );

  const plan = [];
  for (const row of intents) {
    if (remainingFen <= 0) break;
    const maxRef = row.amount_fen - (row.refunded_fen || 0);
    if (maxRef <= 0) continue;
    const chunk = Math.min(maxRef, remainingFen);
    plan.push({ intent_id: row.intent_id, chunk, out_trade_no: row.out_trade_no, totalFen: row.amount_fen });
    remainingFen -= chunk;
  }
  if (remainingFen > 0) {
    return { success: false, error: '可原路退款的充值记录不足，请联系运营', statusCode: 400 };
  }

  const refunds = [];
  try {
    for (const p of plan) {
      const outRefundNo = genId('RF').slice(0, 32);
      await wechatPay.refund({
        outTradeNo: p.out_trade_no,
        outRefundNo,
        refundFen: p.chunk,
        totalFen: p.totalFen,
      });
      refunds.push({ out_refund_no: outRefundNo, fen: p.chunk });
    }
  } catch (e) {
    return { success: false, error: e.message || '微信退款接口失败', statusCode: 502 };
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[w2]] = await conn.execute(
      'SELECT balance FROM merchant_commission_wallets WHERE shop_id = ? FOR UPDATE',
      [shopId]
    );
    const bal2 = parseFloat(w2.balance) || 0;
    if (bal2 + 1e-6 < amount) {
      await conn.rollback();
      return { success: false, error: '余额已变化，请重试', statusCode: 409 };
    }
    for (const p of plan) {
      await conn.execute(
        'UPDATE merchant_commission_payment_intents SET refunded_fen = refunded_fen + ? WHERE intent_id = ?',
        [p.chunk, p.intent_id]
      );
    }
    const newBal = roundMoney(bal2 - amount);
    const ledgerId = genId('MCL');
    await conn.execute(
      'UPDATE merchant_commission_wallets SET balance = ?, updated_at = NOW() WHERE shop_id = ?',
      [newBal, shopId]
    );
    await conn.execute(
      `INSERT INTO merchant_commission_ledger (ledger_id, shop_id, type, amount, balance_after, remark)
       VALUES (?, ?, 'refund', ?, ?, ?)`,
      [ledgerId, shopId, -amount, newBal, '佣金账户原路退款']
    );
    await conn.commit();
    return { success: true, data: { refunded_yuan: amount, refunds } };
  } catch (e) {
    await conn.rollback();
    return { success: false, error: e.message || '账本更新失败', statusCode: 500 };
  } finally {
    conn.release();
  }
}

async function scanLowBalanceWallets(pool) {
  const threshold = parseFloat(await getSetting(pool, 'commission_low_balance_threshold_yuan', '100')) || 100;
  const [wallets] = await pool.execute(
    `SELECT w.shop_id, w.balance, w.deduct_mode, w.low_balance_notified_at
     FROM merchant_commission_wallets w
     WHERE w.deduct_mode = 'auto' AND w.balance < ?`,
    [threshold]
  );
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
  for (const w of wallets) {
    const last = w.low_balance_notified_at ? new Date(w.low_balance_notified_at) : null;
    if (last && last > dayAgo) continue;
    const mid = await getPrimaryMerchantId(pool, w.shop_id);
    if (!mid) continue;
    await subscribeMsg.sendToMerchant(
      pool,
      mid,
      'merchant_commission_alert',
      {
        title: '佣金余额低',
        content: `当前¥${w.balance}低于阈值`.slice(0, 20),
        relatedId: w.shop_id,
      },
      process.env.WX_APPID,
      process.env.WX_SECRET
    );
    await pool.execute(
      'UPDATE merchant_commission_wallets SET low_balance_notified_at = NOW() WHERE shop_id = ?',
      [w.shop_id]
    );
  }
  return { scanned: wallets.length };
}

/** 开发环境：人工加余额 */
async function devCreditWallet(pool, shopId, amountYuan) {
  if (process.env.NODE_ENV === 'production') {
    return { success: false, error: '禁止', statusCode: 403 };
  }
  const y = roundMoney(amountYuan);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await ensureWallet(conn, shopId);
    const [[w]] = await conn.execute(
      'SELECT balance FROM merchant_commission_wallets WHERE shop_id = ? FOR UPDATE',
      [shopId]
    );
    const newBal = roundMoney((parseFloat(w.balance) || 0) + y);
    const ledgerId = genId('MCL');
    await conn.execute(
      'UPDATE merchant_commission_wallets SET balance = ?, updated_at = NOW() WHERE shop_id = ?',
      [newBal, shopId]
    );
    await conn.execute(
      `INSERT INTO merchant_commission_ledger (ledger_id, shop_id, type, amount, balance_after, remark)
       VALUES (?, ?, 'recharge', ?, ?, ?)`,
      [ledgerId, shopId, y, newBal, 'dev_credit']
    );
    await conn.commit();
    return { success: true, data: { balance: newBal } };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  afterOrderCompleted,
  getWallet,
  setDeductMode,
  listLedger,
  createRechargePrepay,
  createOrderCommissionPrepay,
  handleWechatPayNotify,
  finalizeCommissionProof,
  requestRefund,
  scanLowBalanceWallets,
  devCreditWallet,
  getPrimaryMerchantId,
};
