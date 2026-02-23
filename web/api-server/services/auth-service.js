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
       VALUES (?, ?, ?, 1, 0, 0, 0, 0, NOW(), NOW())`,
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

  const merchantId = 'M' + Date.now();
  const passwordHash = hashPassword(String(password));
  await pool.execute(
    `INSERT INTO merchant_users (merchant_id, shop_id, phone, password_hash, status)
     VALUES (?, ?, ?, ?, 1)`,
    [merchantId, shopId, phoneStr, passwordHash]
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

module.exports = {
  hashPassword,
  verifyPassword,
  userLogin,
  merchantRegister,
  merchantLogin,
};
