/**
 * 用户奖励金提现：商家转账到零钱（用户确认模式）+ 查询/撤销 + 回调
 */

const crypto = require('crypto');
const wechatPay = require('./wechat-pay-service');

function publicBaseUrl() {
  const raw = process.env.PUBLIC_API_BASE_URL || process.env.BASE_URL || '';
  return String(raw).replace(/\/$/, '');
}

function transferNotifyUrl() {
  const full = process.env.WECHAT_PAY_TRANSFER_NOTIFY_URL;
  if (full && String(full).trim()) return String(full).trim().replace(/\/$/, '');
  const base = publicBaseUrl();
  if (!base) return '';
  return `${base}/api/v1/pay/wechat/reward-transfer-notify`;
}

/** 单笔达到该金额（分）时向微信传加密 user_name，默认 2000 元 */
function nameRequiredFen() {
  const n = parseInt(process.env.WECHAT_TRANSFER_NAME_FEN_MIN || '200000', 10);
  return Number.isFinite(n) && n > 0 ? n : 200000;
}

function requireIdCardForWithdraw() {
  return process.env.WECHAT_TRANSFER_REQUIRE_ID_CARD === '1';
}

function defaultSceneReportInfos() {
  return [
    {
      info_type: '活动名称',
      info_content: String(process.env.WECHAT_TRANSFER_SCENE_ACTIVITY || '车厘子评价激励').slice(0, 32),
    },
    {
      info_type: '奖励说明',
      info_content: String(process.env.WECHAT_TRANSFER_SCENE_DESC || '用户奖励金提现').slice(0, 32),
    },
  ];
}

function yuanToFen(y) {
  return Math.max(1, Math.round(parseFloat(y) * 100));
}

function genWithdrawId() {
  const base = `W${Date.now()}`;
  const suffix = crypto.randomBytes(3).toString('hex');
  const id = base + suffix;
  return id.length <= 32 ? id : id.slice(0, 32);
}

function canUseWechatTransfer() {
  if (process.env.DISABLE_WX_REWARD_TRANSFER === '1') return false;
  return wechatPay.isTransferBillConfigured() && !!transferNotifyUrl();
}

/** 查询转账单时微信返回「无此单」（本地挂单与微信不一致，多为下单失败未回滚、或换过商户号） */
function isTransferBillNotFoundError(err) {
  if (!err) return false;
  if (err.status === 404) return true;
  const msg = String(err.message || '');
  if (/记录不存在|该单不存在|订单不存在/i.test(msg)) return true;
  const d = err.detail;
  if (d && typeof d === 'object') {
    const code = String(d.code || d.error_code || '');
    if (/NOT_EXIST|NOT_FOUND|RESOURCE_NOT/i.test(code)) return true;
    const dm = String(d.message || '');
    if (/记录不存在|该单不存在|订单不存在/i.test(dm)) return true;
  }
  return false;
}

/**
 * 微信侧查无此 out_bill_no：作废本地待确认单并退回余额（与 FAIL 回调等效，避免用户永远卡在 resume_pending）
 */
async function voidStalePendingWithdrawFromWechat(pool, withdrawId, reason) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      'SELECT * FROM withdrawals WHERE withdraw_id = ? FOR UPDATE',
      [withdrawId]
    );
    if (rows.length === 0 || rows[0].status !== 0) {
      await conn.commit();
      return { skipped: true };
    }
    const w = rows[0];
    await conn.execute(
      'UPDATE users SET balance = balance + ? WHERE user_id = ?',
      [w.amount, w.user_id]
    );
    await conn.execute(
      `UPDATE withdrawals SET status = 2, wx_transfer_bill_no = NULL, wx_bill_state = NULL, wx_package_info = NULL,
       remark = ?, processed_at = NOW() WHERE withdraw_id = ? AND status = 0`,
      [String(reason || '微信无此转账单，已退回余额').slice(0, 200), withdrawId]
    );
    await conn.commit();
    console.warn('[reward-transfer] void stale pending (WeChat has no bill)', withdrawId);
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

/**
 * 存在待处理提现时：先向微信同步；若仍为待确认则返回补拉数据，不重复扣款。
 */
async function resolveOrResumePendingWithdraw(pool, userId) {
  if (!canUseWechatTransfer()) {
    const [p] = await pool.execute(
      'SELECT withdraw_id FROM withdrawals WHERE user_id = ? AND status = 0 LIMIT 1',
      [userId]
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
      'SELECT * FROM withdrawals WHERE user_id = ? AND status = 0 ORDER BY id DESC LIMIT 1',
      [userId]
    );
    if (!p.length) return null;
    const w = p[0];
    await syncWithdrawalWithWechat(pool, w.withdraw_id);
    const [chk] = await pool.execute('SELECT * FROM withdrawals WHERE withdraw_id = ?', [w.withdraw_id]);
    if (chk[0].status !== 0) continue;
    const [u] = await pool.execute('SELECT openid FROM users WHERE user_id = ?', [userId]);
    const row = chk[0];
    const payload = buildResumePayload(row, u[0] && u[0].openid, 'resume_pending');
    if (!payload.package_info) {
      payload.action = 'resume_pending';
      payload.warning = 'no_package';
      payload.hint = '领取会话已失效，请使用「取消待确认提现」后重新发起';
    }
    return payload;
  }
  console.error('[reward-transfer] resolveOrResumePendingWithdraw guard limit', userId);
  return null;
}

async function syncWithdrawalWithWechat(pool, withdrawId) {
  const [rows] = await pool.execute('SELECT status FROM withdrawals WHERE withdraw_id = ?', [withdrawId]);
  if (!rows.length || rows[0].status !== 0) return null;
  try {
    const bill = await wechatPay.getTransferBillByOutNo(withdrawId);
    if (bill && ['SUCCESS', 'FAIL', 'CANCELLED'].includes(bill.state)) {
      await applyWechatTransferOutcome(pool, bill);
    } else if (bill && bill.transfer_bill_no) {
      await pool.execute(
        `UPDATE withdrawals SET wx_transfer_bill_no = COALESCE(?, wx_transfer_bill_no), wx_bill_state = ?
         WHERE withdraw_id = ? AND status = 0`,
        [bill.transfer_bill_no, bill.state, withdrawId]
      );
    }
    return bill;
  } catch (e) {
    console.error('[reward-transfer] getTransferBill failed', withdrawId, e.message);
    if (isTransferBillNotFoundError(e)) {
      try {
        await voidStalePendingWithdrawFromWechat(
          pool,
          withdrawId,
          '微信无此单号(查询记录不存在)，已退回余额'
        );
      } catch (voidErr) {
        console.error('[reward-transfer] voidStalePending failed', withdrawId, voidErr.message);
      }
    }
    return null;
  }
}

/**
 * 微信转账单终态落库（与回调解密后字段一致，查询单返回字段名相同）
 */
async function applyWechatTransferOutcome(pool, p) {
  const outBillNo = p.out_bill_no;
  const state = p.state;
  const transferBillNo = p.transfer_bill_no;
  const transferAmount = Number(p.transfer_amount);
  const failReason = p.fail_reason || '';

  if (!outBillNo) {
    throw new Error('缺少 out_bill_no');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      'SELECT * FROM withdrawals WHERE withdraw_id = ? FOR UPDATE',
      [outBillNo]
    );
    if (rows.length === 0) {
      await conn.commit();
      return { unknown: true };
    }
    const w = rows[0];
    const expectedFen = yuanToFen(w.amount);
    if (Number.isFinite(transferAmount) && transferAmount !== expectedFen) {
      console.error('[reward-transfer] amount mismatch', outBillNo, transferAmount, expectedFen);
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
      const [upd] = await conn.execute(
        `UPDATE withdrawals SET status = 1, wx_transfer_bill_no = COALESCE(?, wx_transfer_bill_no),
         wx_bill_state = ?, wx_package_info = NULL, processed_at = NOW(), remark = NULL
         WHERE withdraw_id = ? AND status = 0`,
        [transferBillNo || null, state, outBillNo]
      );
      if (upd.affectedRows > 0) {
        const txnId = 'TXN' + Date.now() + crypto.randomBytes(4).toString('hex');
        await conn.execute(
          `INSERT INTO transactions (transaction_id, user_id, type, amount, description, related_id, created_at)
           VALUES (?, ?, 'withdraw', ?, '提现至微信零钱', ?, NOW())`,
          [txnId, w.user_id, -Math.abs(parseFloat(w.amount)), outBillNo]
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
      const newStatus = state === 'CANCELLED' ? 3 : 2;
      await conn.execute(
        'UPDATE users SET balance = balance + ? WHERE user_id = ?',
        [w.amount, w.user_id]
      );
      await conn.execute(
        `UPDATE withdrawals SET status = ?, wx_transfer_bill_no = COALESCE(?, wx_transfer_bill_no),
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

/**
 * @param {{ realName: string, idCardNo?: string }} kyc
 * @returns {Promise<object>}
 */
async function submitUserWithdraw(pool, userId, amount, kyc = {}) {
  const amt = parseFloat(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    const err = new Error('提现金额须大于0');
    err.code = 'VALIDATION';
    throw err;
  }

  const useWx = canUseWechatTransfer();
  const resume = await resolveOrResumePendingWithdraw(pool, userId);
  if (resume) {
    return resume;
  }

  const transferAmountFen = yuanToFen(amt);
  const needEncryptName = useWx && transferAmountFen >= nameRequiredFen();

  const realNameRaw = kyc.realName;
  const idCardRaw = kyc.idCardNo;
  let normalizedName = '';
  let idCardClean = null;

  if (useWx) {
    if (needEncryptName) {
      const nv = validateRealName(realNameRaw);
      if (!nv.ok) {
        const err = new Error(nv.message);
        err.code = 'VALIDATION';
        throw err;
      }
      normalizedName = nv.value;
    } else {
      const raw = String(realNameRaw || '').trim();
      if (raw) {
        const nv = validateRealName(raw);
        if (!nv.ok) {
          const err = new Error(nv.message);
          err.code = 'VALIDATION';
          throw err;
        }
        normalizedName = nv.value;
      }
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
  }

  const [users] = await pool.execute(
    'SELECT balance, openid FROM users WHERE user_id = ?',
    [userId]
  );
  if (users.length === 0) {
    const err = new Error('用户不存在');
    err.code = 'VALIDATION';
    throw err;
  }
  const balance = parseFloat(users[0].balance);
  const openid = users[0].openid;
  if (balance < amt) {
    const err = new Error('余额不足');
    err.code = 'VALIDATION';
    throw err;
  }
  if (useWx && !openid) {
    const err = new Error('未绑定微信，无法提现');
    err.code = 'VALIDATION';
    throw err;
  }

  const [daySum] = await pool.execute(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM withdrawals
     WHERE user_id = ? AND DATE(created_at) = CURDATE() AND status IN (0, 1)`,
    [userId]
  );
  const already = parseFloat(daySum[0].s) || 0;
  if (already + amt > 5000) {
    const err = new Error('单日提现累计不能超过5000元');
    err.code = 'VALIDATION';
    throw err;
  }

  const withdrawId = genWithdrawId();
  const notifyUrl = transferNotifyUrl();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [u2] = await conn.execute(
      'SELECT balance FROM users WHERE user_id = ? FOR UPDATE',
      [userId]
    );
    if (u2.length === 0 || parseFloat(u2[0].balance) < amt) {
      await conn.rollback();
      const err = new Error('余额不足');
      err.code = 'VALIDATION';
      throw err;
    }

    await conn.execute(
      'UPDATE users SET balance = balance - ? WHERE user_id = ?',
      [amt, userId]
    );
    if (useWx && normalizedName) {
      if (idCardClean) {
        await conn.execute(
          'UPDATE users SET withdraw_real_name = ?, id_card_no = ? WHERE user_id = ?',
          [normalizedName, idCardClean, userId]
        );
      } else {
        await conn.execute('UPDATE users SET withdraw_real_name = ? WHERE user_id = ?', [
          normalizedName,
          userId,
        ]);
      }
    }
    await conn.execute(
      `INSERT INTO withdrawals (withdraw_id, user_id, amount, status, created_at)
       VALUES (?, ?, ?, 0, NOW())`,
      [withdrawId, userId, amt]
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

  if (!useWx) {
    return { mode: 'legacy', withdraw_id: withdrawId };
  }

  let wxRes;
  try {
    wxRes = await wechatPay.createTransferBill({
      outBillNo: withdrawId,
      openid,
      transferAmountFen,
      notifyUrl,
      transferRemark: process.env.WECHAT_TRANSFER_REMARK || '奖励金提现',
      userRecvPerception: process.env.WECHAT_TRANSFER_USER_RECV || '活动奖励',
      transferSceneId: process.env.WECHAT_TRANSFER_SCENE_ID || '1000',
      transferSceneReportInfos: defaultSceneReportInfos(),
      userNamePlain: needEncryptName ? normalizedName : undefined,
    });
  } catch (wxErr) {
    console.error('[reward-transfer] createTransferBill failed:', wxErr.message, wxErr.detail);
    await pool.execute(
      'UPDATE users SET balance = balance + ? WHERE user_id = ?',
      [amt, userId]
    );
    await pool.execute(
      `UPDATE withdrawals SET status = 2, remark = ?, processed_at = NOW() WHERE withdraw_id = ?`,
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
      'UPDATE users SET balance = balance + ? WHERE user_id = ?',
      [amt, userId]
    );
    await pool.execute(
      `UPDATE withdrawals SET status = 2, wx_transfer_bill_no = ?, wx_bill_state = ?, remark = ?, processed_at = NOW() WHERE withdraw_id = ?`,
      [transferBillNo, wxState, String(reason).slice(0, 200), withdrawId]
    );
    const err = new Error(reason);
    err.detail = wxRes;
    throw err;
  }

  await pool.execute(
    `UPDATE withdrawals SET wx_transfer_bill_no = ?, wx_bill_state = ?, wx_package_info = ? WHERE withdraw_id = ?`,
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

async function handleRewardTransferNotify(pool, rawBody, headers) {
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
  return applyWechatTransferOutcome(pool, plain);
}

async function reconcileUserWithdraw(pool, userId, withdrawId) {
  const [p] = await pool.execute(
    withdrawId
      ? 'SELECT * FROM withdrawals WHERE user_id = ? AND withdraw_id = ?'
      : 'SELECT * FROM withdrawals WHERE user_id = ? AND status = 0 ORDER BY id DESC LIMIT 1',
    withdrawId ? [userId, withdrawId] : [userId]
  );
  if (!p.length) {
    return { withdrawal: null, openid: null, package_info: null, can_request_transfer: false };
  }
  const w = p[0];
  if (w.status === 0 && canUseWechatTransfer()) {
    await syncWithdrawalWithWechat(pool, w.withdraw_id);
  }
  const [w2] = await pool.execute('SELECT * FROM withdrawals WHERE withdraw_id = ?', [w.withdraw_id]);
  const row = w2[0];
  const [u] = await pool.execute('SELECT openid FROM users WHERE user_id = ?', [userId]);
  const openid = u[0] && u[0].openid;
  return {
    withdrawal: row,
    openid,
    package_info: row.status === 0 ? row.wx_package_info : null,
    can_request_transfer: row.status === 0 && !!row.wx_package_info,
    mch_id: process.env.WECHAT_PAY_MCHID,
    app_id: process.env.WX_APPID,
  };
}

async function cancelPendingUserWithdraw(pool, userId, withdrawId) {
  if (!canUseWechatTransfer()) {
    const err = new Error('当前未启用微信商家转账');
    err.code = 'VALIDATION';
    throw err;
  }
  const [p] = await pool.execute(
    withdrawId
      ? 'SELECT * FROM withdrawals WHERE user_id = ? AND withdraw_id = ? AND status = 0'
      : 'SELECT * FROM withdrawals WHERE user_id = ? AND status = 0 ORDER BY id DESC LIMIT 1',
    withdrawId ? [userId, withdrawId] : [userId]
  );
  if (!p.length) {
    const err = new Error('没有待撤销的提现');
    err.code = 'VALIDATION';
    throw err;
  }
  const w = p[0];
  await syncWithdrawalWithWechat(pool, w.withdraw_id);
  const [w2] = await pool.execute('SELECT * FROM withdrawals WHERE withdraw_id = ?', [w.withdraw_id]);
  if (w2[0].status !== 0) {
    return { ok: true, already_done: true, withdrawal: w2[0] };
  }

  try {
    await wechatPay.cancelTransferBillByOutNo(w.withdraw_id);
  } catch (e) {
    console.error('[reward-transfer] cancelTransferBill', w.withdraw_id, e.message);
    if (isTransferBillNotFoundError(e)) {
      try {
        await voidStalePendingWithdrawFromWechat(pool, w.withdraw_id, '撤销时微信无此单，已退回余额');
      } catch (ve) {
        console.error('[reward-transfer] void after cancel 404', ve.message);
      }
    }
  }

  const [wAfterCancel] = await pool.execute('SELECT * FROM withdrawals WHERE withdraw_id = ?', [w.withdraw_id]);
  if (!wAfterCancel.length || wAfterCancel[0].status !== 0) {
    return { ok: true, withdrawal: wAfterCancel[0] || null };
  }

  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const bill = await wechatPay.getTransferBillByOutNo(w.withdraw_id).catch(() => null);
    if (bill && ['SUCCESS', 'FAIL', 'CANCELLED'].includes(bill.state)) {
      await applyWechatTransferOutcome(pool, bill);
      const [w3] = await pool.execute('SELECT * FROM withdrawals WHERE withdraw_id = ?', [w.withdraw_id]);
      return { ok: true, withdrawal: w3[0], bill };
    }
  }

  await syncWithdrawalWithWechat(pool, w.withdraw_id);
  const [w4] = await pool.execute('SELECT * FROM withdrawals WHERE withdraw_id = ?', [w.withdraw_id]);
  return {
    ok: w4[0].status !== 0,
    pending: w4[0].status === 0,
    withdrawal: w4[0],
    message: w4[0].status === 0 ? '撤销处理中，请稍后下拉刷新余额或重试' : undefined,
  };
}

module.exports = {
  transferNotifyUrl,
  canUseWechatTransfer,
  submitUserWithdraw,
  handleRewardTransferNotify,
  reconcileUserWithdraw,
  cancelPendingUserWithdraw,
  syncWithdrawalWithWechat,
  nameRequiredFen,
};
