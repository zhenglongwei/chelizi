/**
 * 服务商标品货款提现：商家转账到零钱（用户确认模式），与车主奖励金提现共用微信支付能力、独立回调与单据表
 */

const crypto = require('crypto');
const wechatPay = require('./wechat-pay-service');
const rewardTransferService = require('./reward-transfer-service');
const merchantCorpIncomeWithdrawService = require('./merchant-corp-income-withdraw-service');

function publicBaseUrl() {
  const raw = process.env.PUBLIC_API_BASE_URL || process.env.BASE_URL || '';
  return String(raw).replace(/\/$/, '');
}

function merchantIncomeTransferNotifyUrl() {
  const full = process.env.WECHAT_MERCHANT_INCOME_TRANSFER_NOTIFY_URL;
  if (full && String(full).trim()) return String(full).trim().replace(/\/$/, '');
  const base = publicBaseUrl();
  if (!base) return '';
  return `${base}/api/v1/pay/wechat/merchant-income-transfer-notify`;
}

function canUseMerchantIncomeTransfer() {
  if (process.env.DISABLE_WX_MERCHANT_INCOME_TRANSFER === '1') return false;
  return wechatPay.isTransferBillConfigured() && !!merchantIncomeTransferNotifyUrl();
}

function yuanToFen(y) {
  return Math.max(1, Math.round(parseFloat(y) * 100));
}

function genWithdrawId() {
  const base = `MI${Date.now()}`;
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

function normalizeRealName(s) {
  return String(s || '')
    .trim()
    .replace(/\s+/g, '');
}

function validateRealName(name) {
  const n = normalizeRealName(name);
  if (n.length < 2 || n.length > 32) return { ok: false, message: '请输入 2～32 个字符的真实姓名' };
  const chinese = /^[\u4e00-\u9fa5·.．]{2,32}$/.test(n);
  const latin = /^[a-zA-Z][a-zA-Z·.]{1,31}$/.test(n);
  if (!chinese && !latin) {
    return { ok: false, message: '姓名格式不正确，请与微信实名一致' };
  }
  return { ok: true, value: n };
}

function validateIdCard(s) {
  const t = String(s || '').trim();
  if (!t) return { ok: true, value: null };
  if (/^\d{15}$/.test(t) || /^\d{17}[\dXx]$/.test(t)) return { ok: true, value: t.toUpperCase() };
  return { ok: false, message: '身份证号格式不正确' };
}

function nameRequiredFen() {
  return rewardTransferService.nameRequiredFen();
}

function requireIdCardForWithdraw() {
  return process.env.WECHAT_TRANSFER_REQUIRE_ID_CARD === '1';
}

function merchantIncomeSceneReportInfos() {
  return [
    {
      info_type: '活动名称',
      info_content: String(process.env.WECHAT_MERCHANT_INCOME_SCENE_ACTIVITY || '辙见标品货款').slice(0, 32),
    },
    {
      info_type: '奖励说明',
      info_content: String(process.env.WECHAT_MERCHANT_INCOME_SCENE_DESC || '店铺服务收款提现').slice(0, 32),
    },
  ];
}

function isTransferBillNotFoundError(err) {
  if (!err) return false;
  if (err.status === 404) return true;
  const msg = String(err.message || '');
  if (/记录不存在|该单不存在|订单不存在/i.test(msg)) return true;
  const d = err.detail;
  if (d && typeof d === 'object') {
    const code = String(d.code || d.error_code || '');
    if (/NOT_EXIST|NOT_FOUND|RESOURCE_NOT/i.test(code)) return true;
  }
  return false;
}

async function applyMerchantIncomeTransferOutcome(pool, p) {
  const outBillNo = p.out_bill_no;
  const state = p.state;
  const transferBillNo = p.transfer_bill_no;
  const transferAmount = Number(p.transfer_amount);
  const failReason = p.fail_reason || '';

  if (!outBillNo) throw new Error('缺少 out_bill_no');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      'SELECT * FROM merchant_income_withdrawals WHERE withdraw_id = ? FOR UPDATE',
      [outBillNo]
    );
    if (rows.length === 0) {
      await conn.commit();
      return { unknown: true };
    }
    const w = rows[0];
    const expectedFen = yuanToFen(w.amount);
    if (Number.isFinite(transferAmount) && transferAmount !== expectedFen) {
      console.error('[merchant-income-transfer] amount mismatch', outBillNo, transferAmount, expectedFen);
    }

    if (state === 'SUCCESS') {
      if (w.status === 1) {
        await conn.commit();
        return { duplicate: true };
      }
      if (w.status !== 0) {
        await conn.commit();
        return { ignored: true };
      }
      const amt = roundMoney(w.amount);
      const [upd] = await conn.execute(
        `UPDATE merchant_income_withdrawals SET status = 1, wx_transfer_bill_no = COALESCE(?, wx_transfer_bill_no),
         wx_bill_state = ?, wx_package_info = NULL, remark = NULL, processed_at = NOW()
         WHERE withdraw_id = ? AND status = 0`,
        [transferBillNo || null, state, outBillNo]
      );
      if (upd.affectedRows > 0) {
        await conn.execute(
          `UPDATE merchant_commission_wallets SET income_frozen = income_frozen - ?, updated_at = NOW()
           WHERE shop_id = ? AND income_frozen + 1e-6 >= ?`,
          [amt, w.shop_id, amt]
        );
        const [[wal]] = await conn.execute(
          'SELECT income_balance FROM merchant_commission_wallets WHERE shop_id = ?',
          [w.shop_id]
        );
        const balAfter = roundMoney(wal?.income_balance || 0);
        const lid = genLedgerId();
        await conn.execute(
          `INSERT INTO merchant_shop_income_ledger
           (ledger_id, shop_id, type, amount, balance_after, withdraw_id, remark)
           VALUES (?, ?, 'withdraw_payout', ?, ?, ?, ?)`,
          [lid, w.shop_id, -amt, balAfter, outBillNo, '货款提现至微信零钱']
        );
      }
      await conn.commit();
      return { success: true };
    }

    if (state === 'FAIL' || state === 'CANCELLED') {
      if (w.status === 1) {
        await conn.commit();
        return { duplicate: true };
      }
      if (w.status !== 0) {
        await conn.commit();
        return { ignored: true };
      }
      const amt = roundMoney(w.amount);
      const newStatus = state === 'CANCELLED' ? 3 : 2;
      await conn.execute(
        `UPDATE merchant_commission_wallets SET income_balance = income_balance + ?, income_frozen = income_frozen - ?,
         updated_at = NOW() WHERE shop_id = ? AND income_frozen + 1e-6 >= ?`,
        [amt, amt, w.shop_id, amt]
      );
      const [[wal]] = await conn.execute(
        'SELECT income_balance FROM merchant_commission_wallets WHERE shop_id = ?',
        [w.shop_id]
      );
      const balAfter = roundMoney(wal?.income_balance || 0);
      const lid = genLedgerId();
      await conn.execute(
        `INSERT INTO merchant_shop_income_ledger
         (ledger_id, shop_id, type, amount, balance_after, withdraw_id, remark)
         VALUES (?, ?, 'withdraw_refund', ?, ?, ?, ?)`,
        [lid, w.shop_id, amt, balAfter, outBillNo, `提现失败退回: ${String(failReason || state).slice(0, 120)}`]
      );
      await conn.execute(
        `UPDATE merchant_income_withdrawals SET status = ?, wx_transfer_bill_no = COALESCE(?, wx_transfer_bill_no),
         wx_bill_state = ?, wx_package_info = NULL, remark = ?, processed_at = NOW()
         WHERE withdraw_id = ? AND status = 0`,
        [newStatus, transferBillNo || null, state, String(failReason || state).slice(0, 200), outBillNo]
      );
      await conn.commit();
      return { refunded: true, state };
    }

    await conn.commit();
    return { ignored: true, state };
  } catch (e) {
    try {
      await conn.rollback();
    } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

async function syncMerchantIncomeWithdrawWithWechat(pool, withdrawId) {
  const [rows] = await pool.execute('SELECT status FROM merchant_income_withdrawals WHERE withdraw_id = ?', [
    withdrawId,
  ]);
  if (!rows.length || rows[0].status !== 0) return null;
  try {
    const bill = await wechatPay.getTransferBillByOutNo(withdrawId);
    if (bill && ['SUCCESS', 'FAIL', 'CANCELLED'].includes(bill.state)) {
      await applyMerchantIncomeTransferOutcome(pool, bill);
    } else if (bill && bill.transfer_bill_no) {
      await pool.execute(
        `UPDATE merchant_income_withdrawals SET wx_transfer_bill_no = COALESCE(?, wx_transfer_bill_no), wx_bill_state = ?
         WHERE withdraw_id = ? AND status = 0`,
        [bill.transfer_bill_no, bill.state, withdrawId]
      );
    }
    return bill;
  } catch (e) {
    console.error('[merchant-income-transfer] getTransferBill failed', withdrawId, e.message);
    if (isTransferBillNotFoundError(e)) {
      await voidStalePendingMerchantIncomeWithdraw(pool, withdrawId, '微信无此单号，已退回货款余额');
    }
    return null;
  }
}

async function voidStalePendingMerchantIncomeWithdraw(pool, withdrawId, reason) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      'SELECT * FROM merchant_income_withdrawals WHERE withdraw_id = ? FOR UPDATE',
      [withdrawId]
    );
    if (rows.length === 0 || rows[0].status !== 0) {
      await conn.commit();
      return { skipped: true };
    }
    const w = rows[0];
    const amt = roundMoney(w.amount);
    await conn.execute(
      `UPDATE merchant_commission_wallets SET income_balance = income_balance + ?, income_frozen = income_frozen - ?,
       updated_at = NOW() WHERE shop_id = ? AND income_frozen + 1e-6 >= ?`,
      [amt, amt, w.shop_id, amt]
    );
    await conn.execute(
      `UPDATE merchant_income_withdrawals SET status = 2, wx_package_info = NULL, remark = ?, processed_at = NOW()
       WHERE withdraw_id = ? AND status = 0`,
      [String(reason || '已退回').slice(0, 200), withdrawId]
    );
    await conn.commit();
    return { refunded: true };
  } catch (e) {
    try {
      await conn.rollback();
    } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

function buildResumePayload(w, openid, action) {
  return {
    mode: 'wechat',
    action,
    withdraw_id: w.withdraw_id,
    amount: Number(w.amount),
    package_info: w.wx_package_info || null,
    mch_id: process.env.WECHAT_PAY_MCHID,
    app_id: process.env.WX_APPID,
    openid: openid || '',
    state: w.wx_bill_state,
  };
}

async function resolveOrResumePendingMerchantIncomeWithdraw(pool, shopId) {
  if (await merchantCorpIncomeWithdrawService.hasPendingCorpIncomeWithdrawal(pool, shopId)) {
    const err = new Error('您有待财务处理的对公提现，请完成或撤销后再发起微信提现');
    err.code = 'CONFLICT';
    throw err;
  }
  if (!canUseMerchantIncomeTransfer()) {
    const [p] = await pool.execute(
      'SELECT withdraw_id FROM merchant_income_withdrawals WHERE shop_id = ? AND status = 0 LIMIT 1',
      [shopId]
    );
    if (p.length) {
      const err = new Error('您有一笔处理中的提现，请稍后再试');
      err.code = 'CONFLICT';
      throw err;
    }
    return null;
  }

  for (let guard = 0; guard < 24; guard++) {
    const [p] = await pool.execute(
      'SELECT * FROM merchant_income_withdrawals WHERE shop_id = ? AND status = 0 ORDER BY id DESC LIMIT 1',
      [shopId]
    );
    if (!p.length) return null;
    const w = p[0];
    await syncMerchantIncomeWithdrawWithWechat(pool, w.withdraw_id);
    const [chk] = await pool.execute('SELECT * FROM merchant_income_withdrawals WHERE withdraw_id = ?', [
      w.withdraw_id,
    ]);
    if (chk[0].status !== 0) continue;
    const [mu] = await pool.execute(
      'SELECT openid FROM merchant_users WHERE shop_id = ? AND status = 1 ORDER BY id ASC LIMIT 1',
      [shopId]
    );
    const openid = mu[0] && mu[0].openid;
    const row = chk[0];
    const payload = buildResumePayload(row, openid, 'resume_pending');
    if (!payload.package_info) {
      payload.warning = 'no_package';
      payload.hint = '领取会话已失效，请取消待确认提现后重新发起';
    }
    return payload;
  }
  return null;
}

/**
 * @param {object} kyc { realName, idCardNo? }
 */
async function submitMerchantIncomeWithdraw(pool, shopId, merchantId, amount, kyc = {}) {
  const amt = parseFloat(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    const err = new Error('提现金额须大于0');
    err.code = 'VALIDATION';
    throw err;
  }

  const { min, maxDay } = await getWithdrawBounds(pool);
  if (amt < min) {
    const err = new Error(`提现金额不能少于 ${min} 元`);
    err.code = 'VALIDATION';
    throw err;
  }

  if (!canUseMerchantIncomeTransfer()) {
    const err = new Error('货款提现服务未就绪：需配置微信商家转账与公网回调（PUBLIC_API_BASE_URL）');
    err.code = 'VALIDATION';
    err.status = 503;
    throw err;
  }

  const resume = await resolveOrResumePendingMerchantIncomeWithdraw(pool, shopId);
  if (resume) return resume;

  await merchantCorpIncomeWithdrawService.assertNoPendingCorpForWechat(pool, shopId);

  const transferAmountFen = yuanToFen(amt);
  const needEncryptName = transferAmountFen >= nameRequiredFen();

  let normalizedName = '';
  let idCardClean = null;
  const realNameRaw = kyc.realName;
  const idCardRaw = kyc.idCardNo;

  if (needEncryptName) {
    const nv = validateRealName(realNameRaw);
    if (!nv.ok) {
      const err = new Error(nv.message);
      err.code = 'VALIDATION';
      throw err;
    }
    normalizedName = nv.value;
  } else if (String(realNameRaw || '').trim()) {
    const nv = validateRealName(String(realNameRaw).trim());
    if (!nv.ok) {
      const err = new Error(nv.message);
      err.code = 'VALIDATION';
      throw err;
    }
    normalizedName = nv.value;
  }
  if (requireIdCardForWithdraw()) {
    const iv = validateIdCard(idCardRaw);
    if (!iv.ok || !iv.value) {
      const err = new Error(iv.ok ? '请填写身份证号' : iv.message);
      err.code = 'VALIDATION';
      throw err;
    }
    idCardClean = iv.value;
  } else if (idCardRaw && String(idCardRaw).trim()) {
    const iv = validateIdCard(idCardRaw);
    if (!iv.ok) {
      const err = new Error(iv.message);
      err.code = 'VALIDATION';
      throw err;
    }
    idCardClean = iv.value;
  }

  const [mus] = await pool.execute(
    'SELECT openid FROM merchant_users WHERE merchant_id = ? AND shop_id = ? AND status = 1',
    [merchantId, shopId]
  );
  if (!mus.length) {
    const err = new Error('服务商账号异常');
    err.code = 'VALIDATION';
    throw err;
  }
  const openid = mus[0].openid;
  if (!openid) {
    const err = new Error('请在工作台绑定微信后再提现');
    err.code = 'VALIDATION';
    throw err;
  }

  const notifyUrl = merchantIncomeTransferNotifyUrl();
  if (!notifyUrl) {
    const err = new Error('未配置货款提现回调域名');
    err.code = 'VALIDATION';
    throw err;
  }

  const already = await merchantCorpIncomeWithdrawService.sumTodayShopIncomeWithdrawalsYuan(pool, shopId);
  if (already + amt > maxDay) {
    const err = new Error(`单日提现累计不能超过 ${maxDay} 元`);
    err.code = 'VALIDATION';
    throw err;
  }

  const withdrawId = genWithdrawId();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[wal]] = await conn.execute(
      `SELECT income_balance, income_frozen FROM merchant_commission_wallets WHERE shop_id = ? FOR UPDATE`,
      [shopId]
    );
    if (!wal || roundMoney(wal.income_balance) < amt - 1e-6) {
      await conn.rollback();
      const err = new Error('可提现货款余额不足');
      err.code = 'VALIDATION';
      throw err;
    }
    await conn.execute(
      `UPDATE merchant_commission_wallets SET income_balance = income_balance - ?, income_frozen = income_frozen + ?,
       updated_at = NOW() WHERE shop_id = ? AND income_balance + 1e-6 >= ?`,
      [amt, amt, shopId, amt]
    );
    await conn.execute(
      `INSERT INTO merchant_income_withdrawals (withdraw_id, shop_id, merchant_id, amount, status, created_at)
       VALUES (?, ?, ?, ?, 0, NOW())`,
      [withdrawId, shopId, merchantId, amt]
    );
    await conn.commit();
  } catch (e) {
    try {
      await conn.rollback();
    } catch (_) {}
    conn.release();
    throw e;
  }
  conn.release();

  let wxRes;
  try {
    wxRes = await wechatPay.createTransferBill({
      outBillNo: withdrawId,
      openid,
      transferAmountFen,
      notifyUrl,
      transferRemark: process.env.WECHAT_MERCHANT_INCOME_TRANSFER_REMARK || '标品货款提现',
      userRecvPerception: process.env.WECHAT_MERCHANT_INCOME_USER_RECV || '商户收款',
      transferSceneId: process.env.WECHAT_MERCHANT_INCOME_SCENE_ID || process.env.WECHAT_TRANSFER_SCENE_ID || '1000',
      transferSceneReportInfos: merchantIncomeSceneReportInfos(),
      userNamePlain: needEncryptName ? normalizedName : undefined,
    });
  } catch (wxErr) {
    console.error('[merchant-income-transfer] createTransferBill failed:', wxErr.message, wxErr.detail);
    await pool.execute(
      `UPDATE merchant_commission_wallets SET income_balance = income_balance + ?, income_frozen = income_frozen - ?,
       updated_at = NOW() WHERE shop_id = ?`,
      [amt, amt, shopId]
    );
    await pool.execute(
      `UPDATE merchant_income_withdrawals SET status = 2, remark = ?, processed_at = NOW() WHERE withdraw_id = ?`,
      [String(wxErr.message || '微信下单失败').slice(0, 200), withdrawId]
    );
    throw wxErr;
  }

  const wxState = wxRes.state || '';
  const packageInfo = wxRes.package_info;
  const transferBillNo = wxRes.transfer_bill_no || null;

  if (!packageInfo || wxState === 'FAIL') {
    const reason = wxRes.fail_reason || '未返回领取包';
    await pool.execute(
      `UPDATE merchant_commission_wallets SET income_balance = income_balance + ?, income_frozen = income_frozen - ?,
       updated_at = NOW() WHERE shop_id = ?`,
      [amt, amt, shopId]
    );
    await pool.execute(
      `UPDATE merchant_income_withdrawals SET status = 2, wx_transfer_bill_no = ?, wx_bill_state = ?, remark = ?, processed_at = NOW()
       WHERE withdraw_id = ?`,
      [transferBillNo, wxState, String(reason).slice(0, 200), withdrawId]
    );
    const err = new Error(reason);
    err.detail = wxRes;
    throw err;
  }

  await pool.execute(
    `UPDATE merchant_income_withdrawals SET wx_transfer_bill_no = ?, wx_bill_state = ?, wx_package_info = ? WHERE withdraw_id = ?`,
    [transferBillNo, wxState, packageInfo, withdrawId]
  );

  return {
    mode: 'wechat',
    action: 'new',
    withdraw_id: withdrawId,
    package_info: packageInfo,
    mch_id: process.env.WECHAT_PAY_MCHID,
    app_id: process.env.WX_APPID,
    openid,
    state: wxState,
    amount: amt,
  };
}

async function handleMerchantIncomeTransferNotify(pool, rawBody, headers) {
  if (!wechatPay.verifyNotifySignature(headers, rawBody)) {
    throw new Error('转账通知验签失败');
  }
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    throw new Error('转账通知 JSON 无效');
  }
  if (body.event_type !== 'MCHTRANSFER.BILL.FINISHED') {
    return { skipped: true };
  }
  if (!body.resource) {
    throw new Error('转账通知缺少 resource');
  }
  const plain = wechatPay.decryptNotifyResource(body.resource);
  if (!plain.out_bill_no) {
    throw new Error('转账通知缺少 out_bill_no');
  }
  if (!String(plain.out_bill_no).startsWith('MI')) {
    return { skipped: true, reason: 'not_merchant_income' };
  }
  return applyMerchantIncomeTransferOutcome(pool, plain);
}

async function reconcileMerchantIncomeWithdraw(pool, shopId, merchantId, withdrawId) {
  const [p] = await pool.execute(
    withdrawId
      ? 'SELECT * FROM merchant_income_withdrawals WHERE shop_id = ? AND withdraw_id = ? AND merchant_id = ?'
      : 'SELECT * FROM merchant_income_withdrawals WHERE shop_id = ? AND merchant_id = ? AND status = 0 ORDER BY id DESC LIMIT 1',
    withdrawId ? [shopId, withdrawId, merchantId] : [shopId, merchantId]
  );
  if (!p.length) {
    return { withdrawal: null, openid: null, package_info: null, can_request_transfer: false };
  }
  const w = p[0];
  if (w.status === 0 && canUseMerchantIncomeTransfer()) {
    await syncMerchantIncomeWithdrawWithWechat(pool, w.withdraw_id);
  }
  const [w2] = await pool.execute('SELECT * FROM merchant_income_withdrawals WHERE withdraw_id = ?', [w.withdraw_id]);
  const row = w2[0];
  const [mu] = await pool.execute('SELECT openid FROM merchant_users WHERE merchant_id = ?', [merchantId]);
  const openid = mu[0] && mu[0].openid;
  return {
    withdrawal: row,
    openid,
    package_info: row.status === 0 ? row.wx_package_info : null,
    can_request_transfer: row.status === 0 && !!row.wx_package_info,
    mch_id: process.env.WECHAT_PAY_MCHID,
    app_id: process.env.WX_APPID,
  };
}

async function cancelPendingMerchantIncomeWithdraw(pool, shopId, merchantId, withdrawId) {
  if (!canUseMerchantIncomeTransfer()) {
    const err = new Error('当前未启用微信商家转账');
    err.code = 'VALIDATION';
    throw err;
  }
  const [p] = await pool.execute(
    withdrawId
      ? 'SELECT * FROM merchant_income_withdrawals WHERE shop_id = ? AND merchant_id = ? AND withdraw_id = ? AND status = 0'
      : 'SELECT * FROM merchant_income_withdrawals WHERE shop_id = ? AND merchant_id = ? AND status = 0 ORDER BY id DESC LIMIT 1',
    withdrawId ? [shopId, merchantId, withdrawId] : [shopId, merchantId]
  );
  if (!p.length) {
    const err = new Error('没有待撤销的提现');
    err.code = 'VALIDATION';
    throw err;
  }
  const w = p[0];
  await syncMerchantIncomeWithdrawWithWechat(pool, w.withdraw_id);
  const [w2] = await pool.execute('SELECT * FROM merchant_income_withdrawals WHERE withdraw_id = ?', [w.withdraw_id]);
  if (w2[0].status !== 0) {
    return { ok: true, already_done: true, withdrawal: w2[0] };
  }

  try {
    await wechatPay.cancelTransferBillByOutNo(w.withdraw_id);
  } catch (e) {
    console.error('[merchant-income-transfer] cancelTransferBill', w.withdraw_id, e.message);
    if (isTransferBillNotFoundError(e)) {
      await voidStalePendingMerchantIncomeWithdraw(pool, w.withdraw_id, '撤销时微信无此单，已退回余额');
    }
  }

  const [wAfter] = await pool.execute('SELECT * FROM merchant_income_withdrawals WHERE withdraw_id = ?', [w.withdraw_id]);
  if (!wAfter.length || wAfter[0].status !== 0) {
    return { ok: true, withdrawal: wAfter[0] || null };
  }

  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const bill = await wechatPay.getTransferBillByOutNo(w.withdraw_id).catch(() => null);
    if (bill && ['SUCCESS', 'FAIL', 'CANCELLED'].includes(bill.state)) {
      await applyMerchantIncomeTransferOutcome(pool, bill);
      const [w3] = await pool.execute('SELECT * FROM merchant_income_withdrawals WHERE withdraw_id = ?', [w.withdraw_id]);
      return { ok: true, withdrawal: w3[0], bill };
    }
  }

  await syncMerchantIncomeWithdrawWithWechat(pool, w.withdraw_id);
  const [w4] = await pool.execute('SELECT * FROM merchant_income_withdrawals WHERE withdraw_id = ?', [w.withdraw_id]);
  return {
    ok: w4[0].status !== 0,
    pending: w4[0].status === 0,
    withdrawal: w4[0],
    message: w4[0].status === 0 ? '撤销处理中，请稍后重试' : undefined,
  };
}

module.exports = {
  canUseMerchantIncomeTransfer,
  merchantIncomeTransferNotifyUrl,
  submitMerchantIncomeWithdraw,
  handleMerchantIncomeTransferNotify,
  reconcileMerchantIncomeWithdraw,
  cancelPendingMerchantIncomeWithdraw,
  syncMerchantIncomeWithdrawWithWechat,
};
