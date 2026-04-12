/**
 * 服务商标品货款：支付成功后入账可提现余额（与佣金钱包 balance 分离）
 */

const crypto = require('crypto');

function genLedgerId() {
  return 'SIL' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex').slice(0, 8);
}

function roundMoney(y) {
  return Math.round(parseFloat(y) * 100) / 100;
}

/** 生产库若未跑 20260325，ledger 表无 order_id 列 */
function isMissingOrderIdColumnError(err) {
  const msg = String(err && (err.sqlMessage || err.message) || '');
  return (
    (err && (err.code === 'ER_BAD_FIELD_ERROR' || err.errno === 1054))
    && msg.includes('order_id')
  );
}

async function getSetting(connOrPool, key, def) {
  const exec = connOrPool.execute.bind(connOrPool);
  try {
    const [rows] = await exec('SELECT `value` FROM settings WHERE `key` = ?', [key]);
    if (rows.length) return String(rows[0].value);
  } catch (_) {}
  return def;
}

async function getProductOrderPlatformFeeRate(connOrPool) {
  const raw = await getSetting(connOrPool, 'product_order_platform_fee_rate', '0');
  const r = parseFloat(raw);
  if (!Number.isFinite(r) || r < 0) return 0;
  if (r > 1) return 1;
  return r;
}

async function ensureIncomeWallet(conn, shopId) {
  await conn.execute(
    `INSERT INTO merchant_commission_wallets (shop_id) VALUES (?) ON DUPLICATE KEY UPDATE shop_id = shop_id`,
    [shopId]
  );
}

/**
 * 在已持有订单行锁的事务内调用：将已支付订单货款记入店铺 income_balance（幂等）
 * @param {import('mysql2/promise').PoolConnection} conn
 * @param {string} productOrderId
 */
async function settlePaidProductOrder(conn, productOrderId) {
  const [[po]] = await conn.execute(
    `SELECT * FROM product_orders WHERE product_order_id = ? FOR UPDATE`,
    [productOrderId]
  );
  if (!po) return { skipped: true, reason: 'not_found' };
  if (po.payment_status !== 'paid') return { skipped: true, reason: 'not_paid' };
  if (po.settlement_status === 'settled') return { skipped: true, reason: 'already_settled' };

  const amountTotal = roundMoney(po.amount_total);
  const rate = await getProductOrderPlatformFeeRate(conn);
  const platformFee = roundMoney(amountTotal * rate);
  const shopSettle = roundMoney(amountTotal - platformFee);

  await ensureIncomeWallet(conn, po.shop_id);

  const [[w]] = await conn.execute(
    `SELECT income_balance, income_frozen FROM merchant_commission_wallets WHERE shop_id = ? FOR UPDATE`,
    [po.shop_id]
  );
  const prevBal = roundMoney(w.income_balance || 0);
  const newBal = roundMoney(prevBal + Math.max(0, shopSettle));

  if (shopSettle > 0) {
    await conn.execute(
      `UPDATE merchant_commission_wallets SET income_balance = income_balance + ?, updated_at = NOW() WHERE shop_id = ?`,
      [shopSettle, po.shop_id]
    );
    const ledgerId = genLedgerId();
    await conn.execute(
      `INSERT INTO merchant_shop_income_ledger
       (ledger_id, shop_id, type, amount, balance_after, product_order_id, remark)
       VALUES (?, ?, 'product_order_settle', ?, ?, ?, ?)`,
      [ledgerId, po.shop_id, shopSettle, newBal, po.product_order_id, `标品订单入账 ${po.product_order_id}`]
    );
  }

  await conn.execute(
    `UPDATE product_orders SET platform_fee_yuan = ?, shop_settle_yuan = ?, settlement_status = 'settled', settled_at = NOW()
     WHERE product_order_id = ?`,
    [platformFee, shopSettle, po.product_order_id]
  );

  return { ok: true, shop_settle_yuan: shopSettle, platform_fee_yuan: platformFee };
}

/**
 * 车主已支付维修款（自费单）：余款记入 income_balance，幂等（依赖 orders.repair_payment_status）
 * @param {import('mysql2/promise').PoolConnection} conn
 * @param {string} orderId
 * @param {{ wx_transaction_id?: string }} [opts]
 */
async function settlePaidRepairOrder(conn, orderId, opts = {}) {
  const [[ord]] = await conn.execute(
    `SELECT order_id, shop_id, user_id, actual_amount, commission_final, commission, repair_payment_status, is_insurance_accident
     FROM orders WHERE order_id = ? FOR UPDATE`,
    [orderId]
  );
  if (!ord) return { skipped: true, reason: 'not_found' };
  if (ord.is_insurance_accident === 1 || ord.is_insurance_accident === '1') {
    return { skipped: true, reason: 'insurance_order' };
  }
  if (ord.repair_payment_status === 'paid') return { skipped: true, reason: 'already_paid' };

  const amountTotal = roundMoney(ord.actual_amount);
  const commissionFinal = roundMoney(ord.commission_final != null ? ord.commission_final : ord.commission || 0);
  if (amountTotal < 0.01) return { skipped: true, reason: 'bad_amount' };

  const shopSettle = roundMoney(amountTotal - commissionFinal);
  if (shopSettle < -1e-6) return { skipped: true, reason: 'negative_shop_settle' };

  await ensureIncomeWallet(conn, ord.shop_id);

  const [[w]] = await conn.execute(
    `SELECT income_balance, income_frozen FROM merchant_commission_wallets WHERE shop_id = ? FOR UPDATE`,
    [ord.shop_id]
  );
  const prevBal = roundMoney(w.income_balance || 0);
  const newBal = roundMoney(prevBal + Math.max(0, shopSettle));

  if (shopSettle > 0) {
    await conn.execute(
      `UPDATE merchant_commission_wallets SET income_balance = income_balance + ?, updated_at = NOW() WHERE shop_id = ?`,
      [shopSettle, ord.shop_id]
    );
    const ledgerId = genLedgerId();
    const remark = `维修单自费入账 ${ord.order_id}`;
    try {
      await conn.execute(
        `INSERT INTO merchant_shop_income_ledger
         (ledger_id, shop_id, type, amount, balance_after, product_order_id, order_id, remark)
         VALUES (?, ?, 'repair_order_settle', ?, ?, NULL, ?, ?)`,
        [ledgerId, ord.shop_id, shopSettle, newBal, ord.order_id, remark]
      );
    } catch (e) {
      if (isMissingOrderIdColumnError(e)) {
        await conn.execute(
          `INSERT INTO merchant_shop_income_ledger
           (ledger_id, shop_id, type, amount, balance_after, product_order_id, remark)
           VALUES (?, ?, 'repair_order_settle', ?, ?, NULL, ?)`,
          [ledgerId, ord.shop_id, shopSettle, newBal, remark]
        );
      } else {
        throw e;
      }
    }
  }

  await conn.execute(
    `UPDATE orders SET repair_payment_status = 'paid', commission_status = 'finalized',
         commission_paid_amount = ?, updated_at = NOW() WHERE order_id = ?`,
    [commissionFinal, ord.order_id]
  );

  return {
    ok: true,
    shop_settle_yuan: Math.max(0, shopSettle),
    platform_fee_yuan: commissionFinal,
  };
}

async function listIncomeLedger(pool, shopId, { page = 1, limit = 20 } = {}) {
  const off = (Math.max(1, page) - 1) * Math.min(100, Math.max(1, limit));
  const lim = Math.min(100, Math.max(1, limit));
  const sqlFull =
    `SELECT ledger_id, type, amount, balance_after, product_order_id, order_id, withdraw_id, remark, created_at
     FROM merchant_shop_income_ledger WHERE shop_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`;
  const sqlLegacy =
    `SELECT ledger_id, type, amount, balance_after, product_order_id, withdraw_id, remark, created_at
     FROM merchant_shop_income_ledger WHERE shop_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`;
  let rows;
  try {
    [rows] = await pool.execute(sqlFull, [shopId, lim, off]);
  } catch (e) {
    if (isMissingOrderIdColumnError(e)) {
      [rows] = await pool.execute(sqlLegacy, [shopId, lim, off]);
      rows = rows.map((r) => ({ ...r, order_id: null }));
    } else {
      throw e;
    }
  }
  const [[{ c }]] = await pool.execute(
    'SELECT COUNT(*) as c FROM merchant_shop_income_ledger WHERE shop_id = ?',
    [shopId]
  );
  return { list: rows, total: c };
}

module.exports = {
  getProductOrderPlatformFeeRate,
  settlePaidProductOrder,
  settlePaidRepairOrder,
  listIncomeLedger,
};
