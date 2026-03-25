/**
 * 服务商标品货款对公提现：商户登记收款信息 → 财务线下打款 → 后台核销
 */

const crypto = require('crypto');

function genRequestId() {
  const base = `MC${Date.now()}`;
  const suffix = crypto.randomBytes(3).toString('hex');
  const id = base + suffix;
  return id.length <= 32 ? id : id.slice(0, 32);
}

function genLedgerId() {
  return 'SIL' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex').slice(0, 8);
}

function roundMoney(y) {
  return Math.round(parseFloat(y) * 100) / 100;
}

async function getSetting(pool, key, def) {
  try {
    const [rows] = await pool.execute('SELECT `value` FROM settings WHERE `key` = ?', [key]);
    if (rows.length) return String(rows[0].value);
  } catch (_) {}
  return def;
}

async function getWithdrawBounds(pool) {
  const min = parseFloat(await getSetting(pool, 'min_withdraw_amount', '10'));
  const max = parseFloat(await getSetting(pool, 'max_withdraw_amount', '5000'));
  return {
    min: Number.isFinite(min) && min > 0 ? min : 10,
    maxDay: Number.isFinite(max) && max > 0 ? max : 5000,
  };
}

async function hasPendingWechatIncomeWithdrawal(pool, shopId) {
  const [r] = await pool.execute(
    'SELECT 1 FROM merchant_income_withdrawals WHERE shop_id = ? AND status = 0 LIMIT 1',
    [shopId]
  );
  return r.length > 0;
}

async function hasPendingCorpIncomeWithdrawal(pool, shopId) {
  const [r] = await pool.execute(
    'SELECT 1 FROM merchant_income_corp_withdrawals WHERE shop_id = ? AND status = 0 LIMIT 1',
    [shopId]
  );
  return r.length > 0;
}

/** 微信 + 对公 当日已申请且未失败金额（status 0 待处理、1 成功计入） */
async function sumTodayShopIncomeWithdrawalsYuan(pool, shopId) {
  const [w] = await pool.execute(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM merchant_income_withdrawals
     WHERE shop_id = ? AND DATE(created_at) = CURDATE() AND status IN (0, 1)`,
    [shopId]
  );
  const [c] = await pool.execute(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM merchant_income_corp_withdrawals
     WHERE shop_id = ? AND DATE(created_at) = CURDATE() AND status IN (0, 1)`,
    [shopId]
  );
  return (parseFloat(w[0].s) || 0) + (parseFloat(c[0].s) || 0);
}

function maskAccount(no) {
  const s = String(no || '').replace(/\s/g, '');
  if (s.length <= 4) return '****';
  return '*'.repeat(Math.min(8, s.length - 4)) + s.slice(-4);
}

function validateBankAccount(no) {
  const s = String(no || '').replace(/\s/g, '');
  if (s.length < 6 || s.length > 32) return { ok: false, message: '银行账号长度须在 6～32 位' };
  if (!/^\d+$/.test(s)) return { ok: false, message: '银行账号仅支持数字' };
  return { ok: true, value: s };
}

/**
 * 供微信提现链路调用：存在待处理对公单则不可发起微信
 */
async function assertNoPendingCorpForWechat(pool, shopId) {
  if (await hasPendingCorpIncomeWithdrawal(pool, shopId)) {
    const err = new Error('您有一笔待财务处理的对公提现，请等待处理完成或撤销后再发起微信提现');
    err.code = 'CONFLICT';
    throw err;
  }
}

/**
 * 商户提交对公提现申请
 */
async function submitCorpWithdraw(pool, shopId, merchantId, body) {
  const amt = parseFloat(body.amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return { success: false, error: '提现金额须大于0', statusCode: 400 };
  }

  const { min, maxDay } = await getWithdrawBounds(pool);
  if (amt < min) {
    return { success: false, error: `提现金额不能少于 ${min} 元`, statusCode: 400 };
  }

  const companyName = String(body.company_name || '').trim();
  const bankName = String(body.bank_name || '').trim();
  const bankBranch = body.bank_branch != null ? String(body.bank_branch).trim() : '';
  const contactName = body.contact_name != null ? String(body.contact_name).trim() : '';
  const contactPhone = body.contact_phone != null ? String(body.contact_phone).trim() : '';
  const merchantRemark = body.merchant_remark != null ? String(body.merchant_remark).trim().slice(0, 500) : '';

  if (companyName.length < 2 || companyName.length > 200) {
    return { success: false, error: '请填写对公户名（2～200 字）', statusCode: 400 };
  }
  if (bankName.length < 2 || bankName.length > 200) {
    return { success: false, error: '请填写开户银行', statusCode: 400 };
  }
  const accV = validateBankAccount(body.bank_account_no);
  if (!accV.ok) {
    return { success: false, error: accV.message, statusCode: 400 };
  }

  if (await hasPendingWechatIncomeWithdrawal(pool, shopId)) {
    return {
      success: false,
      error: '您有一笔进行中的微信提现，请先完成确认或取消后再申请对公提现',
      statusCode: 409,
    };
  }
  if (await hasPendingCorpIncomeWithdrawal(pool, shopId)) {
    return { success: false, error: '您已有一笔待财务处理的对公提现申请', statusCode: 409 };
  }

  const already = await sumTodayShopIncomeWithdrawalsYuan(pool, shopId);
  if (already + amt > maxDay) {
    return { success: false, error: `单日提现累计不能超过 ${maxDay} 元`, statusCode: 400 };
  }

  const requestId = genRequestId();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[wal]] = await conn.execute(
      `SELECT income_balance, income_frozen FROM merchant_commission_wallets WHERE shop_id = ? FOR UPDATE`,
      [shopId]
    );
    if (!wal || roundMoney(wal.income_balance) < amt - 1e-6) {
      await conn.rollback();
      return { success: false, error: '可提现货款余额不足', statusCode: 400 };
    }
    await conn.execute(
      `UPDATE merchant_commission_wallets SET income_balance = income_balance - ?, income_frozen = income_frozen + ?,
       updated_at = NOW() WHERE shop_id = ? AND income_balance + 1e-6 >= ?`,
      [amt, amt, shopId, amt]
    );
    await conn.execute(
      `INSERT INTO merchant_income_corp_withdrawals (
        request_id, shop_id, merchant_id, amount, company_name, bank_name, bank_account_no, bank_branch,
        contact_name, contact_phone, merchant_remark, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NOW())`,
      [
        requestId,
        shopId,
        merchantId,
        amt,
        companyName,
        bankName,
        accV.value,
        bankBranch || null,
        contactName || null,
        contactPhone || null,
        merchantRemark || null,
      ]
    );
    await conn.commit();
  } catch (e) {
    try {
      await conn.rollback();
    } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }

  return {
    success: true,
    data: {
      request_id: requestId,
      amount: amt,
      message: '已提交对公提现申请，请等待财务打款',
    },
  };
}

async function listCorpWithdrawalsForMerchant(pool, shopId, { page = 1, limit = 20 } = {}) {
  const lim = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const off = (Math.max(1, parseInt(page, 10) || 1) - 1) * lim;
  const [rows] = await pool.execute(
    `SELECT request_id, amount, company_name, bank_name, bank_account_no, bank_branch, contact_name, contact_phone,
            merchant_remark, status, admin_remark, finance_ref, created_at, processed_at
     FROM merchant_income_corp_withdrawals WHERE shop_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
    [shopId, lim, off]
  );
  const [[{ c }]] = await pool.execute(
    'SELECT COUNT(*) AS c FROM merchant_income_corp_withdrawals WHERE shop_id = ?',
    [shopId]
  );
  return { list: rows, total: c };
}

async function cancelCorpWithdrawByMerchant(pool, shopId, merchantId, requestId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const sql = requestId
      ? 'SELECT * FROM merchant_income_corp_withdrawals WHERE request_id = ? AND shop_id = ? AND merchant_id = ? FOR UPDATE'
      : 'SELECT * FROM merchant_income_corp_withdrawals WHERE shop_id = ? AND merchant_id = ? AND status = 0 ORDER BY id DESC LIMIT 1 FOR UPDATE';
    const params = requestId ? [requestId, shopId, merchantId] : [shopId, merchantId];
    const [rows] = await conn.execute(sql, params);
    if (!rows.length) {
      await conn.rollback();
      return { success: false, error: '没有可撤销的待处理申请', statusCode: 404 };
    }
    const row = rows[0];
    if (row.status !== 0) {
      await conn.rollback();
      return { success: false, error: '仅待财务处理的申请可撤销', statusCode: 400 };
    }
    const amt = roundMoney(row.amount);
    await conn.execute(
      `UPDATE merchant_commission_wallets SET income_balance = income_balance + ?, income_frozen = income_frozen - ?,
       updated_at = NOW() WHERE shop_id = ? AND income_frozen + 1e-6 >= ?`,
      [amt, amt, shopId, amt]
    );
    const [[wal]] = await conn.execute(
      'SELECT income_balance FROM merchant_commission_wallets WHERE shop_id = ?',
      [shopId]
    );
    const balAfter = roundMoney(wal?.income_balance || 0);
    const lid = genLedgerId();
    await conn.execute(
      `INSERT INTO merchant_shop_income_ledger
       (ledger_id, shop_id, type, amount, balance_after, withdraw_id, remark)
       VALUES (?, ?, 'withdraw_refund', ?, ?, ?, ?)`,
      [lid, shopId, amt, balAfter, row.request_id, '撤销对公提现申请，余额退回']
    );
    await conn.execute(
      `UPDATE merchant_income_corp_withdrawals SET status = 3, admin_remark = '商户撤销', processed_at = NOW() WHERE request_id = ?`,
      [row.request_id]
    );
    await conn.commit();
    return { success: true, data: { request_id: row.request_id } };
  } catch (e) {
    try {
      await conn.rollback();
    } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

async function listCorpWithdrawalsForAdmin(pool, query) {
  const status = query.status;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const off = (page - 1) * limit;
  let where = '1=1';
  const params = [];
  if (status !== undefined && status !== '' && status !== 'all') {
    where += ' AND c.status = ?';
    params.push(parseInt(status, 10));
  }
  const [rows] = await pool.execute(
    `SELECT c.*, s.name AS shop_name
     FROM merchant_income_corp_withdrawals c
     JOIN shops s ON s.shop_id = c.shop_id
     WHERE ${where}
     ORDER BY c.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, off]
  );
  const [cntRows] = await pool.execute(
    `SELECT COUNT(*) AS c FROM merchant_income_corp_withdrawals c WHERE ${where}`,
    params
  );
  const list = rows.map((r) => ({
    ...r,
    bank_account_masked: maskAccount(r.bank_account_no),
  }));
  return {
    list,
    total: cntRows[0]?.c || 0,
    page,
    limit,
  };
}

async function completeCorpWithdrawByAdmin(pool, requestId, body, adminUserId) {
  const financeRef = body.finance_ref != null ? String(body.finance_ref).trim().slice(0, 128) : '';
  const adminRemark = body.admin_remark != null ? String(body.admin_remark).trim().slice(0, 500) : '';

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      'SELECT * FROM merchant_income_corp_withdrawals WHERE request_id = ? FOR UPDATE',
      [requestId]
    );
    if (!rows.length) {
      await conn.rollback();
      return { success: false, error: '申请不存在', statusCode: 404 };
    }
    const row = rows[0];
    if (row.status !== 0) {
      await conn.rollback();
      return { success: false, error: '仅待财务处理的申请可核销', statusCode: 400 };
    }
    const amt = roundMoney(row.amount);
    await conn.execute(
      `UPDATE merchant_commission_wallets SET income_frozen = income_frozen - ?, updated_at = NOW()
       WHERE shop_id = ? AND income_frozen + 1e-6 >= ?`,
      [amt, row.shop_id, amt]
    );
    const [[wal]] = await conn.execute(
      'SELECT income_balance FROM merchant_commission_wallets WHERE shop_id = ?',
      [row.shop_id]
    );
    const balAfter = roundMoney(wal?.income_balance || 0);
    const lid = genLedgerId();
    await conn.execute(
      `INSERT INTO merchant_shop_income_ledger
       (ledger_id, shop_id, type, amount, balance_after, withdraw_id, remark)
       VALUES (?, ?, 'withdraw_payout', ?, ?, ?, ?)`,
      [lid, row.shop_id, -amt, balAfter, requestId, `对公提现核销${financeRef ? `（${financeRef}）` : ''}`]
    );
    await conn.execute(
      `UPDATE merchant_income_corp_withdrawals SET status = 1, finance_ref = ?, admin_remark = ?,
       processed_by = ?, processed_at = NOW() WHERE request_id = ?`,
      [financeRef || null, adminRemark || null, adminUserId != null ? String(adminUserId) : null, requestId]
    );
    await conn.commit();
    return { success: true, data: { request_id: requestId } };
  } catch (e) {
    try {
      await conn.rollback();
    } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

async function rejectCorpWithdrawByAdmin(pool, requestId, body, adminUserId) {
  const reason = String(body.reason || body.admin_remark || '不符合打款要求').trim().slice(0, 500);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      'SELECT * FROM merchant_income_corp_withdrawals WHERE request_id = ? FOR UPDATE',
      [requestId]
    );
    if (!rows.length) {
      await conn.rollback();
      return { success: false, error: '申请不存在', statusCode: 404 };
    }
    const row = rows[0];
    if (row.status !== 0) {
      await conn.rollback();
      return { success: false, error: '仅待财务处理的申请可驳回', statusCode: 400 };
    }
    const amt = roundMoney(row.amount);
    await conn.execute(
      `UPDATE merchant_commission_wallets SET income_balance = income_balance + ?, income_frozen = income_frozen - ?,
       updated_at = NOW() WHERE shop_id = ? AND income_frozen + 1e-6 >= ?`,
      [amt, amt, row.shop_id, amt]
    );
    const [[wal]] = await conn.execute(
      'SELECT income_balance FROM merchant_commission_wallets WHERE shop_id = ?',
      [row.shop_id]
    );
    const balAfter = roundMoney(wal?.income_balance || 0);
    const lid = genLedgerId();
    await conn.execute(
      `INSERT INTO merchant_shop_income_ledger
       (ledger_id, shop_id, type, amount, balance_after, withdraw_id, remark)
       VALUES (?, ?, 'withdraw_refund', ?, ?, ?, ?)`,
      [lid, row.shop_id, amt, balAfter, requestId, `对公提现驳回: ${reason}`]
    );
    await conn.execute(
      `UPDATE merchant_income_corp_withdrawals SET status = 2, admin_remark = ?, processed_by = ?, processed_at = NOW()
       WHERE request_id = ?`,
      [reason, adminUserId != null ? String(adminUserId) : null, requestId]
    );
    await conn.commit();
    return { success: true, data: { request_id: requestId } };
  } catch (e) {
    try {
      await conn.rollback();
    } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  hasPendingCorpIncomeWithdrawal,
  hasPendingWechatIncomeWithdrawal,
  sumTodayShopIncomeWithdrawalsYuan,
  assertNoPendingCorpForWechat,
  submitCorpWithdraw,
  listCorpWithdrawalsForMerchant,
  cancelCorpWithdrawByMerchant,
  listCorpWithdrawalsForAdmin,
  completeCorpWithdrawByAdmin,
  rejectCorpWithdrawByAdmin,
};
