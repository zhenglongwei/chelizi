/**
 * 认证服务
 * 用户登录（微信）、服务商注册、服务商登录
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const antifraud = require('../antifraud');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha256').toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const verify = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha256').toString('hex');
  return hash === verify;
}

/**
 * 小程序 wx.login 的 code 换 openid
 */
async function resolveOpenidFromCode(code, options = {}) {
  const { WX_APPID, WX_SECRET } = options;
  if (!code || !String(code).trim()) {
    return { success: false, error: '授权码不能为空', statusCode: 400 };
  }
  if (!WX_APPID || !WX_SECRET) {
    return { success: false, error: '未配置微信小程序', statusCode: 503 };
  }
  const wxRes = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
    params: { appid: WX_APPID, secret: WX_SECRET, js_code: String(code).trim(), grant_type: 'authorization_code' },
  });
  const d = wxRes.data;
  if (d.errcode) {
    return { success: false, error: '微信授权失败: ' + (d.errmsg || d.errcode), statusCode: 400 };
  }
  if (!d.openid) {
    return { success: false, error: '未获取到 openid', statusCode: 400 };
  }
  return { success: true, openid: d.openid };
}

/**
 * 用户微信登录
 */
async function userLogin(pool, req, options = {}) {
  const { code } = req.body || {};
  const { WX_APPID, WX_SECRET, JWT_SECRET } = options;

  if (!code) {
    return { success: false, error: '授权码不能为空', statusCode: 400 };
  }

  if (process.env.NODE_ENV !== 'production' && code === 'test_simulate') {
    const [users] = await pool.execute('SELECT * FROM users WHERE user_id = ?', ['USER001']);
    if (users.length === 0) {
      return { success: false, error: '测试用户 USER001 不存在，请先执行 schema seed', statusCode: 404 };
    }
    const user = users[0];
    const token = jwt.sign(
      { userId: user.user_id, openid: user.openid },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    return {
      success: true,
      data: {
        token,
        user: {
          user_id: user.user_id,
          nickname: user.nickname,
          avatar_url: user.avatar_url,
          phone: user.phone,
          level: user.level,
          points: user.points,
          balance: user.balance,
          total_rebate: user.total_rebate,
        },
      },
    };
  }

  const wxResponse = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
    params: {
      appid: WX_APPID,
      secret: WX_SECRET,
      js_code: code,
      grant_type: 'authorization_code',
    },
  });

  if (wxResponse.data.errcode) {
    return { success: false, error: '微信授权失败: ' + wxResponse.data.errmsg, statusCode: 401 };
  }

  const { openid, unionid } = wxResponse.data;
  let [users] = await pool.execute('SELECT * FROM users WHERE openid = ?', [openid]);
  let user;

  if (users.length === 0) {
    const userId = 'U' + Date.now();
    await pool.execute(
      `INSERT INTO users (user_id, openid, unionid, level, points, balance, total_rebate, total_reviews, created_at, updated_at) 
       VALUES (?, ?, ?, 0, 0, 0, 0, 0, NOW(), NOW())`,
      [userId, openid, unionid || null]
    );
    [users] = await pool.execute('SELECT * FROM users WHERE openid = ?', [openid]);
    user = users[0];
  } else {
    user = users[0];
    await pool.execute('UPDATE users SET updated_at = NOW() WHERE openid = ?', [openid]);
  }

  const ip = req.ip || req.headers?.['x-forwarded-for'] || '';
  const bl = await antifraud.checkBlacklist(pool, user.user_id, user.phone, ip);
  if (bl.blocked) {
    return { success: false, error: bl.reason || '账号存在异常，暂无法使用', statusCode: 403 };
  }

  const token = jwt.sign(
    { userId: user.user_id, openid: user.openid },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  return {
    success: true,
    data: {
      token,
      user: {
        user_id: user.user_id,
        nickname: user.nickname,
        avatar_url: user.avatar_url,
        phone: user.phone,
        level: user.level,
        points: user.points,
        balance: user.balance,
        total_rebate: user.total_rebate,
      },
    },
  };
}

/**
 * 服务商注册
 */
async function merchantRegister(pool, req, options = {}) {
  const body = req.body || {};
  const {
    name,
    license_id,
    legal_representative,
    contact,
    address,
    latitude,
    longitude,
    phone,
    password,
    license_url,
    qualification_ai_recognized,
    qualification_ai_result,
  } = body;
  const { JWT_SECRET } = options;

  if (!name || !license_id || !legal_representative || !contact || !address || !phone || !password) {
    return { success: false, error: '请填写企业名称、营业执照号码、法定代表人、联系人、店铺地址、手机号、密码', statusCode: 400 };
  }
  if (latitude == null || longitude == null || isNaN(Number(latitude)) || isNaN(Number(longitude))) {
    return { success: false, error: '请在地图上选择店铺位置以获取精准坐标', statusCode: 400 };
  }
  const phoneStr = String(phone).trim();
  if (!/^1\d{10}$/.test(phoneStr)) {
    return { success: false, error: '手机号格式不正确', statusCode: 400 };
  }
  if (String(password).length < 6) {
    return { success: false, error: '密码至少 6 位', statusCode: 400 };
  }

  const [existing] = await pool.execute('SELECT merchant_id FROM merchant_users WHERE phone = ?', [phoneStr]);
  if (existing.length > 0) {
    return { success: false, error: '该手机号已注册', statusCode: 400 };
  }

  const shopId = 'S' + Date.now();
  const certsArr = [];
  if (license_url) {
    certsArr.push({
      type: 'license',
      name: '营业执照',
      image: license_url,
      license_number: String(license_id || '').trim(),
      legal_representative: String(legal_representative || '').trim(),
    });
  }
  const certs = certsArr.length ? JSON.stringify(certsArr) : null;
  const qualAiRecognized = ['一类', '二类', '三类'].includes(String(qualification_ai_recognized || '').trim())
    ? String(qualification_ai_recognized).trim()
    : null;
  const qualAiResult = ['recognized', 'recognition_failed', 'no_qualification_found'].includes(
    String(qualification_ai_result || '')
  )
    ? String(qualification_ai_result)
    : null;

  const addr = String(address || '').trim() || '待完善';
  const lat = Number(latitude);
  const lng = Number(longitude);
  await pool.execute(
    `INSERT INTO shops (shop_id, name, address, province, city, district, latitude, longitude, phone, certifications, qualification_level, qualification_ai_recognized, qualification_ai_result, qualification_status, qualification_audit_reason, status)
     VALUES (?, ?, ?, '待完善', '', '', ?, ?, ?, ?, NULL, ?, ?, 0, NULL, 1)`,
    [shopId, String(name).trim(), addr, lat, lng, phoneStr, certs, qualAiRecognized, qualAiResult]
  );

  let openidToSave = null;
  if (body.code && String(body.code).trim()) {
    const oid = await resolveOpenidFromCode(body.code, options);
    if (!oid.success) return oid;
    openidToSave = oid.openid;
    const [dupOpenid] = await pool.execute('SELECT merchant_id FROM merchant_users WHERE openid = ?', [openidToSave]);
    if (dupOpenid.length > 0) {
      return { success: false, error: '该微信已绑定其他服务商账号', statusCode: 400 };
    }
  }

  const merchantId = 'M' + Date.now();
  const passwordHash = hashPassword(String(password));
  await pool.execute(
    `INSERT INTO merchant_users (merchant_id, shop_id, phone, password_hash, status, openid)
     VALUES (?, ?, ?, ?, 1, ?)`,
    [merchantId, shopId, phoneStr, passwordHash, openidToSave]
  );

  const token = jwt.sign({ merchantId, shopId }, JWT_SECRET, { expiresIn: '7d' });

  return {
    success: true,
    data: {
      merchant_id: merchantId,
      token,
      user: { merchant_id: merchantId, shop_id: shopId, phone: phoneStr },
      message: '注册成功，请补充资质信息',
    },
  };
}

/**
 * 服务商登录
 */
async function merchantLogin(pool, req, options = {}) {
  const { phone, password } = req.body || {};
  const { JWT_SECRET } = options;

  if (!phone || !password) {
    return { success: false, error: '请填写手机号和密码', statusCode: 400 };
  }
  const phoneStr = String(phone).trim();

  const [rows] = await pool.execute(
    `SELECT mu.merchant_id, mu.shop_id, mu.phone, mu.password_hash, mu.status, s.name as shop_name
     FROM merchant_users mu
     LEFT JOIN shops s ON mu.shop_id = s.shop_id
     WHERE mu.phone = ?`,
    [phoneStr]
  );
  if (rows.length === 0) {
    return { success: false, error: '手机号或密码错误', statusCode: 401 };
  }
  const m = rows[0];
  if (!m.password_hash || !verifyPassword(String(password), m.password_hash)) {
    return { success: false, error: '手机号或密码错误', statusCode: 401 };
  }
  if (m.status === 0) {
    return { success: false, error: '账号审核中，请耐心等待', statusCode: 403 };
  }

  const token = jwt.sign(
    { merchantId: m.merchant_id, shopId: m.shop_id },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  return {
    success: true,
    data: {
      token,
      user: {
        merchant_id: m.merchant_id,
        shop_id: m.shop_id,
        phone: m.phone,
        shop_name: m.shop_name || '',
      },
    },
  };
}

/**
 * 服务商微信快捷登录（merchant_users.openid 与当前小程序 openid 一致）
 */
async function merchantWechatLogin(pool, req, options = {}) {
  const { code } = req.body || {};
  const { JWT_SECRET } = options;

  const oid = await resolveOpenidFromCode(code, options);
  if (!oid.success) return oid;
  const openid = oid.openid;

  const [rows] = await pool.execute(
    `SELECT mu.merchant_id, mu.shop_id, mu.phone, mu.status, s.name as shop_name
     FROM merchant_users mu
     LEFT JOIN shops s ON mu.shop_id = s.shop_id
     WHERE mu.openid = ?`,
    [openid]
  );
  if (rows.length === 0) {
    return { success: false, error: '当前微信未绑定服务商账号，请使用手机号登录', statusCode: 401 };
  }
  if (rows.length > 1) {
    return { success: false, error: '账号数据异常，请联系平台', statusCode: 500 };
  }
  const m = rows[0];
  if (m.status === 0) {
    return { success: false, error: '账号审核中，请耐心等待', statusCode: 403 };
  }

  const token = jwt.sign({ merchantId: m.merchant_id, shopId: m.shop_id }, JWT_SECRET, { expiresIn: '7d' });

  return {
    success: true,
    data: {
      token,
      user: {
        merchant_id: m.merchant_id,
        shop_id: m.shop_id,
        phone: m.phone,
        shop_name: m.shop_name || '',
      },
    },
  };
}

/**
 * 检测当前小程序 openid 是否已绑定服务商（不发 token，供「我的」页展示入口）
 */
async function merchantCheckOpenid(pool, req, options = {}) {
  const { code } = req.body || {};

  const oid = await resolveOpenidFromCode(code, options);
  if (!oid.success) return oid;
  const openid = oid.openid;

  const [rows] = await pool.execute(
    `SELECT mu.status, s.name as shop_name
     FROM merchant_users mu
     LEFT JOIN shops s ON mu.shop_id = s.shop_id
     WHERE mu.openid = ?`,
    [openid]
  );
  if (rows.length === 0) {
    return { success: true, data: { is_merchant: false } };
  }
  if (rows.length > 1) {
    return { success: false, error: '账号数据异常', statusCode: 500 };
  }
  const m = rows[0];
  return {
    success: true,
    data: {
      is_merchant: true,
      shop_name: m.shop_name || '',
      merchant_status: m.status,
      can_login: m.status !== 0,
    },
  };
}

/**
 * 找回密码：校验手机号对应账号的 openid 与当前微信一致后重置密码
 */
async function merchantResetPassword(pool, req, options = {}) {
  const { phone, new_password, code } = req.body || {};

  if (!phone || !new_password || !code) {
    return { success: false, error: '请填写手机号、新密码并完成微信校验', statusCode: 400 };
  }
  const phoneStr = String(phone).trim();
  if (!/^1\d{10}$/.test(phoneStr)) {
    return { success: false, error: '手机号格式不正确', statusCode: 400 };
  }
  if (String(new_password).length < 6) {
    return { success: false, error: '新密码至少 6 位', statusCode: 400 };
  }

  const oid = await resolveOpenidFromCode(code, options);
  if (!oid.success) return oid;
  const openid = oid.openid;

  const [rows] = await pool.execute(
    'SELECT merchant_id, openid, status FROM merchant_users WHERE phone = ?',
    [phoneStr]
  );
  if (rows.length === 0) {
    return { success: false, error: '该手机号未注册服务商', statusCode: 404 };
  }
  const m = rows[0];
  if (m.status === 0) {
    return { success: false, error: '账号审核中，暂不可修改密码', statusCode: 403 };
  }
  if (!m.openid || !String(m.openid).trim()) {
    return {
      success: false,
      error: '该账号尚未绑定微信，请使用原密码登录一次，登录成功后会自动绑定微信',
      statusCode: 400,
    };
  }
  if (m.openid !== openid) {
    return { success: false, error: '当前微信与账号绑定不一致，请使用注册时使用的微信重试', statusCode: 403 };
  }

  const passwordHash = hashPassword(String(new_password));
  await pool.execute('UPDATE merchant_users SET password_hash = ?, updated_at = NOW() WHERE merchant_id = ?', [
    passwordHash,
    m.merchant_id,
  ]);

  return { success: true, data: { ok: true } };
}

/**
 * 通过微信 getPhoneNumber 返回的 code 获取手机号并更新用户
 * @param {object} pool - 数据库连接池
 * @param {string} userId - 用户ID（需已登录）
 * @param {string} code - getPhoneNumber 回调返回的 code
 * @param {object} options - { WX_APPID, WX_SECRET }
 */
async function getPhoneFromCodeAndUpdate(pool, userId, code, options = {}) {
  const { WX_APPID, WX_SECRET } = options;
  if (!WX_APPID || !WX_SECRET) {
    return { success: false, error: '未配置微信参数', statusCode: 500 };
  }
  if (!code || !String(code).trim()) {
    return { success: false, error: 'code 不能为空', statusCode: 400 };
  }

  const axios = require('axios');
  const tokenRes = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
    params: { appid: WX_APPID, secret: WX_SECRET, grant_type: 'client_credential' },
  });
  if (tokenRes.data.errcode) {
    return { success: false, error: '获取 access_token 失败: ' + (tokenRes.data.errmsg || ''), statusCode: 500 };
  }
  const accessToken = tokenRes.data.access_token;

  const phoneRes = await axios.post(
    `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${accessToken}`,
    { code: String(code).trim() }
  );
  if (phoneRes.data.errcode !== 0) {
    return { success: false, error: '获取手机号失败: ' + (phoneRes.data.errmsg || '用户拒绝或 code 无效'), statusCode: 400 };
  }
  const phone = phoneRes.data.phone_info?.phoneNumber || phoneRes.data.phone_info?.purePhoneNumber;
  if (!phone) {
    return { success: false, error: '未获取到手机号', statusCode: 400 };
  }

  await pool.execute('UPDATE users SET phone = ?, updated_at = NOW() WHERE user_id = ?', [phone, userId]);
  await pool.execute(
    `INSERT INTO user_verification (user_id, verified, verified_at) VALUES (?, 1, NOW())
     ON DUPLICATE KEY UPDATE verified = 1, verified_at = COALESCE(verified_at, NOW())`,
    [userId]
  );

  const trust = await antifraud.getUserTrustLevel(pool, userId);
  if (trust.level >= 1) {
    await pool.execute('UPDATE users SET level = ?, level_updated_at = NOW() WHERE user_id = ?', [trust.level, userId]);
    await antifraud.processWithheldRewards(pool, userId);
  }

  return { success: true, data: { phone } };
}

/**
 * 短信验证手机号（预留，短信包未开通时返回提示）
 */
async function verifyPhoneBySms(pool, userId, phone, smsCode) {
  return { success: false, error: '短信验证功能暂未开通，请使用微信授权获取手机号', statusCode: 501 };
}

module.exports = {
  hashPassword,
  verifyPassword,
  userLogin,
  getPhoneFromCodeAndUpdate,
  verifyPhoneBySms,
  merchantRegister,
  merchantLogin,
  merchantWechatLogin,
  merchantCheckOpenid,
  merchantResetPassword,
};
