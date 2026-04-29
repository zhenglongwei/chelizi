/**
 * 代理人（推荐）绑定与查询
 * 分佣比例与结算见 settlement-service settleReferralCommission
 */

const REFERRAL_L1_RATE = 0.1;
const REFERRAL_L2_RATE = 0.02;

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} userId - 当前用户
 * @param {string} referrerUserId - 推荐人 user_id
 */
async function bindReferrer(pool, userId, referrerUserId) {
  const rid = String(referrerUserId || '').trim();
  const uid = String(userId || '').trim();
  if (!rid || !uid) return { success: false, error: '参数无效' };
  if (rid === uid) return { success: false, error: '不能绑定自己为推荐人' };

  const [refRows] = await pool.execute('SELECT user_id FROM users WHERE user_id = ? LIMIT 1', [rid]);
  if (!refRows.length) return { success: false, error: '推荐人不存在' };

  const [meRows] = await pool.execute(
    'SELECT referrer_user_id FROM users WHERE user_id = ? LIMIT 1',
    [uid]
  );
  if (!meRows.length) return { success: false, error: '用户不存在' };
  if (meRows[0].referrer_user_id) return { success: false, error: '已绑定推荐人，不可更改' };

  const [refOfRef] = await pool.execute(
    'SELECT referrer_user_id FROM users WHERE user_id = ? LIMIT 1',
    [rid]
  );
  const ror = refOfRef[0]?.referrer_user_id;
  if (ror && String(ror) === uid) {
    return { success: false, error: '不能形成互为推荐关系' };
  }

  const [upd] = await pool.execute(
    `UPDATE users SET referrer_user_id = ?, referral_bound_at = NOW(), is_distribution_buyer = 1, updated_at = NOW()
     WHERE user_id = ? AND (referrer_user_id IS NULL OR referrer_user_id = '')`,
    [rid, uid]
  );
  const affected = upd?.affectedRows ?? 0;
  if (affected === 0) {
    return { success: false, error: '绑定失败，可能已绑定推荐人' };
  }
  return { success: true };
}

async function isDistributionBuyer(pool, userId) {
  const uid = String(userId || '').trim();
  if (!uid) return false;
  const [rows] = await pool.execute(
    'SELECT is_distribution_buyer FROM users WHERE user_id = ? LIMIT 1',
    [uid]
  );
  if (!rows.length) return false;
  const v = rows[0].is_distribution_buyer;
  return v === 1 || v === '1';
}

function getRates() {
  return { l1: REFERRAL_L1_RATE, l2: REFERRAL_L2_RATE };
}

module.exports = {
  bindReferrer,
  isDistributionBuyer,
  getRates,
};
