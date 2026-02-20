// 车厘子 - 事故车维修平台 API 服务器
// 基于 Express + MySQL + 阿里云OSS

require('dotenv').config({ path: '../.env' });

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const app = express();

// ===================== 配置 =====================
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// 微信小程序配置
const WX_APPID = process.env.WX_APPID;
const WX_SECRET = process.env.WX_SECRET;

// 阿里云AI配置
const ALIYUN_AI_KEY = process.env.ALIYUN_AI_KEY;
const ALIYUN_AI_ENDPOINT = process.env.ALIYUN_AI_ENDPOINT || 'https://dashscope.aliyuncs.com/api/v1';

// ===================== 数据库连接池 =====================
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'chelizi',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
};

const pool = mysql.createPool(dbConfig);

const rewardCalculator = require('./reward-calculator');
const antifraud = require('./antifraud');

// 测试数据库连接
async function testDBConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✅ 数据库连接成功');
    connection.release();
  } catch (error) {
    console.error('❌ 数据库连接失败:', error.message);
  }
}

// ===================== 中间件 =====================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 请求日志
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// JWT认证中间件
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ code: 401, message: '未提供访问令牌' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.openid = decoded.openid;
    next();
  } catch (error) {
    return res.status(401).json({ code: 401, message: '令牌无效或已过期' });
  }
};

// 服务商认证中间件（merchant_token）
const authenticateMerchant = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ code: 401, message: '未提供访问令牌' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.merchantId = decoded.merchantId;
    req.shopId = decoded.shopId;
    if (!req.shopId) return res.status(401).json({ code: 401, message: '服务商信息异常' });
    next();
  } catch (error) {
    return res.status(401).json({ code: 401, message: '令牌无效或已过期' });
  }
};

// ===================== 通用响应格式 =====================
function successResponse(data, message = 'success') {
  return { code: 200, message, data };
}

function errorResponse(message, code = 400, errors = null) {
  const response = { code, message };
  if (errors) response.errors = errors;
  return response;
}

// ===================== 路由 =====================

// 健康检查（/health 本地直连，/api/health 经 Nginx 代理）
const healthHandler = async (req, res) => {
  try {
    const connection = await pool.getConnection();
    connection.release();
    res.json(successResponse({ 
      status: 'ok', 
      database: 'connected',
      timestamp: new Date().toISOString()
    }, 'API服务运行正常'));
  } catch (error) {
    res.status(500).json(errorResponse('数据库连接失败', 500));
  }
};
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// ===================== 1. 用户认证相关接口 =====================

// 微信登录
app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json(errorResponse('授权码不能为空'));
    }

    // 开发/模拟：code 为 test_simulate 时使用 USER001 测试账号（仅非生产环境）
    if (process.env.NODE_ENV !== 'production' && code === 'test_simulate') {
      const [users] = await pool.execute('SELECT * FROM users WHERE user_id = ?', ['USER001']);
      if (users.length === 0) {
        return res.status(404).json(errorResponse('测试用户 USER001 不存在，请先执行 schema seed'));
      }
      const user = users[0];
      const token = jwt.sign(
        { userId: user.user_id, openid: user.openid },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      return res.json(successResponse({
        token,
        user: {
          user_id: user.user_id,
          nickname: user.nickname,
          avatar_url: user.avatar_url,
          phone: user.phone,
          level: user.level,
          points: user.points,
          balance: user.balance,
          total_rebate: user.total_rebate
        }
      }, '登录成功'));
    }

    // 调用微信接口获取openid
    const wxResponse = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: {
        appid: WX_APPID,
        secret: WX_SECRET,
        js_code: code,
        grant_type: 'authorization_code'
      }
    });

    if (wxResponse.data.errcode) {
      return res.status(401).json(errorResponse('微信授权失败: ' + wxResponse.data.errmsg, 401));
    }

    const { openid, session_key, unionid } = wxResponse.data;

    // 查询或创建用户
    let [users] = await pool.execute(
      'SELECT * FROM users WHERE openid = ?',
      [openid]
    );

    let user;
    if (users.length === 0) {
      // 创建新用户
      const userId = 'U' + Date.now();
      await pool.execute(
        `INSERT INTO users (user_id, openid, unionid, level, points, balance, total_rebate, 
         total_reviews, created_at, updated_at) 
         VALUES (?, ?, ?, 1, 0, 0, 0, 0, NOW(), NOW())`,
        [userId, openid, unionid || null]
      );
      
      [users] = await pool.execute('SELECT * FROM users WHERE openid = ?', [openid]);
      user = users[0];
    } else {
      user = users[0];
      // 更新session_key
      await pool.execute('UPDATE users SET updated_at = NOW() WHERE openid = ?', [openid]);
    }

    // 防刷：黑名单校验
    const ip = req.ip || req.headers['x-forwarded-for'] || '';
    const bl = await antifraud.checkBlacklist(pool, user.user_id, user.phone, ip);
    if (bl.blocked) {
      return res.status(403).json(errorResponse(bl.reason || '账号存在异常，暂无法使用', 403));
    }

    // 生成JWT令牌
    const token = jwt.sign(
      { userId: user.user_id, openid: user.openid },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json(successResponse({
      token,
      user: {
        user_id: user.user_id,
        nickname: user.nickname,
        avatar_url: user.avatar_url,
        phone: user.phone,
        level: user.level,
        points: user.points,
        balance: user.balance,
        total_rebate: user.total_rebate
      }
    }, '登录成功'));

  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json(errorResponse('登录失败: ' + error.message, 500));
  }
});

// ===================== 服务商认证 =====================

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

// 服务商注册
app.post('/api/v1/merchant/register', async (req, res) => {
  try {
    const { name, license_id, legal_representative, contact, address, latitude, longitude, phone, password, license_url } = req.body;

    if (!name || !license_id || !legal_representative || !contact || !address || !phone || !password) {
      return res.status(400).json(errorResponse('请填写企业名称、营业执照号码、法定代表人、联系人、店铺地址、手机号、密码'));
    }
    if (latitude == null || longitude == null || isNaN(Number(latitude)) || isNaN(Number(longitude))) {
      return res.status(400).json(errorResponse('请在地图上选择店铺位置以获取精准坐标'));
    }
    const phoneStr = String(phone).trim();
    if (!/^1\d{10}$/.test(phoneStr)) {
      return res.status(400).json(errorResponse('手机号格式不正确'));
    }
    if (String(password).length < 6) {
      return res.status(400).json(errorResponse('密码至少 6 位'));
    }

    const [existing] = await pool.execute(
      'SELECT merchant_id FROM merchant_users WHERE phone = ?',
      [phoneStr]
    );
    if (existing.length > 0) {
      return res.status(400).json(errorResponse('该手机号已注册'));
    }

    const shopId = 'S' + Date.now();
    const certs = license_url
      ? JSON.stringify([{
          type: 'license',
          name: '营业执照',
          image: license_url,
          license_number: String(license_id || '').trim(),
          legal_representative: String(legal_representative || '').trim()
        }])
      : null;
    const addr = String(address || '').trim() || '待完善';
    const lat = Number(latitude);
    const lng = Number(longitude);
    await pool.execute(
      `INSERT INTO shops (shop_id, name, address, province, city, district, latitude, longitude, phone, certifications, status)
       VALUES (?, ?, ?, '待完善', '', '', ?, ?, ?, ?, 1)`,
      [shopId, String(name).trim(), addr, lat, lng, phoneStr, certs]
    );

    const merchantId = 'M' + Date.now();
    const passwordHash = hashPassword(String(password));
    await pool.execute(
      `INSERT INTO merchant_users (merchant_id, shop_id, phone, password_hash, status)
       VALUES (?, ?, ?, ?, 0)`,
      [merchantId, shopId, phoneStr, passwordHash]
    );

    res.json(successResponse({
      merchant_id: merchantId,
      message: '注册成功，审核通过后将可登录使用'
    }, '注册成功'));
  } catch (error) {
    console.error('服务商注册错误:', error);
    res.status(500).json(errorResponse('注册失败', 500));
  }
});

// 营业执照 OCR：调用千问大模型识别
app.post('/api/v1/merchant/ocr-license', async (req, res) => {
  try {
    const { img_url } = req.body;
    if (!img_url) return res.status(400).json(errorResponse('图片地址不能为空'));
    const apiKey = process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '';
    if (!apiKey) return res.status(500).json(errorResponse('未配置千问 API Key'));

    const { analyzeLicenseWithQwen } = require('./qwen-analyzer');
    const data = await analyzeLicenseWithQwen(img_url, apiKey);
    res.json(successResponse(data));
  } catch (error) {
    console.error('营业执照 OCR 错误:', error);
    res.status(500).json(errorResponse(error.message || '识别失败', 500));
  }
});

// 服务商登录
app.post('/api/v1/merchant/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json(errorResponse('请填写手机号和密码'));
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
      return res.status(401).json(errorResponse('手机号或密码错误'));
    }
    const m = rows[0];
    if (!m.password_hash || !verifyPassword(String(password), m.password_hash)) {
      return res.status(401).json(errorResponse('手机号或密码错误'));
    }
    if (m.status === 0) return res.status(403).json(errorResponse('账号审核中，请耐心等待'));

    const token = jwt.sign(
      { merchantId: m.merchant_id, shopId: m.shop_id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json(successResponse({
      token,
      user: {
        merchant_id: m.merchant_id,
        shop_id: m.shop_id,
        phone: m.phone,
        shop_name: m.shop_name || ''
      }
    }, '登录成功'));
  } catch (error) {
    console.error('服务商登录错误:', error);
    res.status(500).json(errorResponse('登录失败', 500));
  }
});

// ===================== 服务商端接口（需 merchant_token） =====================

// 工作台汇总
app.get('/api/v1/merchant/dashboard', authenticateMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const [pendingBidding] = await pool.execute(
      `SELECT COUNT(DISTINCT b.bidding_id) as cnt FROM biddings b
       INNER JOIN users u ON b.user_id = u.user_id
       INNER JOIN shops s ON s.shop_id = ?
       WHERE b.status = 0 AND b.expire_at > NOW()
         AND u.latitude IS NOT NULL AND u.longitude IS NOT NULL
         AND (6371 * acos(cos(radians(u.latitude)) * cos(radians(s.latitude)) *
         cos(radians(s.longitude) - radians(u.longitude)) + sin(radians(u.latitude)) * sin(radians(s.latitude)))) <= b.range_km
         AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.shop_id = ?)`,
      [shopId, shopId]
    );
    const [pendingOrder] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM orders WHERE shop_id = ? AND status = 0',
      [shopId]
    );
    const [repairing] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM orders WHERE shop_id = ? AND status = 1',
      [shopId]
    );
    const [pendingConfirm] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM orders WHERE shop_id = ? AND status = 2',
      [shopId]
    );
    res.json(successResponse({
      pending_bidding_count: pendingBidding[0]?.cnt || 0,
      pending_order_count: pendingOrder[0]?.cnt || 0,
      repairing_count: repairing[0]?.cnt || 0,
      pending_confirm_count: pendingConfirm[0]?.cnt || 0
    }));
  } catch (error) {
    console.error('服务商工作台错误:', error);
    res.status(500).json(errorResponse('获取工作台数据失败', 500));
  }
});

// 竞价邀请列表（本店在范围内的竞价，且未报价）
app.get('/api/v1/merchant/biddings', authenticateMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));
    const status = req.query.status; // pending | quoted
    const offset = (page - 1) * limit;

    const havingClause = status === 'quoted' ? 'HAVING quoted > 0' : 'HAVING quoted = 0';

    const [list] = await pool.execute(
      `SELECT b.bidding_id, b.report_id, b.vehicle_info, b.range_km, b.expire_at, b.created_at,
        dr.analysis_result,
        u.latitude as user_lat, u.longitude as user_lng,
        s.latitude as shop_lat, s.longitude as shop_lng,
        (SELECT COUNT(*) FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.shop_id = ?) as quoted
       FROM biddings b
       INNER JOIN damage_reports dr ON b.report_id = dr.report_id
       INNER JOIN users u ON b.user_id = u.user_id
       INNER JOIN shops s ON s.shop_id = ?
       WHERE b.status = 0 AND b.expire_at > NOW()
         AND u.latitude IS NOT NULL AND u.longitude IS NOT NULL
         AND (6371 * acos(cos(radians(u.latitude)) * cos(radians(s.latitude)) *
         cos(radians(s.longitude) - radians(u.longitude)) + sin(radians(u.latitude)) * sin(radians(s.latitude)))) <= b.range_km
       ${havingClause}
       ORDER BY b.created_at DESC
       LIMIT ? OFFSET ?`,
      [shopId, shopId, limit, offset]
    );

    const items = (list || []).map((row) => {
      let vehicleInfo = {};
      try {
        vehicleInfo = typeof row.vehicle_info === 'string' ? JSON.parse(row.vehicle_info) : (row.vehicle_info || {});
      } catch (_) {}
      let analysis = {};
      try {
        analysis = typeof row.analysis_result === 'string' ? JSON.parse(row.analysis_result || '{}') : (row.analysis_result || {});
      } catch (_) {}
      let distance = null;
      if (row.user_lat != null && row.shop_lat != null) {
        const R = 6371;
        const dLat = (row.shop_lat - row.user_lat) * Math.PI / 180;
        const dLng = (row.shop_lng - row.user_lng) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(row.user_lat * Math.PI / 180) * Math.cos(row.shop_lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        distance = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
      }
      const est = analysis.total_estimate;
      const estMid = Array.isArray(est) && est.length >= 2 ? (parseFloat(est[0]) + parseFloat(est[1])) / 2 : 5000;
      let complexityLevel = 'L2';
      if (estMid < 1000) complexityLevel = 'L1';
      else if (estMid < 5000) complexityLevel = 'L2';
      else if (estMid < 20000) complexityLevel = 'L3';
      else complexityLevel = 'L4';
      return {
        bidding_id: row.bidding_id,
        report_id: row.report_id,
        vehicle_info: vehicleInfo,
        analysis_result: analysis,
        range_km: row.range_km,
        expire_at: row.expire_at,
        created_at: row.created_at,
        distance_km: distance,
        quoted: (row.quoted || 0) > 0,
        complexity_level: complexityLevel
      };
    });

    const [countRes] = await pool.execute(
      `SELECT COUNT(*) as total FROM (
        SELECT b.bidding_id FROM biddings b
        INNER JOIN users u ON b.user_id = u.user_id
        INNER JOIN shops s ON s.shop_id = ?
        WHERE b.status = 0 AND b.expire_at > NOW()
          AND u.latitude IS NOT NULL AND u.longitude IS NOT NULL
          AND (6371 * acos(cos(radians(u.latitude)) * cos(radians(s.latitude)) *
          cos(radians(s.longitude) - radians(u.longitude)) + sin(radians(u.latitude)) * sin(radians(s.latitude)))) <= b.range_km
          AND (SELECT COUNT(*) FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.shop_id = ?) ${status === 'quoted' ? '> 0' : '= 0'}
      ) t`,
      [shopId, shopId]
    );

    res.json(successResponse({ list: items, total: countRes[0]?.total || 0, page, limit }));
  } catch (error) {
    console.error('服务商竞价列表错误:', error);
    res.status(500).json(errorResponse('获取竞价列表失败', 500));
  }
});

// 竞价详情（含定损报告）
app.get('/api/v1/merchant/bidding/:id', authenticateMerchant, async (req, res) => {
  try {
    const { id } = req.params;
    const shopId = req.shopId;

    const [biddings] = await pool.execute(
      `SELECT b.*, dr.images, dr.analysis_result
       FROM biddings b
       INNER JOIN damage_reports dr ON b.report_id = dr.report_id
       INNER JOIN users u ON b.user_id = u.user_id
       INNER JOIN shops s ON s.shop_id = ?
       WHERE b.bidding_id = ?
         AND u.latitude IS NOT NULL AND u.longitude IS NOT NULL
         AND (6371 * acos(cos(radians(u.latitude)) * cos(radians(s.latitude)) *
         cos(radians(s.longitude) - radians(u.longitude)) + sin(radians(u.latitude)) * sin(radians(s.latitude)))) <= b.range_km`,
      [shopId, id]
    );
    if (biddings.length === 0) {
      return res.status(404).json(errorResponse('竞价不存在或未邀请您'));
    }

    const b = biddings[0];
    let vehicleInfo = {};
    let analysis = {};
    let images = [];
    try {
      vehicleInfo = typeof b.vehicle_info === 'string' ? JSON.parse(b.vehicle_info) : (b.vehicle_info || {});
      analysis = typeof b.analysis_result === 'string' ? JSON.parse(b.analysis_result || '{}') : (b.analysis_result || {});
      images = typeof b.images === 'string' ? JSON.parse(b.images || '[]') : (b.images || []);
    } catch (_) {}

    const [quoted] = await pool.execute(
      'SELECT quote_id, amount, items, duration, warranty, remark FROM quotes WHERE bidding_id = ? AND shop_id = ?',
      [id, shopId]
    );

    const est = analysis.total_estimate;
    const estMid = Array.isArray(est) && est.length >= 2 ? (parseFloat(est[0]) + parseFloat(est[1])) / 2 : 5000;
    let complexityLevel = 'L2';
    if (estMid < 1000) complexityLevel = 'L1';
    else if (estMid < 5000) complexityLevel = 'L2';
    else if (estMid < 20000) complexityLevel = 'L3';
    else complexityLevel = 'L4';
    const orderTier = estMid < 1000 ? 1 : estMid < 5000 ? 2 : estMid < 20000 ? 3 : 4;

    res.json(successResponse({
      bidding_id: b.bidding_id,
      report_id: b.report_id,
      vehicle_info: vehicleInfo,
      insurance_info: typeof b.insurance_info === 'string' ? JSON.parse(b.insurance_info || '{}') : (b.insurance_info || {}),
      range_km: b.range_km,
      expire_at: b.expire_at,
      status: b.status,
      images,
      analysis_result: analysis,
      complexity_level: complexityLevel,
      order_tier: orderTier,
      my_quote: quoted.length > 0 ? {
        quote_id: quoted[0].quote_id,
        amount: quoted[0].amount,
        items: typeof quoted[0].items === 'string' ? JSON.parse(quoted[0].items || '[]') : (quoted[0].items || []),
        duration: quoted[0].duration,
        warranty: quoted[0].warranty,
        remark: quoted[0].remark
      } : null
    }));
  } catch (error) {
    console.error('服务商竞价详情错误:', error);
    res.status(500).json(errorResponse('获取竞价详情失败', 500));
  }
});

// 提交报价
app.post('/api/v1/merchant/quote', authenticateMerchant, async (req, res) => {
  try {
    const { bidding_id, amount, items, duration, warranty, remark } = req.body;
    const shopId = req.shopId;

    if (!bidding_id || !amount || amount <= 0) {
      return res.status(400).json(errorResponse('请填写有效报价金额'));
    }

    const [biddingCheck] = await pool.execute(
      'SELECT bidding_id, status FROM biddings WHERE bidding_id = ?',
      [bidding_id]
    );
    if (biddingCheck.length === 0) return res.status(404).json(errorResponse('竞价不存在'));
    if (biddingCheck[0].status !== 0) return res.status(400).json(errorResponse('该竞价已结束'));

    const [existing] = await pool.execute(
      'SELECT quote_id FROM quotes WHERE bidding_id = ? AND shop_id = ?',
      [bidding_id, shopId]
    );
    if (existing.length > 0) return res.status(400).json(errorResponse('您已提交过报价'));

    const [inRange] = await pool.execute(
      `SELECT 1 FROM biddings b
       INNER JOIN users u ON b.user_id = u.user_id
       INNER JOIN shops s ON s.shop_id = ?
       WHERE b.bidding_id = ? AND u.latitude IS NOT NULL
         AND (6371 * acos(cos(radians(u.latitude)) * cos(radians(s.latitude)) *
         cos(radians(s.longitude) - radians(u.longitude)) + sin(radians(u.latitude)) * sin(radians(s.latitude)))) <= b.range_km`,
      [shopId, bidding_id]
    );
    if (inRange.length === 0) return res.status(403).json(errorResponse('该竞价未邀请您'));

    const quoteId = 'QUO' + Date.now();
    await pool.execute(
      `INSERT INTO quotes (quote_id, bidding_id, shop_id, amount, items, duration, warranty, remark)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [quoteId, bidding_id, shopId, amount, JSON.stringify(items || []), duration || 3, warranty || 12, remark || null]
    );

    res.json(successResponse({ quote_id: quoteId }, '报价已提交'));
  } catch (error) {
    console.error('提交报价错误:', error);
    res.status(500).json(errorResponse('提交报价失败', 500));
  }
});

// 本店订单列表
app.get('/api/v1/merchant/orders', authenticateMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const status = req.query.status;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;

    let where = 'WHERE o.shop_id = ?';
    const params = [shopId];
    if (status !== undefined && status !== '' && status !== null) {
      where += ' AND o.status = ?';
      params.push(parseInt(status, 10));
    }

    const [list] = await pool.execute(
      `SELECT o.order_id, o.bidding_id, o.quoted_amount, o.status, o.created_at,
        o.order_tier, o.complexity_level, o.commission_rate,
        b.vehicle_info, dr.analysis_result
       FROM orders o
       LEFT JOIN biddings b ON o.bidding_id = b.bidding_id
       LEFT JOIN damage_reports dr ON b.report_id = dr.report_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [countRes] = await pool.execute(
      `SELECT COUNT(*) as total FROM orders o ${where}`,
      params
    );

    const items = (list || []).map((row) => {
      let vehicleInfo = {};
      try {
        vehicleInfo = typeof row.vehicle_info === 'string' ? JSON.parse(row.vehicle_info) : (row.vehicle_info || {});
      } catch (_) {}
      let orderTier = row.order_tier;
      if (!orderTier && row.quoted_amount != null) {
        const amt = parseFloat(row.quoted_amount) || 0;
        if (amt < 1000) orderTier = 1;
        else if (amt < 5000) orderTier = 2;
        else if (amt < 20000) orderTier = 3;
        else orderTier = 4;
      }
      const cr = row.commission_rate != null ? (parseFloat(row.commission_rate) || 0) + '%' : (orderTier === 1 ? '4%-8%' : orderTier === 2 ? '8%-12%' : orderTier === 3 ? '10%-14%' : '12%-16%');
      return {
        order_id: row.order_id,
        bidding_id: row.bidding_id,
        vehicle_info: vehicleInfo,
        quoted_amount: row.quoted_amount,
        status: row.status,
        created_at: row.created_at,
        order_tier: orderTier,
        complexity_level: row.complexity_level || 'L2',
        commission_rate: cr
      };
    });

    res.json(successResponse({ list: items, total: countRes[0]?.total || 0, page, limit }));
  } catch (error) {
    console.error('服务商订单列表错误:', error);
    res.status(500).json(errorResponse('获取订单列表失败', 500));
  }
});

// 订单详情
app.get('/api/v1/merchant/orders/:id', authenticateMerchant, async (req, res) => {
  try {
    const { id } = req.params;
    const shopId = req.shopId;

    const [orders] = await pool.execute(
      `SELECT o.*, b.vehicle_info, b.report_id, dr.analysis_result, dr.images,
        u.nickname, u.phone as owner_phone
       FROM orders o
       LEFT JOIN biddings b ON o.bidding_id = b.bidding_id
       LEFT JOIN damage_reports dr ON b.report_id = dr.report_id
       LEFT JOIN users u ON o.user_id = u.user_id
       WHERE o.order_id = ? AND o.shop_id = ?`,
      [id, shopId]
    );
    if (orders.length === 0) return res.status(404).json(errorResponse('订单不存在'));

    const o = orders[0];
    let vehicleInfo = {};
    let analysis = {};
    let images = [];
    try {
      vehicleInfo = typeof o.vehicle_info === 'string' ? JSON.parse(o.vehicle_info) : (o.vehicle_info || {});
      analysis = typeof o.analysis_result === 'string' ? JSON.parse(o.analysis_result || '{}') : (o.analysis_result || {});
      images = typeof o.images === 'string' ? JSON.parse(o.images || '[]') : (o.images || []);
    } catch (_) {}

    const [quote] = await pool.execute(
      'SELECT amount, items, duration, warranty, remark FROM quotes WHERE quote_id = ?',
      [o.quote_id]
    );

    res.json(successResponse({
      order_id: o.order_id,
      bidding_id: o.bidding_id,
      status: o.status,
      quoted_amount: o.quoted_amount,
      order_tier: o.order_tier,
      complexity_level: o.complexity_level,
      commission_rate: o.commission_rate,
      vehicle_info: vehicleInfo,
      analysis_result: analysis,
      images,
      owner_nickname: o.nickname,
      owner_phone: o.owner_phone,
      quote: quote.length > 0 ? {
        amount: quote[0].amount,
        items: typeof quote[0].items === 'string' ? JSON.parse(quote[0].items || '[]') : (quote[0].items || []),
        duration: quote[0].duration,
        warranty: quote[0].warranty,
        remark: quote[0].remark
      } : null,
      created_at: o.created_at
    }));
  } catch (error) {
    console.error('服务商订单详情错误:', error);
    res.status(500).json(errorResponse('获取订单详情失败', 500));
  }
});

// 接单
app.post('/api/v1/merchant/orders/:id/accept', authenticateMerchant, async (req, res) => {
  try {
    const { id } = req.params;
    const shopId = req.shopId;

    const [orders] = await pool.execute(
      'SELECT order_id, status FROM orders WHERE order_id = ? AND shop_id = ?',
      [id, shopId]
    );
    if (orders.length === 0) return res.status(404).json(errorResponse('订单不存在'));
    if (orders[0].status !== 0) return res.status(400).json(errorResponse('该订单已接单或已结束'));

    await pool.execute(
      'UPDATE orders SET status = 1, updated_at = NOW() WHERE order_id = ?',
      [id]
    );
    res.json(successResponse({ order_id: id }, '接单成功'));
  } catch (error) {
    console.error('接单错误:', error);
    res.status(500).json(errorResponse('接单失败', 500));
  }
});

// 更新订单状态（维修中→待确认）
app.put('/api/v1/merchant/orders/:id/status', authenticateMerchant, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const shopId = req.shopId;

    const [orders] = await pool.execute(
      'SELECT order_id, status as current_status FROM orders WHERE order_id = ? AND shop_id = ?',
      [id, shopId]
    );
    if (orders.length === 0) return res.status(404).json(errorResponse('订单不存在'));

    const current = parseInt(orders[0].current_status, 10);
    const target = parseInt(status, 10);

    if (current === 1 && target === 2) {
      await pool.execute(
        'UPDATE orders SET status = 2, updated_at = NOW() WHERE order_id = ?',
        [id]
      );
      return res.json(successResponse({ order_id: id }, '已标记为待用户确认'));
    }
    return res.status(400).json(errorResponse('当前状态不可更新'));
  } catch (error) {
    console.error('更新订单状态错误:', error);
    res.status(500).json(errorResponse('更新失败', 500));
  }
});

// 获取/更新本店信息
app.get('/api/v1/merchant/shop', authenticateMerchant, async (req, res) => {
  try {
    const [shops] = await pool.execute(
      'SELECT * FROM shops WHERE shop_id = ?',
      [req.shopId]
    );
    if (shops.length === 0) return res.status(404).json(errorResponse('店铺不存在'));

    const s = shops[0];
    res.json(successResponse({
      shop_id: s.shop_id,
      name: s.name,
      logo: s.logo,
      address: s.address,
      province: s.province,
      city: s.city,
      district: s.district,
      latitude: s.latitude,
      longitude: s.longitude,
      phone: s.phone,
      business_hours: s.business_hours,
      categories: typeof s.categories === 'string' ? JSON.parse(s.categories || '[]') : (s.categories || []),
      certifications: typeof s.certifications === 'string' ? JSON.parse(s.certifications || '[]') : (s.certifications || []),
      qualification_level: s.qualification_level,
      technician_certs: typeof s.technician_certs === 'string' ? (s.technician_certs ? JSON.parse(s.technician_certs) : null) : s.technician_certs
    }));
  } catch (error) {
    console.error('获取店铺信息错误:', error);
    res.status(500).json(errorResponse('获取店铺信息失败', 500));
  }
});

app.put('/api/v1/merchant/shop', authenticateMerchant, async (req, res) => {
  try {
    const { name, address, latitude, longitude, phone, business_hours, categories, qualification_level, technician_certs } = req.body;
    const [shops] = await pool.execute('SELECT name, address, latitude, longitude, phone, business_hours, categories, qualification_level, technician_certs FROM shops WHERE shop_id = ?', [req.shopId]);
    if (shops.length === 0) return res.status(404).json(errorResponse('店铺不存在'));

    const s = shops[0];
    const updates = {
      name: name != null ? String(name).trim() : s.name,
      address: address != null ? String(address).trim() : s.address,
      latitude: latitude != null && !isNaN(Number(latitude)) ? Number(latitude) : s.latitude,
      longitude: longitude != null && !isNaN(Number(longitude)) ? Number(longitude) : s.longitude,
      phone: phone != null ? String(phone).trim() : s.phone,
      business_hours: business_hours != null ? String(business_hours) : s.business_hours,
      categories: categories != null ? JSON.stringify(categories) : s.categories,
      qualification_level: qualification_level !== undefined ? (qualification_level || null) : s.qualification_level,
      technician_certs: technician_certs !== undefined ? (technician_certs ? JSON.stringify(technician_certs) : null) : s.technician_certs
    };

    await pool.execute(
      `UPDATE shops SET name = ?, address = ?, latitude = ?, longitude = ?, phone = ?, business_hours = ?, categories = ?, qualification_level = ?, technician_certs = ?, updated_at = NOW()
       WHERE shop_id = ?`,
      [updates.name, updates.address, updates.latitude, updates.longitude, updates.phone, updates.business_hours, updates.categories, updates.qualification_level, updates.technician_certs, req.shopId]
    );
    res.json(successResponse(null, '保存成功'));
  } catch (error) {
    console.error('更新店铺信息错误:', error);
    res.status(500).json(errorResponse('保存失败', 500));
  }
});

// 获取用户信息
app.get('/api/v1/user/profile', authenticateToken, async (req, res) => {
  try {
    const [users] = await pool.execute(
      'SELECT * FROM users WHERE user_id = ?',
      [req.userId]
    );

    if (users.length === 0) {
      return res.status(404).json(errorResponse('用户不存在', 404));
    }

    const user = users[0];
    res.json(successResponse({
      user_id: user.user_id,
      nickname: user.nickname,
      avatar_url: user.avatar_url,
      phone: user.phone,
      level: user.level,
      points: user.points,
      balance: user.balance,
      total_rebate: user.total_rebate,
      total_reviews: user.total_reviews,
      location: {
        province: user.province,
        city: user.city,
        district: user.district,
        latitude: user.latitude,
        longitude: user.longitude
      }
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取用户信息失败', 500));
  }
});

// 更新用户信息（支持部分字段更新）
app.put('/api/v1/user/profile', authenticateToken, async (req, res) => {
  try {
    const { nickname, avatar_url, phone } = req.body;
    const updates = [];
    const params = [];
    if (nickname !== undefined && nickname !== null) {
      updates.push('nickname = ?');
      params.push(String(nickname).trim());
    }
    if (avatar_url !== undefined && avatar_url !== null) {
      updates.push('avatar_url = ?');
      params.push(String(avatar_url).trim());
    }
    if (phone !== undefined && phone !== null) {
      updates.push('phone = ?');
      params.push(String(phone).trim());
    }
    if (updates.length === 0) {
      return res.status(400).json(errorResponse('请至少提供一个更新字段'));
    }
    updates.push('updated_at = NOW()');
    params.push(req.userId);
    await pool.execute(
      `UPDATE users SET ${updates.join(', ')} WHERE user_id = ?`,
      params
    );
    res.json(successResponse(null, '更新成功'));
  } catch (error) {
    console.error('[PUT /api/v1/user/profile]', error);
    res.status(500).json(errorResponse(error.message || '更新失败', 500));
  }
});

// 获取余额、累计返点、明细列表
app.get('/api/v1/user/balance', authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const [userRes, transRes, countRes] = await Promise.all([
      pool.execute('SELECT balance, total_rebate FROM users WHERE user_id = ?', [req.userId]),
      pool.execute(
        `SELECT transaction_id, type, amount, description, related_id, reward_tier, review_stage, tax_deducted, created_at
         FROM transactions WHERE user_id = ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [req.userId, limit, offset]
      ),
      pool.execute('SELECT COUNT(*) as total FROM transactions WHERE user_id = ?', [req.userId])
    ]);

    const userRows = userRes[0];
    const transactions = transRes[0];
    const countResult = countRes[0];
    const balance = userRows && userRows.length > 0 ? parseFloat(userRows[0].balance) || 0 : 0;
    const total_rebate = userRows && userRows.length > 0 ? parseFloat(userRows[0].total_rebate) || 0 : 0;

    res.json(successResponse({
      balance,
      total_rebate,
      list: transactions.map(t => ({
        transaction_id: t.transaction_id,
        type: t.type,
        amount: t.amount,
        description: t.description,
        related_id: t.related_id,
        reward_tier: t.reward_tier,
        review_stage: t.review_stage,
        tax_deducted: t.tax_deducted || 0,
        created_at: t.created_at
      })),
      total: countResult[0].total,
      page,
      limit
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取余额明细失败', 500));
  }
});

// 申请提现
app.post('/api/v1/user/withdraw', authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body;
    
    if (!amount || amount < 10) {
      return res.status(400).json(errorResponse('最低提现金额为10元'));
    }

    // 检查余额
    const [users] = await pool.execute(
      'SELECT balance FROM users WHERE user_id = ?',
      [req.userId]
    );

    if (users.length === 0 || users[0].balance < amount) {
      return res.status(400).json(errorResponse('余额不足'));
    }

    // 创建提现记录
    const withdrawId = 'W' + Date.now();
    await pool.execute(
      `INSERT INTO withdrawals (withdraw_id, user_id, amount, status, created_at) 
       VALUES (?, ?, ?, 0, NOW())`,
      [withdrawId, req.userId, amount]
    );

    // 冻结余额
    await pool.execute(
      'UPDATE users SET balance = balance - ? WHERE user_id = ?',
      [amount, req.userId]
    );

    res.json(successResponse({ withdraw_id: withdrawId }, '提现申请已提交'));
  } catch (error) {
    res.status(500).json(errorResponse('提现申请失败', 500));
  }
});

// 获取用户消息列表
app.get('/api/v1/user/messages', authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const offset = (page - 1) * limit;

    const [list] = await pool.execute(
      `SELECT message_id, type, title, content, related_id, is_read, created_at
       FROM user_messages
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [req.userId, limit, offset]
    );

    const [countRes] = await pool.execute(
      'SELECT COUNT(*) as total FROM user_messages WHERE user_id = ?',
      [req.userId]
    );

    res.json(successResponse({
      list,
      total: countRes[0].total,
      page,
      limit
    }));
  } catch (error) {
    console.error('获取消息列表失败:', error);
    res.status(500).json(errorResponse('获取消息列表失败', 500));
  }
});

// 标记消息已读
app.post('/api/v1/user/messages/read', authenticateToken, async (req, res) => {
  try {
    const { message_ids } = req.body;

    if (!message_ids || !Array.isArray(message_ids) || message_ids.length === 0) {
      return res.status(400).json(errorResponse('请提供 message_ids 数组'));
    }

    const placeholders = message_ids.map(() => '?').join(',');
    await pool.execute(
      `UPDATE user_messages SET is_read = 1 WHERE user_id = ? AND message_id IN (${placeholders})`,
      [req.userId, ...message_ids]
    );

    res.json(successResponse(null, '已标记已读'));
  } catch (error) {
    console.error('标记已读失败:', error);
    res.status(500).json(errorResponse('标记已读失败', 500));
  }
});

// 获取未读消息数量
app.get('/api/v1/user/messages/unread-count', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT COUNT(*) as count FROM user_messages WHERE user_id = ? AND is_read = 0',
      [req.userId]
    );

    res.json(successResponse({
      count: rows[0].count,
      unread_count: rows[0].count
    }));
  } catch (error) {
    console.error('获取未读数失败:', error);
    res.status(500).json(errorResponse('获取未读数失败', 500));
  }
});

// 用户竞价列表
app.get('/api/v1/user/biddings', authenticateToken, async (req, res) => {
  try {
    const status = req.query.status; // 0-进行中 1-已结束 2-已取消，不传则全部
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let where = 'WHERE b.user_id = ?';
    const params = [req.userId];
    if (status !== undefined && status !== '' && status !== null) {
      where += ' AND b.status = ?';
      params.push(parseInt(status, 10));
    }

    const [list] = await pool.execute(
      `SELECT b.bidding_id, b.report_id, b.vehicle_info, b.status, b.expire_at, b.created_at,
        b.selected_shop_id, b.range_km,
        dr.analysis_result,
        (SELECT COUNT(*) FROM quotes q WHERE q.bidding_id = b.bidding_id) as quote_count,
        (SELECT order_id FROM orders o WHERE o.bidding_id = b.bidding_id AND o.status != 4 LIMIT 1) as order_id
       FROM biddings b
       LEFT JOIN damage_reports dr ON b.report_id = dr.report_id
       ${where}
       ORDER BY b.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [countRes] = await pool.execute(
      `SELECT COUNT(*) as total FROM biddings b ${where}`,
      params
    );

    const items = list.map((row) => {
      let vehicleInfo = {};
      try {
        vehicleInfo = typeof row.vehicle_info === 'string' ? JSON.parse(row.vehicle_info) : (row.vehicle_info || {});
      } catch (_) {}
      return {
        bidding_id: row.bidding_id,
        report_id: row.report_id,
        vehicle_info: vehicleInfo,
        status: row.status,
        expire_at: row.expire_at,
        created_at: row.created_at,
        selected_shop_id: row.selected_shop_id,
        range_km: row.range_km,
        quote_count: row.quote_count || 0,
        order_id: row.order_id || null,
        analysis_result: row.analysis_result ? JSON.parse(row.analysis_result || '{}') : null
      };
    });

    res.json(successResponse({
      list: items,
      total: countRes[0].total,
      page,
      limit
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取竞价列表失败', 500));
  }
});

// 用户订单列表
app.get('/api/v1/user/orders', authenticateToken, async (req, res) => {
  try {
    const status = req.query.status; // 0-待接单 1-维修中 2-待确认 3-已完成 4-已取消，不传则全部
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let where = 'WHERE o.user_id = ?';
    const params = [req.userId];
    if (status !== undefined && status !== '' && status !== null) {
      where += ' AND o.status = ?';
      params.push(parseInt(status, 10));
    }

    const [list] = await pool.execute(
      `SELECT o.order_id, o.bidding_id, o.shop_id, o.quoted_amount, o.status, o.created_at,
        s.name as shop_name, s.logo as shop_logo
       FROM orders o
       LEFT JOIN shops s ON o.shop_id = s.shop_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [countRes] = await pool.execute(
      `SELECT COUNT(*) as total FROM orders o ${where}`,
      params
    );

    res.json(successResponse({
      list,
      total: countRes[0].total,
      page,
      limit
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取订单列表失败', 500));
  }
});

// 用户订单详情
app.get('/api/v1/user/orders/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT o.*, s.name as shop_name, s.logo as shop_logo, s.phone as shop_phone, s.address
       FROM orders o
       LEFT JOIN shops s ON o.shop_id = s.shop_id
       WHERE o.order_id = ? AND o.user_id = ?`,
      [id, req.userId]
    );
    if (rows.length === 0) return res.status(404).json(errorResponse('订单不存在', 404));
    const order = rows[0];
    if (order.status === 3) {
      const [firstReview] = await pool.execute(
        'SELECT review_id, created_at FROM reviews WHERE order_id = ? AND type = 1',
        [id]
      );
      const [followup] = await pool.execute(
        'SELECT review_id FROM reviews WHERE order_id = ? AND type = 2',
        [id]
      );
      const [returnReview] = await pool.execute(
        'SELECT review_id FROM reviews WHERE order_id = ? AND type = 3',
        [id]
      );
      if (firstReview.length > 0 && followup.length === 0 && returnReview.length === 0) {
        const created = new Date(firstReview[0].created_at);
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        const inWindow = created >= sixMonthsAgo;
        order.can_followup = inWindow;
        order.can_return = inWindow;
        order.first_review_id = firstReview[0].review_id;
      }
    }
    res.json(successResponse(order));
  } catch (error) {
    res.status(500).json(errorResponse('获取订单详情失败', 500));
  }
});

// 奖励金预估（评价体系：按《评价奖励金体系-设计方案》三维校准核算）
app.get('/api/v1/user/orders/:id/reward-preview', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [orders] = await pool.execute(
      `SELECT o.*, b.vehicle_info, b.bidding_id
       FROM orders o
       LEFT JOIN biddings b ON o.bidding_id = b.bidding_id
       WHERE o.order_id = ? AND o.user_id = ?`,
      [id, req.userId]
    );
    if (orders.length === 0) return res.status(404).json(errorResponse('订单不存在', 404));
    const order = orders[0];
    let vehicleInfo = {};
    try {
      vehicleInfo = typeof order.vehicle_info === 'string' ? JSON.parse(order.vehicle_info || '{}') : (order.vehicle_info || {});
    } catch (_) {}
    let quoteItems = [];
    if (order.quote_id) {
      const [quotes] = await pool.execute('SELECT items FROM quotes WHERE quote_id = ?', [order.quote_id]);
      if (quotes.length > 0 && quotes[0].items) {
        try {
          quoteItems = typeof quotes[0].items === 'string' ? JSON.parse(quotes[0].items) : (quotes[0].items || []);
        } catch (_) {}
      }
    }
    const [shops] = await pool.execute(
      'SELECT compliance_rate, complaint_rate FROM shops WHERE shop_id = ?',
      [order.shop_id]
    );
    const shop = shops.length > 0 ? shops[0] : {};
    const result = await rewardCalculator.calculateReward(pool, order, vehicleInfo, quoteItems, shop);
    res.json(successResponse({
      order_id: id,
      order_tier: result.order_tier,
      complexity_level: result.complexity_level,
      vehicle_price_tier: result.vehicle_price_tier,
      total_reward: result.reward_pre.toFixed(2),
      commission_rate: (result.commission_rate * 100).toFixed(1),
      commission_amount: result.commission_amount,
      stages: result.stages
    }));
  } catch (error) {
    console.error('[reward-preview]', error);
    res.status(500).json(errorResponse('获取奖励金预估失败', 500));
  }
});

// 获取订单的首次评价（用于追评入口）
app.get('/api/v1/user/orders/:id/first-review', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [orders] = await pool.execute(
      'SELECT order_id FROM orders WHERE order_id = ? AND user_id = ?',
      [id, req.userId]
    );
    if (orders.length === 0) return res.status(404).json(errorResponse('订单不存在', 404));
    const [reviews] = await pool.execute(
      'SELECT review_id, created_at FROM reviews WHERE order_id = ? AND type = 1',
      [id]
    );
    if (reviews.length === 0) return res.status(404).json(errorResponse('该订单暂无首次评价', 404));
    const [followup] = await pool.execute(
      'SELECT review_id FROM reviews WHERE order_id = ? AND type = 2',
      [id]
    );
    if (followup.length > 0) return res.status(400).json(errorResponse('您已提交过追评'));
    const created = new Date(reviews[0].created_at);
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    if (created < sixMonthsAgo) return res.status(400).json(errorResponse('追评已过期'));
    res.json(successResponse({ review_id: reviews[0].review_id }));
  } catch (error) {
    res.status(500).json(errorResponse('获取失败', 500));
  }
});

// 订单评价信息（含维修前照片、维修项目，供评价页使用）
app.get('/api/v1/user/orders/:id/for-review', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [orders] = await pool.execute(
      `SELECT o.*, s.name as shop_name, s.logo as shop_logo
       FROM orders o
       LEFT JOIN shops s ON o.shop_id = s.shop_id
       WHERE o.order_id = ? AND o.user_id = ?`,
      [id, req.userId]
    );
    if (orders.length === 0) return res.status(404).json(errorResponse('订单不存在', 404));
    const order = orders[0];

    // 检查是否已评价
    const [existing] = await pool.execute('SELECT review_id FROM reviews WHERE order_id = ?', [id]);
    if (existing.length > 0) return res.status(400).json(errorResponse('该订单已评价'));

    // 仅状态 3（已完成）可评价
    if (order.status !== 3) return res.status(400).json(errorResponse('订单未完成，暂不可评价'));

    let beforeImages = [];
    let repairItems = [];

    if (order.bidding_id) {
      const [biddings] = await pool.execute(
        'SELECT report_id FROM biddings WHERE bidding_id = ?',
        [order.bidding_id]
      );
      if (biddings.length > 0) {
        const [reports] = await pool.execute(
          'SELECT images FROM damage_reports WHERE report_id = ?',
          [biddings[0].report_id]
        );
        if (reports.length > 0 && reports[0].images) {
          try {
            beforeImages = typeof reports[0].images === 'string' ? JSON.parse(reports[0].images) : reports[0].images;
          } catch (_) {}
        }
      }

      const [quotes] = await pool.execute(
        'SELECT items FROM quotes WHERE bidding_id = ? AND shop_id = ?',
        [order.bidding_id, order.shop_id]
      );
      if (quotes.length > 0 && quotes[0].items) {
        try {
          repairItems = typeof quotes[0].items === 'string' ? JSON.parse(quotes[0].items) : quotes[0].items;
        } catch (_) {}
      }
    }

    // 奖励金按《评价奖励金体系-设计方案》核算，此处仅作展示用占位
    const amount = parseFloat(order.actual_amount || order.quoted_amount) || 0;
    const rebateAmount = order.reward_preview != null ? parseFloat(order.reward_preview) : (amount * 0.08);

    res.json(successResponse({
      order_id: order.order_id,
      shop_name: order.shop_name,
      shop_logo: order.shop_logo,
      quoted_amount: order.quoted_amount,
      before_images: beforeImages,
      repair_items: repairItems,
      rebate_rate: rebateRate,
      rebate_amount: rebateAmount.toFixed(2)
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取评价信息失败', 500));
  }
});

// 取消订单（订单已完成前可撤销；撤销后竞价重开，可重新选择其他报价）
app.post('/api/v1/user/orders/:id/cancel', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [orders] = await pool.execute(
      'SELECT order_id, bidding_id, status FROM orders WHERE order_id = ? AND user_id = ?',
      [id, req.userId]
    );
    if (orders.length === 0) return res.status(404).json(errorResponse('订单不存在', 404));
    const order = orders[0];
    if (order.status === 3) return res.status(400).json(errorResponse('订单已完成，无法撤销'));
    if (order.status === 4) return res.status(400).json(errorResponse('订单已取消'));

    await pool.execute('UPDATE orders SET status = 4, updated_at = NOW() WHERE order_id = ?', [id]);
    if (order.bidding_id) {
      await pool.execute(
        'UPDATE biddings SET status = 0, selected_shop_id = NULL, updated_at = NOW() WHERE bidding_id = ?',
        [order.bidding_id]
      );
    }
    res.json(successResponse({ order_id: id }, '已撤销，可重新选择其他报价'));
  } catch (error) {
    res.status(500).json(errorResponse('取消订单失败', 500));
  }
});

// 确认完成（维修厂完成后，用户确认维修完成，状态 2->3）
app.post('/api/v1/user/orders/:id/confirm', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [orders] = await pool.execute(
      'SELECT order_id, status, quoted_amount, actual_amount, commission_rate FROM orders WHERE order_id = ? AND user_id = ?',
      [id, req.userId]
    );
    if (orders.length === 0) return res.status(404).json(errorResponse('订单不存在', 404));
    const order = orders[0];
    if (order.status !== 2) return res.status(400).json(errorResponse('当前状态不可确认完成'));
    const amount = parseFloat(order.actual_amount || order.quoted_amount) || 0;
    const rate = (parseFloat(order.commission_rate) || 0) / 100;
    const commission = Math.round(amount * rate * 100) / 100;
    await pool.execute(
      'UPDATE orders SET status = 3, completed_at = NOW(), updated_at = NOW(), commission = ? WHERE order_id = ?',
      [commission, id]
    );
    res.json(successResponse({ order_id: id }, '已确认完成'));
  } catch (error) {
    res.status(500).json(errorResponse('确认完成失败', 500));
  }
});

// ===================== 2. 定损相关接口 =====================

// 从 settings 表读取配置（运营后台可修改）
async function getSetting(key, defaultValue = '') {
  try {
    const [rows] = await pool.execute('SELECT `value` FROM settings WHERE `key` = ?', [key]);
    return rows.length > 0 ? String(rows[0].value || '').trim() : defaultValue;
  } catch {
    return defaultValue;
  }
}

// 检查用户今日 AI 调用次数是否超限
async function checkAiDailyLimit(userId) {
  const limitStr = await getSetting('ai_daily_limit', '5');
  const maxCount = Math.max(0, parseInt(limitStr, 10) || 5);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const [rows] = await pool.execute(
    'SELECT COUNT(*) as cnt FROM ai_call_log WHERE user_id = ? AND call_date = ?',
    [userId, today]
  );
  const currentCount = rows[0]?.cnt || 0;
  return {
    allowed: currentCount < maxCount,
    currentCount,
    maxCount,
    message: currentCount >= maxCount
      ? `今日 AI 定损调用已达上限（${maxCount}次），请明日再试`
      : `今日剩余 ${maxCount - currentCount} 次`
  };
}

// 记录 AI 调用（每次分析请求记一次，便于统计与控制成本）
async function recordAiCall(userId, reportId) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await pool.execute(
      'INSERT INTO ai_call_log (user_id, report_id, call_date) VALUES (?, ?, ?)',
      [userId, reportId, today]
    );
  } catch (err) {
    console.error('[damage/analyze] 记录 AI 调用失败:', err.message);
  }
}

// 模拟定损结果（API 未配置或调用失败时使用）
function getMockAnalysisResult(reportId, vehicleInfo) {
  return {
    report_id: reportId,
    vehicle_info: [
      {
        vehicleId: '车辆1',
        plate_number: vehicleInfo?.plate_number || '',
        brand: vehicleInfo?.brand || '',
        model: vehicleInfo?.model || '',
        color: vehicleInfo?.color || '',
        damagedParts: ['前保险杠'],
        damageTypes: ['凹陷'],
        overallSeverity: '中等',
        damageSummary: '前保险杠钣金修复、喷漆'
      }
    ],
    damages: [
      { part: '前保险杠', type: '凹陷', severity: '中等', area: '15x20cm', material: '钢质', vehicleId: '车辆1' }
    ],
    repair_suggestions: [
      { item: '钣金修复', price_range: [800, 1200] },
      { item: '喷漆', price_range: [600, 900] }
    ],
    total_estimate: [2000, 3500],
    confidence_score: 0.88
  };
}

// AI定损分析
// 流程：1) 校验请求携带的 user_id 2) 检查每日调用次数 3) 调用 AI 4) 生成 report_id 后一次性写入 damage_reports（user_id + 原始分析结果）
app.post('/api/v1/damage/analyze', authenticateToken, async (req, res) => {
  try {
    const { user_id, images, vehicle_info } = req.body;
    const vehicleInfo = vehicle_info && typeof vehicle_info === 'object' ? vehicle_info : {};

    if (!images || images.length === 0) {
      return res.status(400).json(errorResponse('请上传事故照片'));
    }

    // 校验请求携带的 user_id 与 token 一致（前端上传时需携带 user_id）
    const bodyUserId = user_id && String(user_id).trim();
    if (!bodyUserId || bodyUserId !== req.userId) {
      return res.status(400).json(errorResponse('user_id 无效或与登录用户不一致'));
    }

    // 1. 检查每日 AI 调用次数（参数由运营后台 settings.ai_daily_limit 控制）
    const limitCheck = await checkAiDailyLimit(req.userId);
    if (!limitCheck.allowed) {
      return res.status(429).json(errorResponse(limitCheck.message, 429));
    }

    // 2. 生成 report_id（服务器端生成，与用户信息一并保存）
    const reportId = 'RPT' + Date.now();

    // 3. 调用阿里云千问 API 或使用模拟结果（此时尚未写入数据库）
    const { enhanceAnalysisWithKnowledge } = require('./knowledge-base');
    const { analyzeWithQwen } = require('./qwen-analyzer');
    const apiKey = process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '';

    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    const absoluteImageUrls = (images || []).map((url) => {
      const u = String(url || '').trim();
      if (u.startsWith('http')) return u;
      return baseUrl.replace(/\/$/, '') + (u.startsWith('/') ? u : '/' + u);
    });

    let analysisResult;
    if (apiKey && absoluteImageUrls.length > 0) {
      try {
        console.log('[damage/analyze] 调用千问 API 分析', absoluteImageUrls.length, '张照片');
        analysisResult = await analyzeWithQwen(absoluteImageUrls, vehicleInfo, reportId, apiKey);
        console.log('[damage/analyze] 千问分析完成');
      } catch (err) {
        console.error('[damage/analyze] 千问 API 失败，使用模拟结果:', err.message);
        analysisResult = getMockAnalysisResult(reportId, vehicleInfo);
      }
    } else {
      analysisResult = getMockAnalysisResult(reportId, vehicleInfo);
    }

    const enhanced = enhanceAnalysisWithKnowledge(analysisResult);

    // 4. 一次性写入：用户信息 + 分析结果，减少重复、避免用户未关闭/离开时丢失数据
    enhanced.report_id = reportId;
    await pool.execute(
      `INSERT INTO damage_reports (report_id, user_id, vehicle_info, images, analysis_result, status, created_at) 
       VALUES (?, ?, ?, ?, ?, 1, NOW())`,
      [reportId, req.userId, JSON.stringify(vehicleInfo), JSON.stringify(images), JSON.stringify(enhanced)]
    );

    // 5. 记录本次调用（用于每日次数统计）
    await recordAiCall(req.userId, reportId);

    res.json(successResponse(enhanced, '分析完成'));
  } catch (error) {
    console.error('AI定损分析错误:', error);
    res.status(500).json(errorResponse('分析失败', 500));
  }
});

// 获取定损报告列表（个人中心-历史记录）
app.get('/api/v1/damage/reports', authenticateToken, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;

    const [reports] = await pool.execute(
      `SELECT report_id, vehicle_info, images, analysis_result, status, created_at 
       FROM damage_reports 
       WHERE user_id = ? 
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      [req.userId, limit, offset]
    );

    const [countRes] = await pool.execute(
      'SELECT COUNT(*) as total FROM damage_reports WHERE user_id = ?',
      [req.userId]
    );

    const list = reports.map((r) => {
      const ar = JSON.parse(r.analysis_result || '{}');
      const vi = JSON.parse(r.vehicle_info || '{}');
      let damageLevel = ar.damage_level || '';
      const damages = ar.damages || [];
      const totalEst = ar.total_estimate || [0, 0];
      // 无伤时显示「无伤」，避免三级损伤与无伤混淆
      if (damageLevel === '三级' && (!damages.length || (totalEst[0] === 0 && totalEst[1] === 0))) {
        damageLevel = '无伤';
      }
      return {
        report_id: r.report_id,
        vehicle_info: vi,
        images: JSON.parse(r.images || '[]'),
        damage_level: damageLevel,
        total_estimate: totalEst,
        status: r.status,
        created_at: r.created_at
      };
    });

    res.json(successResponse({ list, total: countRes[0].total, page, limit }));
  } catch (error) {
    console.error('获取定损报告列表失败:', error);
    res.status(500).json(errorResponse('获取报告列表失败', 500));
  }
});

// 获取定损报告
app.get('/api/v1/damage/report/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [reports] = await pool.execute(
      'SELECT * FROM damage_reports WHERE report_id = ? AND user_id = ?',
      [id, req.userId]
    );

    if (reports.length === 0) {
      return res.status(404).json(errorResponse('报告不存在', 404));
    }

    const report = reports[0];
    res.json(successResponse({
      report_id: report.report_id,
      vehicle_info: JSON.parse(report.vehicle_info || '{}'),
      images: JSON.parse(report.images || '[]'),
      analysis_result: JSON.parse(report.analysis_result || '{}'),
      status: report.status,
      created_at: report.created_at
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取报告失败', 500));
  }
});

// ===================== 3. 竞价相关接口 =====================

// 创建竞价
app.post('/api/v1/bidding/create', authenticateToken, async (req, res) => {
  try {
    const { report_id, range, insurance_info, vehicle_info } = req.body;

    if (!report_id) {
      return res.status(400).json(errorResponse('定损报告ID不能为空'));
    }

    const biddingId = 'BID' + Date.now();
    const expireAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24小时后过期

    await pool.execute(
      `INSERT INTO biddings (bidding_id, user_id, report_id, vehicle_info, 
       insurance_info, range_km, status, expire_at, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, NOW())`,
      [biddingId, req.userId, report_id, 
       JSON.stringify(vehicle_info), 
       JSON.stringify(insurance_info), 
       range || 5, expireAt]
    );

    res.json(successResponse({ bidding_id: biddingId }, '竞价创建成功'));
  } catch (error) {
    console.error('创建竞价错误:', error);
    res.status(500).json(errorResponse('创建竞价失败', 500));
  }
});

// 获取竞价详情
app.get('/api/v1/bidding/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [biddings] = await pool.execute(
      `SELECT b.*, dr.analysis_result 
       FROM biddings b 
       LEFT JOIN damage_reports dr ON b.report_id = dr.report_id 
       WHERE b.bidding_id = ? AND b.user_id = ?`,
      [id, req.userId]
    );

    if (biddings.length === 0) {
      return res.status(404).json(errorResponse('竞价不存在', 404));
    }

    const bidding = biddings[0];
    
    // 获取报价数量
    const [quoteCount] = await pool.execute(
      'SELECT COUNT(*) as count FROM quotes WHERE bidding_id = ?',
      [id]
    );

    res.json(successResponse({
      bidding_id: bidding.bidding_id,
      status: bidding.status,
      expire_at: bidding.expire_at,
      quote_count: quoteCount[0].count,
      vehicle_info: JSON.parse(bidding.vehicle_info || '{}'),
      insurance_info: JSON.parse(bidding.insurance_info || '{}'),
      analysis_result: JSON.parse(bidding.analysis_result || '{}')
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取竞价详情失败', 500));
  }
});

// 获取报价列表
app.get('/api/v1/bidding/:id/quotes', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { sort_type = 'default' } = req.query;

    let orderBy = 'q.created_at ASC';
    if (sort_type === 'price_asc') {
      orderBy = 'q.amount ASC';
    } else if (sort_type === 'rating') {
      orderBy = 's.rating DESC';
    }

    const [quotes] = await pool.execute(
      `SELECT q.*, s.name as shop_name, s.logo, s.rating, s.deviation_rate, s.total_orders,
        (6371 * acos(cos(radians(?)) * cos(radians(s.latitude)) * 
        cos(radians(s.longitude) - radians(?)) + sin(radians(?)) * sin(radians(s.latitude)))) AS distance
       FROM quotes q 
       JOIN shops s ON q.shop_id = s.shop_id 
       WHERE q.bidding_id = ? 
       ORDER BY ${orderBy}`,
      [req.query.latitude || 0, req.query.longitude || 0, req.query.latitude || 0, id]
    );

    res.json(successResponse({
      list: quotes.map(q => ({
        quote_id: q.quote_id,
        shop_id: q.shop_id,
        shop_name: q.shop_name,
        logo: q.logo,
        rating: q.rating,
        deviation_rate: q.deviation_rate,
        total_orders: q.total_orders,
        amount: q.amount,
        items: JSON.parse(q.items || '[]'),
        duration: q.duration,
        warranty: q.warranty,
        remark: q.remark,
        distance: q.distance ? Math.round(q.distance * 10) / 10 : null,
        created_at: q.created_at
      })),
      total: quotes.length
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取报价列表失败', 500));
  }
});

// 选择维修厂
app.post('/api/v1/bidding/:id/select', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { shop_id } = req.body;

    if (!shop_id) {
      return res.status(400).json(errorResponse('维修厂ID不能为空'));
    }

    // 同一竞价只能选择一次，已选则不允许再选（已取消的订单除外，由 cancel 接口处理竞价重开）
    const [existingOrder] = await pool.execute(
      'SELECT order_id FROM orders WHERE bidding_id = ? AND status != 4 LIMIT 1',
      [id]
    );
    if (existingOrder.length > 0) {
      return res.status(400).json(errorResponse('该竞价已选择维修厂，请勿重复操作'));
    }

    const [biddingCheck] = await pool.execute(
      'SELECT status FROM biddings WHERE bidding_id = ?',
      [id]
    );
    if (biddingCheck.length > 0 && biddingCheck[0].status !== 0) {
      return res.status(400).json(errorResponse('该竞价已结束'));
    }

    // 获取选中的报价
    const [quotes] = await pool.execute(
      'SELECT * FROM quotes WHERE bidding_id = ? AND shop_id = ?',
      [id, shop_id]
    );

    if (quotes.length === 0) {
      return res.status(404).json(errorResponse('报价不存在', 404));
    }

    const quote = quotes[0];

    // 防刷：黑名单校验
    const ip = req.ip || req.headers['x-forwarded-for'] || '';
    const [userRow] = await pool.execute('SELECT phone FROM users WHERE user_id = ?', [req.userId]);
    const bl = await antifraud.checkBlacklist(pool, req.userId, userRow[0]?.phone, ip);
    if (bl.blocked) {
      return res.status(403).json(errorResponse(bl.reason || '账号存在异常，暂无法下单', 403));
    }

    // 防刷-事前风控：同用户 N 天内同商户 ≤M 次、新用户 N 天内 ≤M 次（从配置读取）
    const afConfig = await antifraud.getAntifraudConfig(pool);
    const [userCreatedRow] = await pool.execute('SELECT created_at FROM users WHERE user_id = ?', [req.userId]);
    const userCreatedAt = userCreatedRow.length > 0 ? new Date(userCreatedRow[0].created_at) : null;
    const now = new Date();
    const sameShopDaysAgo = new Date(now.getTime() - afConfig.orderSameShopDays * 24 * 60 * 60 * 1000);
    const newUserDaysAgo = new Date(now.getTime() - afConfig.newUserDays * 24 * 60 * 60 * 1000);

    const [sameShopCount] = await pool.execute(
      `SELECT COUNT(*) as c FROM orders WHERE user_id = ? AND shop_id = ? AND created_at >= ? AND status != 4`,
      [req.userId, shop_id, sameShopDaysAgo]
    );
    if ((sameShopCount[0]?.c || 0) >= afConfig.orderSameShopMax) {
      return res.status(400).json(errorResponse(`您在该商户 ${afConfig.orderSameShopDays} 天内已有 ${afConfig.orderSameShopMax} 笔订单，为保障交易真实性暂无法继续下单`));
    }

    const isNewUser = userCreatedAt && userCreatedAt > newUserDaysAgo;
    if (isNewUser) {
      const [recentOrders] = await pool.execute(
        `SELECT COUNT(*) as c FROM orders WHERE user_id = ? AND created_at >= ? AND status != 4`,
        [req.userId, newUserDaysAgo]
      );
      if ((recentOrders[0]?.c || 0) >= afConfig.newUserOrderMax) {
        return res.status(400).json(errorResponse(`新用户 ${afConfig.newUserDays} 天内最多下单 ${afConfig.newUserOrderMax} 笔，为保障交易真实性请稍后再试`));
      }
    }

    // 创建订单
    const orderId = 'ORD' + Date.now();
    await pool.execute(
      `INSERT INTO orders (order_id, bidding_id, user_id, shop_id, quote_id, 
       quoted_amount, status, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, 0, NOW())`,
      [orderId, id, req.userId, shop_id, quote.quote_id, quote.amount]
    );

    // 计算订单分级、复杂度、车价分级、奖励金预估、佣金比例并回写
    try {
      const [biddings] = await pool.execute('SELECT vehicle_info FROM biddings WHERE bidding_id = ?', [id]);
      let vehicleInfo = {};
      if (biddings.length > 0 && biddings[0].vehicle_info) {
        try {
          vehicleInfo = typeof biddings[0].vehicle_info === 'string' ? JSON.parse(biddings[0].vehicle_info) : biddings[0].vehicle_info;
        } catch (_) {}
      }
      let quoteItems = [];
      if (quote.items) {
        try {
          quoteItems = typeof quote.items === 'string' ? JSON.parse(quote.items) : quote.items;
        } catch (_) {}
      }
      const [shops] = await pool.execute('SELECT compliance_rate, complaint_rate FROM shops WHERE shop_id = ?', [shop_id]);
      const shop = shops.length > 0 ? shops[0] : {};
      const orderRow = { quoted_amount: quote.amount, actual_amount: null, order_tier: null, complexity_level: null, vehicle_price_tier: null };
      const result = await rewardCalculator.calculateReward(pool, orderRow, vehicleInfo, quoteItems, shop);
      await pool.execute(
        `UPDATE orders SET order_tier = ?, complexity_level = ?, vehicle_price_tier = ?,
         reward_preview = ?, commission_rate = ? WHERE order_id = ?`,
        [result.order_tier, result.complexity_level, result.vehicle_price_tier, result.reward_pre, result.commission_rate * 100, orderId]
      );
    } catch (err) {
      console.error('[选厂下单] 奖励金/佣金计算失败:', err.message);
    }

    // 更新竞价状态
    await pool.execute(
      'UPDATE biddings SET status = 1, selected_shop_id = ?, updated_at = NOW() WHERE bidding_id = ?',
      [shop_id, id]
    );

    res.json(successResponse({ order_id: orderId }, '选择成功，订单已生成'));
  } catch (error) {
    res.status(500).json(errorResponse('选择维修厂失败', 500));
  }
});

// 结束竞价（用户主动结束进行中的竞价）
app.post('/api/v1/bidding/:id/end', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const [biddings] = await pool.execute(
      'SELECT bidding_id, status FROM biddings WHERE bidding_id = ? AND user_id = ?',
      [id, req.userId]
    );
    if (biddings.length === 0) {
      return res.status(404).json(errorResponse('竞价不存在', 404));
    }
    if (biddings[0].status !== 0) {
      return res.status(400).json(errorResponse('该竞价已结束'));
    }

    await pool.execute(
      'UPDATE biddings SET status = 1, updated_at = NOW() WHERE bidding_id = ?',
      [id]
    );

    res.json(successResponse(null, '竞价已结束'));
  } catch (error) {
    res.status(500).json(errorResponse('结束竞价失败', 500));
  }
});

// ===================== 开发测试：模拟报价（仅开发环境，用于车主端竞价报价页测试） =====================
// 生产环境不注册此路由
if (process.env.NODE_ENV !== 'production') {
  app.post('/api/v1/dev/seed-quotes', async (req, res) => {
    try {
      const { bidding_id } = req.body || {};
      if (!bidding_id) {
        return res.status(400).json(errorResponse('请提供 bidding_id'));
      }
      const [biddings] = await pool.execute(
        'SELECT bidding_id, status FROM biddings WHERE bidding_id = ?',
        [bidding_id]
      );
      if (biddings.length === 0) {
        return res.status(404).json(errorResponse('竞价不存在'));
      }
      if (biddings[0].status !== 0) {
        return res.status(400).json(errorResponse('仅支持进行中的竞价'));
      }
      const [shops] = await pool.execute(
        'SELECT shop_id FROM shops WHERE status = 1 LIMIT 5'
      );
      if (shops.length === 0) {
        return res.status(400).json(errorResponse('暂无可用维修厂，请先执行 seed 或添加 shops 数据'));
      }
      const [existing] = await pool.execute(
        'SELECT shop_id FROM quotes WHERE bidding_id = ?',
        [bidding_id]
      );
      const existingShopIds = new Set((existing || []).map((r) => r.shop_id));
      const toInsert = shops.filter((s) => !existingShopIds.has(s.shop_id));
      if (toInsert.length === 0) {
        return res.json(successResponse({ created: 0, message: '该竞价已有报价' }));
      }
      const baseAmount = 3000 + Math.floor(Math.random() * 5000);
      let created = 0;
      for (let i = 0; i < toInsert.length; i++) {
        const shopId = toInsert[i].shop_id;
        const quoteId = 'QUO' + Date.now() + '' + i;
        const amount = baseAmount + (i * 200) + Math.floor(Math.random() * 300);
        const duration = 3 + (i % 3);
        const warranty = 12;
        await pool.execute(
          `INSERT INTO quotes (quote_id, bidding_id, shop_id, amount, items, duration, warranty, remark)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            quoteId,
            bidding_id,
            shopId,
            amount,
            JSON.stringify([{ name: '钣金喷漆', price: amount * 0.6 }, { name: '工时费', price: amount * 0.4 }]),
            duration,
            warranty,
            '测试报价'
          ]
        );
        created++;
      }
      res.json(successResponse({ created }, `已生成 ${created} 条测试报价`));
    } catch (error) {
      console.error('seed-quotes 失败:', error);
      res.status(500).json(errorResponse('生成测试报价失败', 500));
    }
  });
}

// ===================== 4. 维修厂相关接口 =====================

// 获取附近维修厂
app.get('/api/v1/shops/nearby', async (req, res) => {
  try {
    const { latitude, longitude, page = 1, limit = 20, category, max_km } = req.query;
    const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const offset = (pageNum - 1) * limitNum;

    let whereClause = 'WHERE status = 1';
    const params = [];

    if (category) {
      whereClause += ' AND JSON_CONTAINS(categories, ?)';
      params.push(`"${category}"`);
    }

    // 如果有位置信息，按距离排序，距离限制从 settings.nearby_max_km 读取（运营后台可修改）
    if (latitude && longitude) {
      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);
      const maxKmFromSettings = parseFloat(await getSetting('nearby_max_km', '50')) || 50;
      const effectiveMaxKm = max_km != null ? Math.min(Math.max(parseFloat(max_km) || 50, 1), 500) : maxKmFromSettings;
      console.log('[shops/nearby] 收到位置', { lat, lng, max_km: effectiveMaxKm, from_settings: maxKmFromSettings });

      let sql = `SELECT *, 
          (6371 * acos(cos(radians(?)) * cos(radians(latitude)) * 
          cos(radians(longitude) - radians(?)) + sin(radians(?)) * sin(radians(latitude)))) AS distance
         FROM shops ${whereClause}`;
      const sqlParams = [lat, lng, lat, ...params];

      sql += ' HAVING distance <= ?';
      sqlParams.push(effectiveMaxKm);
      sql += ' ORDER BY distance LIMIT ? OFFSET ?';
      sqlParams.push(limitNum, offset);

      const [shops] = await pool.execute(sql, sqlParams);

      const distances = shops.slice(0, 3).map(s => `${s.name}: ${s.distance != null ? Math.round(s.distance * 10) / 10 + 'km' : '?'}`);
      console.log('[shops/nearby] 返回', { count: shops.length, 前3条: distances.join(' | ') });

      res.json(successResponse({
        list: shops.map(s => ({
          shop_id: s.shop_id,
          name: s.name,
          logo: s.logo,
          address: s.address,
          district: s.district,
          rating: s.rating,
          rating_count: s.rating_count,
          total_orders: s.total_orders,
          deviation_rate: s.deviation_rate,
          is_certified: !!s.is_certified,
          categories: JSON.parse(s.categories || '[]'),
          distance: Math.round(s.distance * 10) / 10
        })),
        total: shops.length
      }));
    } else {
      const [shops] = await pool.execute(
        `SELECT * FROM shops ${whereClause} LIMIT ? OFFSET ?`,
        [...params, limitNum, offset]
      );

      res.json(successResponse({
        list: shops.map(s => ({
          shop_id: s.shop_id,
          name: s.name,
          logo: s.logo,
          address: s.address,
          district: s.district,
          rating: s.rating,
          rating_count: s.rating_count,
          total_orders: s.total_orders,
          deviation_rate: s.deviation_rate,
          is_certified: !!s.is_certified,
          categories: JSON.parse(s.categories || '[]'),
          compliance_rate: s.compliance_rate,
          complaint_rate: s.complaint_rate,
          qualification_level: s.qualification_level,
          technician_certs: typeof s.technician_certs === 'string' ? (s.technician_certs ? JSON.parse(s.technician_certs) : null) : s.technician_certs
        })),
        total: shops.length
      }));
    }
  } catch (error) {
    console.error('获取维修厂错误:', error);
    res.status(500).json(errorResponse('获取维修厂列表失败: ' + (error.message || String(error)), 500));
  }
});

// 搜索维修厂（keyword、category、sort、分页）
app.get('/api/v1/shops/search', async (req, res) => {
  try {
    const { keyword, category, sort = 'default', page = 1, limit = 20, latitude, longitude } = req.query;
    const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const offset = (pageNum - 1) * limitNum;

    let whereClause = 'WHERE status = 1';
    const params = [];

    if (keyword && keyword.trim()) {
      whereClause += ' AND (name LIKE ? OR address LIKE ?)';
      const q = '%' + keyword.trim() + '%';
      params.push(q, q);
    }
    if (category) {
      whereClause += ' AND JSON_CONTAINS(categories, ?)';
      params.push(`"${category}"`);
    }

    let orderBy = 'total_orders DESC';
    if (sort === 'rating') {
      orderBy = 'rating DESC, total_orders DESC';
    } else if (sort === 'distance' && latitude && longitude) {
      orderBy = 'distance';
    } else if (sort === 'orders') {
      orderBy = 'total_orders DESC';
    } else if (sort === 'compliance_rate') {
      orderBy = 'COALESCE(compliance_rate, 0) DESC, total_orders DESC';
    } else if (sort === 'complaint_rate') {
      orderBy = 'COALESCE(complaint_rate, 100) ASC, total_orders DESC';
    }

    if (latitude && longitude) {
      const [shops] = await pool.execute(
        `SELECT *, 
          (6371 * acos(cos(radians(?)) * cos(radians(latitude)) * 
          cos(radians(longitude) - radians(?)) + sin(radians(?)) * sin(radians(latitude)))) AS distance
         FROM shops ${whereClause}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`,
        [latitude, longitude, latitude, ...params, limitNum, offset]
      );
      res.json(successResponse({
        list: shops.map(s => ({
          shop_id: s.shop_id,
          name: s.name,
          logo: s.logo,
          address: s.address,
          district: s.district,
          rating: s.rating,
          rating_count: s.rating_count,
          total_orders: s.total_orders,
          deviation_rate: s.deviation_rate,
          is_certified: !!s.is_certified,
          categories: JSON.parse(s.categories || '[]'),
          distance: s.distance != null ? Math.round(s.distance * 10) / 10 : null,
          compliance_rate: s.compliance_rate,
          complaint_rate: s.complaint_rate,
          qualification_level: s.qualification_level,
          technician_certs: typeof s.technician_certs === 'string' ? (s.technician_certs ? JSON.parse(s.technician_certs) : null) : s.technician_certs
        })),
        total: shops.length
      }));
    } else {
      const [shops] = await pool.execute(
        `SELECT * FROM shops ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        [...params, limitNum, offset]
      );
      res.json(successResponse({
        list: shops.map(s => ({
          shop_id: s.shop_id,
          name: s.name,
          logo: s.logo,
          address: s.address,
          district: s.district,
          rating: s.rating,
          rating_count: s.rating_count,
          total_orders: s.total_orders,
          deviation_rate: s.deviation_rate,
          is_certified: !!s.is_certified,
          categories: JSON.parse(s.categories || '[]'),
          compliance_rate: s.compliance_rate,
          complaint_rate: s.complaint_rate,
          qualification_level: s.qualification_level,
          technician_certs: typeof s.technician_certs === 'string' ? (s.technician_certs ? JSON.parse(s.technician_certs) : null) : s.technician_certs
        })),
        total: shops.length
      }));
    }
  } catch (error) {
    console.error('搜索维修厂错误:', error);
    res.status(500).json(errorResponse('搜索维修厂失败: ' + (error.message || String(error)), 500));
  }
});

// 获取维修厂详情
app.get('/api/v1/shops/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [shops] = await pool.execute(
      'SELECT * FROM shops WHERE shop_id = ?',
      [id]
    );

    if (shops.length === 0) {
      return res.status(404).json(errorResponse('维修厂不存在', 404));
    }

    const shop = shops[0];
    
    // 获取评价统计
    const [reviewStats] = await pool.execute(
      `SELECT 
        COUNT(*) as total_reviews,
        AVG(rating) as avg_rating,
        AVG(ratings_quality) as avg_quality,
        AVG(ratings_price) as avg_price,
        AVG(ratings_service) as avg_service
       FROM reviews WHERE shop_id = ?`,
      [id]
    );

    // 防刷-第二阶段：店铺加权得分（用于详情页展示，排序与好评率脱钩）
    const weightedScore = await antifraud.computeShopWeightedScore(pool, id);

    res.json(successResponse({
      shop_id: shop.shop_id,
      name: shop.name,
      logo: shop.logo,
      address: shop.address,
      province: shop.province,
      city: shop.city,
      district: shop.district,
      latitude: shop.latitude,
      longitude: shop.longitude,
      phone: shop.phone,
      business_hours: shop.business_hours,
      categories: JSON.parse(shop.categories || '[]'),
      certifications: JSON.parse(shop.certifications || '[]'),
      services: JSON.parse(shop.services || '[]'),
      rating: shop.rating,
      rating_count: shop.rating_count,
      deviation_rate: shop.deviation_rate,
      total_orders: shop.total_orders,
      is_certified: shop.is_certified,
      compliance_rate: shop.compliance_rate,
      complaint_rate: shop.complaint_rate,
      qualification_level: shop.qualification_level,
      technician_certs: typeof shop.technician_certs === 'string' ? (shop.technician_certs ? JSON.parse(shop.technician_certs) : null) : shop.technician_certs,
      review_stats: reviewStats[0],
      weighted_score: weightedScore.score,
      weighted_score_count: weightedScore.count
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取维修厂详情失败', 500));
  }
});

// 获取维修厂评价（排序：内容完整度优先、发布时间最新，与好评率脱钩）
app.get('/api/v1/shops/:id/reviews', async (req, res) => {
  try {
    const { id } = req.params;
    const { sort = 'completeness' } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const orderBy = sort === 'latest'
      ? 'r.created_at DESC'
      : '(CASE WHEN r.settlement_list_image IS NOT NULL AND r.settlement_list_image != "" THEN 1 ELSE 0 END) DESC, r.created_at DESC';
    const [reviews] = await pool.execute(
      `SELECT r.*, u.nickname, u.avatar_url 
       FROM reviews r 
       JOIN users u ON r.user_id = u.user_id 
       WHERE r.shop_id = ? AND r.type = 1
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [id, limit, offset]
    );

    const [countResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM reviews WHERE shop_id = ? AND type = 1',
      [id]
    );

    res.json(successResponse({
      list: reviews.map(r => ({
        review_id: r.review_id,
        user: {
          nickname: r.is_anonymous ? '匿名用户' : r.nickname,
          avatar_url: r.is_anonymous ? '' : r.avatar_url
        },
        rating: r.rating,
        ratings: {
          quality: r.ratings_quality,
          price: r.ratings_price,
          service: r.ratings_service,
          speed: r.ratings_speed,
          parts: r.ratings_parts
        },
        content: r.content,
        after_images: JSON.parse(r.after_images || '[]'),
        ai_analysis: JSON.parse(r.ai_analysis || '{}'),
        like_count: r.like_count,
        created_at: r.created_at
      })),
      total: countResult[0].total,
      page,
      limit
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取评价失败', 500));
  }
});

// 提交预约
app.post('/api/v1/appointments', authenticateToken, async (req, res) => {
  try {
    const { shop_id, appointment_date, time_slot, service_category, services, remark } = req.body;

    if (!shop_id || !appointment_date || !time_slot) {
      return res.status(400).json(errorResponse('预约信息不完整'));
    }

    const [shops] = await pool.execute('SELECT shop_id FROM shops WHERE shop_id = ? AND status = 1', [shop_id]);
    if (shops.length === 0) {
      return res.status(404).json(errorResponse('维修厂不存在', 404));
    }

    const validCategories = ['maintenance', 'wash', 'repair', 'other'];
    const cat = validCategories.includes(service_category) ? service_category : 'other';

    const appointmentId = 'APT' + Date.now();
    await pool.execute(
      `INSERT INTO appointments (appointment_id, user_id, shop_id, appointment_date, time_slot, service_category, services, remark, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [appointmentId, req.userId, shop_id, appointment_date, time_slot, cat, JSON.stringify(services || []), remark || null]
    );

    res.json(successResponse({ appointment_id: appointmentId }, '预约提交成功'));
  } catch (error) {
    console.error('提交预约错误:', error);
    res.status(500).json(errorResponse('预约提交失败: ' + (error.message || String(error)), 500));
  }
});

// ===================== 5. 评价相关接口 =====================

// 提交评价（评价体系：3 模块 1 次提交，支持新格式与旧格式兼容）
app.post('/api/v1/reviews', authenticateToken, async (req, res) => {
  try {
    const { order_id, module1, module2, module3, rating, ratings, content, after_images, is_anonymous } = req.body;

    if (!order_id) return res.status(400).json(errorResponse('订单ID不能为空'));

    const [orders] = await pool.execute(
      'SELECT * FROM orders WHERE order_id = ? AND user_id = ?',
      [order_id, req.userId]
    );
    if (orders.length === 0) return res.status(404).json(errorResponse('订单不存在', 404));
    const order = orders[0];

    const [existing] = await pool.execute('SELECT review_id FROM reviews WHERE order_id = ?', [order_id]);
    if (existing.length > 0) return res.status(400).json(errorResponse('该订单已评价'));

    // 防刷：黑名单校验
    const ip = req.ip || req.headers['x-forwarded-for'] || '';
    const [userForBl] = await pool.execute('SELECT phone FROM users WHERE user_id = ?', [req.userId]);
    const bl = await antifraud.checkBlacklist(pool, req.userId, userForBl[0]?.phone, ip);
    if (bl.blocked) {
      return res.status(403).json(errorResponse(bl.reason || '账号存在异常，暂无法评价', 403));
    }

    let vehicleInfo = {};
    let quoteItems = [];
    if (order.bidding_id) {
      const [biddings] = await pool.execute('SELECT vehicle_info FROM biddings WHERE bidding_id = ?', [order.bidding_id]);
      if (biddings.length > 0 && biddings[0].vehicle_info) {
        try {
          vehicleInfo = typeof biddings[0].vehicle_info === 'string' ? JSON.parse(biddings[0].vehicle_info) : biddings[0].vehicle_info;
        } catch (_) {}
      }
    }
    if (order.quote_id) {
      const [quotes] = await pool.execute('SELECT items FROM quotes WHERE quote_id = ?', [order.quote_id]);
      if (quotes.length > 0 && quotes[0].items) {
        try {
          quoteItems = typeof quotes[0].items === 'string' ? JSON.parse(quotes[0].items) : (quotes[0].items || []);
        } catch (_) {}
      }
    }
    const [shops] = await pool.execute('SELECT compliance_rate, complaint_rate, name FROM shops WHERE shop_id = ?', [order.shop_id]);
    const shop = shops.length > 0 ? shops[0] : {};
    const rewardResult = await rewardCalculator.calculateReward(pool, order, vehicleInfo, quoteItems, shop);
    const totalReward = rewardResult.reward_pre;
    const orderTier = rewardResult.order_tier;
    const complexityLevel = rewardResult.complexity_level || order.complexity_level || 'L2';

    // 新格式：module3 必填（完工验收）
    const isNewFormat = module3 && (module3.settlement_list_image || module3.completion_images);
    const m3 = module3 || {};
    const settlementImage = m3.settlement_list_image || null;
    const completionImages = m3.completion_images || after_images || [];
    const completionArr = Array.isArray(completionImages) ? completionImages : [];

    // 防刷-事中：L1-L2 必须双凭证（结算单 + 至少 2 张施工实拍图）
    if (complexityLevel === 'L1' || complexityLevel === 'L2') {
      if (!settlementImage || settlementImage.trim() === '') {
        return res.status(400).json(errorResponse('L1/L2 订单需上传维修结算清单（交易凭证），否则无法领取奖励金'));
      }
      if (completionArr.length < 2) {
        return res.status(400).json(errorResponse('L1/L2 订单需上传至少 2 张施工实拍图，否则无法领取奖励金'));
      }
    }

    // 防刷-第三阶段：AI 审核（千问）或内容反作弊兜底
    const contentForCheck = (m3.content || content || '').trim();
    const apiKey = process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '';
    let usedAiAudit = false;
    if (apiKey) {
      try {
        const baseUrl = process.env.BASE_URL || ((req.protocol || 'http') + '://' + (req.get('host') || `localhost:${PORT}`));
        const toAbsolute = (u) => {
          const s = String(u || '').trim();
          if (s.startsWith('http')) return s;
          return (baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl) + (s.startsWith('/') ? s : '/' + s);
        };
        const repairProjects = (quoteItems || []).map((i) => i.name || '').filter(Boolean);
        const quotedAmount = parseFloat(order.quoted_amount || order.actual_amount) || 0;
        const ratingNum = m3.ratings ? (m3.ratings.service ?? m3.ratings.price_transparency ?? m3.ratings.quality ?? 5) : (rating || 5);
        const aiInput = {
          order: {
            orderId: order_id,
            shopName: shop.name || '',
            quotedAmount: quotedAmount,
            repairProjects: repairProjects.length ? repairProjects : ['维修'],
            complexityLevel,
            faultDescription: ''
          },
          review: {
            content: contentForCheck,
            rating: ratingNum,
            isNegative: parseFloat(ratingNum) <= 2
          },
          images: []
        };
        if (settlementImage && settlementImage.trim()) {
          aiInput.images.push({ type: 'settlement', url: toAbsolute(settlementImage) });
        }
        (completionArr || []).slice(0, 5).forEach((url) => {
          if (url && String(url).trim()) aiInput.images.push({ type: 'completion', url: toAbsolute(url) });
        });
        const { analyzeReviewWithQwen } = require('./qwen-analyzer');
        const aiResult = await analyzeReviewWithQwen({ ...aiInput, apiKey });
        usedAiAudit = true;
        if (!aiResult.pass) {
          return res.status(400).json(errorResponse(aiResult.rejectReason || '评价未通过 AI 审核'));
        }
      } catch (err) {
        console.error('[reviews] 千问 AI 审核异常，回退规则校验:', err.message);
      }
    }
    if (!usedAiAudit && contentForCheck) {
      const contentCheck = await antifraud.checkContentAntiCheat(pool, contentForCheck);
      if (!contentCheck.pass) {
        return res.status(400).json(errorResponse(contentCheck.reason || '评价内容不符合要求'));
      }
    }

    const immediatePercent = orderTier <= 2 ? 1 : 0.5;
    let rewardAmount = totalReward * immediatePercent;

    // 防刷-事中：L1 每月奖励金封顶（从配置读取）
    const afConfig = await antifraud.getAntifraudConfig(pool);
    if (complexityLevel === 'L1' && rewardAmount > 0) {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const [l1Sum] = await pool.execute(
        `SELECT COALESCE(SUM(t.amount), 0) as total FROM transactions t
         JOIN reviews r ON t.related_id = r.review_id
         JOIN orders o ON r.order_id = o.order_id
         WHERE t.user_id = ? AND t.type = 'rebate' AND t.created_at >= ?
         AND o.complexity_level = 'L1'`,
        [req.userId, monthStart]
      );
      const currentMonthL1 = parseFloat(l1Sum[0]?.total || 0);
      const cap = afConfig.l1MonthlyCap;
      if (currentMonthL1 >= cap) {
        rewardAmount = 0;
      } else if (currentMonthL1 + rewardAmount > cap) {
        rewardAmount = Math.round((cap - currentMonthL1) * 100) / 100;
      }
    }

    // 个税：≤800 无税，>800 平台承担，用户领取税后全额
    const taxDeducted = rewardAmount > 800 ? Math.round((rewardAmount - 800) * 0.2 * 100) / 100 : 0;
    const userReceives = rewardAmount - taxDeducted;
    const objectiveAnswers = m3.q1_shop_match != null ? {
      q1_shop_match: m3.q1_shop_match,
      q2_settlement_match: m3.q2_settlement_match,
      q3_fault_resolved: m3.q3_fault_resolved,
      q4_warranty_informed: m3.q4_warranty_informed
    } : null;

    // 旧格式兼容：无 module3 时仍需 rating
    if (!isNewFormat && !rating) return res.status(400).json(errorResponse('请完成评价必填项'));

    let beforeImages = [];
    if (order.bidding_id) {
      const [biddings] = await pool.execute('SELECT report_id FROM biddings WHERE bidding_id = ?', [order.bidding_id]);
      if (biddings.length > 0) {
        const [reports] = await pool.execute('SELECT images FROM damage_reports WHERE report_id = ?', [biddings[0].report_id]);
        if (reports.length > 0 && reports[0].images) {
          try { beforeImages = typeof reports[0].images === 'string' ? JSON.parse(reports[0].images) : reports[0].images; } catch (_) {}
        }
      }
    }

    const ratingVal = m3.ratings ? (m3.ratings.price_transparency || m3.ratings.service) : rating;
    const ratingsObj = m3.ratings || ratings;
    const contentVal = m3.content || content || '';

    // 确保订单有 complexity_level（供 L1 封顶等后续查询使用）
    if (!order.complexity_level) {
      await pool.execute('UPDATE orders SET complexity_level = ?, order_tier = ? WHERE order_id = ?', [complexityLevel, orderTier, order_id]);
    }

    const reviewId = 'REV' + Date.now();
    await pool.execute(
      `INSERT INTO reviews (review_id, order_id, shop_id, user_id, type, review_stage, rating,
       ratings_quality, ratings_price, ratings_service, ratings_speed, ratings_parts,
       settlement_list_image, completion_images, objective_answers,
       content, before_images, after_images, is_anonymous, rebate_amount, reward_amount, tax_deducted, rebate_rate, status, created_at)
       VALUES (?, ?, ?, ?, 1, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, NOW())`,
      [reviewId, order_id, order.shop_id, req.userId,
       ratingVal, ratingsObj?.quality, ratingsObj?.price, ratingsObj?.service, ratingsObj?.speed, ratingsObj?.parts,
       settlementImage, JSON.stringify(Array.isArray(completionImages) ? completionImages : []), JSON.stringify(objectiveAnswers || {}),
       contentVal, JSON.stringify(beforeImages), JSON.stringify(Array.isArray(completionImages) ? completionImages : after_images || []),
       is_anonymous || false, userReceives, rewardAmount, taxDeducted]
    );

    if (userReceives > 0) {
      await pool.execute(
        'UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?',
        [userReceives, userReceives, req.userId]
      );
      await pool.execute(
        `INSERT INTO transactions (transaction_id, user_id, type, amount, description, related_id, reward_tier, review_stage, tax_deducted, created_at)
         VALUES (?, ?, 'rebate', ?, '主评价奖励金', ?, ?, 'main', ?, NOW())`,
        ['TXN' + Date.now(), req.userId, userReceives, reviewId, orderTier, taxDeducted]
      );
    }

    try {
      await pool.execute(
        `INSERT INTO review_audit_logs (review_id, audit_type, result, created_at) VALUES (?, 'ai', 'pass', NOW())`,
        [reviewId]
      );
    } catch (_) {}

    res.json(successResponse({
      review_id: reviewId,
      reward: { amount: userReceives.toFixed(2), tax_deducted: taxDeducted, stages: orderTier <= 2 ? '100%' : '50%' }
    }, '评价提交成功'));
  } catch (error) {
    console.error('提交评价错误:', error);
    res.status(500).json(errorResponse('提交评价失败', 500));
  }
});

// 获取评价详情（用于追评页校验与展示）
app.get('/api/v1/reviews/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [reviews] = await pool.execute(
      `SELECT r.*, s.name as shop_name, o.quoted_amount, o.actual_amount, o.order_tier
       FROM reviews r
       LEFT JOIN shops s ON r.shop_id = s.shop_id
       LEFT JOIN orders o ON r.order_id = o.order_id
       WHERE r.review_id = ? AND r.user_id = ?`,
      [id, req.userId]
    );
    if (reviews.length === 0) return res.status(404).json(errorResponse('评价不存在', 404));
    const r = reviews[0];
    const amount = parseFloat(r.actual_amount || r.quoted_amount) || 0;
    let orderTier = r.order_tier;
    if (!orderTier) {
      if (amount < 1000) orderTier = 1;
      else if (amount < 5000) orderTier = 2;
      else if (amount < 20000) orderTier = 3;
      else orderTier = 4;
    }
    const tierConfig = { 1: { fixed: 10, ratio: 0.01, cap: 30 }, 2: { fixed: 20, ratio: 0.02, cap: 150 }, 3: { fixed: 50, ratio: 0.03, cap: 800 }, 4: { fixed: 100, ratio: 0.04, cap: 2000 } };
    const cfg = tierConfig[orderTier] || tierConfig[1];
    const totalReward = Math.min(cfg.fixed + amount * cfg.ratio, cfg.cap);
    const followup1m = orderTier === 3 ? (totalReward * 0.5).toFixed(2) : orderTier === 4 ? (totalReward * 0.3).toFixed(2) : '0';
    const followup3m = orderTier === 4 ? (totalReward * 0.2).toFixed(2) : '0';
    res.json(successResponse({
      review_id: r.review_id,
      order_id: r.order_id,
      shop_name: r.shop_name,
      type: r.type,
      content: r.content,
      created_at: r.created_at,
      rebate_amount: r.rebate_amount,
      order_amount: amount,
      order_tier: orderTier,
      followup_reward_1m: followup1m,
      followup_reward_3m: followup3m,
      followup_reward: followup1m,
      followup_rebate: followup1m
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取评价详情失败', 500));
  }
});

// 提交追评（评价体系：stage 1m/3m，is_return_visit 返厂评价）
app.post('/api/v1/reviews/:id/followup', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { content, images, stage = '1m', is_return_visit, objective_answers } = req.body;

    const [reviews] = await pool.execute(
      'SELECT * FROM reviews WHERE review_id = ? AND user_id = ?',
      [id, req.userId]
    );
    if (reviews.length === 0) return res.status(404).json(errorResponse('评价不存在', 404));
    const firstReview = reviews[0];
    if (firstReview.type !== 1) return res.status(400).json(errorResponse('仅支持对主评价进行追评'));

    const [orders] = await pool.execute(
      'SELECT order_id, quoted_amount, actual_amount, order_tier, completed_at FROM orders WHERE order_id = ?',
      [firstReview.order_id]
    );
    if (orders.length === 0) return res.status(404).json(errorResponse('订单不存在', 404));
    const order = orders[0];
    const amount = parseFloat(order.actual_amount || order.quoted_amount) || 0;
    let orderTier = order.order_tier;
    if (!orderTier) {
      if (amount < 1000) orderTier = 1;
      else if (amount < 5000) orderTier = 2;
      else if (amount < 20000) orderTier = 3;
      else orderTier = 4;
    }

    const stageVal = (stage === '3m' ? '3m' : '1m');
    const [existingStage] = await pool.execute(
      'SELECT review_id FROM reviews WHERE order_id = ? AND type = 2 AND review_stage = ?',
      [firstReview.order_id, stageVal]
    );
    if (existingStage.length > 0) return res.status(400).json(errorResponse(`您已提交过${stageVal === '1m' ? '1个月' : '3个月'}追评`));

    const completedAt = order.completed_at ? new Date(order.completed_at) : new Date(firstReview.created_at);
    const oneMonthAgo = new Date(completedAt);
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() + 1);
    const threeMonthsAgo = new Date(completedAt);
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() + 3);
    const now = new Date();
    if (stageVal === '1m' && now < oneMonthAgo) return res.status(400).json(errorResponse('1个月追评尚未到开放时间'));
    if (stageVal === '3m') {
      if (orderTier !== 4) return res.status(400).json(errorResponse('仅四级订单支持3个月追评'));
      if (now < threeMonthsAgo) return res.status(400).json(errorResponse('3个月追评尚未到开放时间'));
    }

    const tierConfig = { 1: { fixed: 10, ratio: 0.01, cap: 30 }, 2: { fixed: 20, ratio: 0.02, cap: 150 }, 3: { fixed: 50, ratio: 0.03, cap: 800 }, 4: { fixed: 100, ratio: 0.04, cap: 2000 } };
    const cfg = tierConfig[orderTier] || tierConfig[1];
    const totalReward = Math.min(cfg.fixed + amount * cfg.ratio, cfg.cap);
    let rewardPercent = 0;
    if (orderTier <= 2) rewardPercent = 0;
    else if (orderTier === 3) rewardPercent = stageVal === '1m' ? 0.5 : 0;
    else rewardPercent = stageVal === '1m' ? 0.3 : 0.2;
    const rewardAmount = totalReward * rewardPercent;
    const taxDeducted = rewardAmount > 800 ? Math.round((rewardAmount - 800) * 0.2 * 100) / 100 : 0;
    const userReceives = rewardAmount - taxDeducted;

    const followupId = 'REV' + Date.now();
    const objAnswers = objective_answers ? JSON.stringify(objective_answers) : '{}';
    await pool.execute(
      `INSERT INTO reviews (review_id, order_id, shop_id, user_id, type, review_stage, rating, content, after_images, objective_answers, rebate_amount, reward_amount, tax_deducted, status, created_at)
       VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
      [followupId, firstReview.order_id, firstReview.shop_id, req.userId, stageVal, firstReview.rating,
       content || '', JSON.stringify(images || []), objAnswers, userReceives, userReceives, taxDeducted]
    );

    if (userReceives > 0) {
      await pool.execute(
        'UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?',
        [userReceives, userReceives, req.userId]
      );
      await pool.execute(
        `INSERT INTO transactions (transaction_id, user_id, type, amount, description, related_id, reward_tier, review_stage, tax_deducted, created_at)
         VALUES (?, ?, 'rebate', ?, ?, ?, ?, ?, ?, NOW())`,
        ['TXN' + Date.now(), req.userId, userReceives, is_return_visit ? '返厂评价奖励金' : `${stageVal === '1m' ? '1个月' : '3个月'}追评奖励金`, followupId, orderTier, stageVal, taxDeducted]
      );
    }

    try {
      await pool.execute(
        `INSERT INTO review_audit_logs (review_id, audit_type, result, created_at) VALUES (?, 'ai', 'pass', NOW())`,
        [followupId]
      );
    } catch (_) {}

    res.json(successResponse({
      review_id: followupId,
      reward: { amount: userReceives.toFixed(2), tax_deducted: taxDeducted, stage: stageVal }
    }, '追评提交成功'));
  } catch (error) {
    console.error('提交追评错误:', error);
    res.status(500).json(errorResponse('提交追评失败', 500));
  }
});

// 提交返厂评价
app.post('/api/v1/reviews/return', authenticateToken, async (req, res) => {
  try {
    const { order_id, images, content } = req.body;

    if (!order_id) return res.status(400).json(errorResponse('订单ID不能为空'));
    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json(errorResponse('请上传至少 1 张返厂照片'));
    }

    const [orders] = await pool.execute(
      'SELECT * FROM orders WHERE order_id = ? AND user_id = ?',
      [order_id, req.userId]
    );
    if (orders.length === 0) return res.status(404).json(errorResponse('订单不存在', 404));
    const order = orders[0];

    const [firstReview] = await pool.execute(
      'SELECT review_id, created_at FROM reviews WHERE order_id = ? AND type = 1',
      [order_id]
    );
    if (firstReview.length === 0) return res.status(400).json(errorResponse('请先完成首次评价'));

    const [returnExists] = await pool.execute(
      'SELECT review_id FROM reviews WHERE order_id = ? AND type = 3',
      [order_id]
    );
    if (returnExists.length > 0) return res.status(400).json(errorResponse('您已提交过返厂评价'));

    const [followupExists] = await pool.execute(
      'SELECT review_id FROM reviews WHERE order_id = ? AND type = 2',
      [order_id]
    );
    if (followupExists.length > 0) return res.status(400).json(errorResponse('您已通过追评获得返点，不可再提交返厂评价'));

    const created = new Date(firstReview[0].created_at);
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    if (created < sixMonthsAgo) return res.status(400).json(errorResponse('返厂评价已过期（需在首次评价后 6 个月内）'));

    const amount = parseFloat(order.actual_amount || order.quoted_amount) || 0;
    const rebateAmount = amount * 0.02;

    const returnId = 'REV' + Date.now();
    await pool.execute(
      `INSERT INTO reviews (review_id, order_id, shop_id, user_id, type, rating,
       content, after_images, rebate_amount, rebate_rate, status, created_at)
       VALUES (?, ?, ?, ?, 3, 5, ?, ?, ?, 0.02, 1, NOW())`,
      [returnId, order_id, order.shop_id, req.userId, content || '', JSON.stringify(images), rebateAmount]
    );

    if (rebateAmount > 0) {
      await pool.execute(
        'UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?',
        [rebateAmount, rebateAmount, req.userId]
      );
      await pool.execute(
        `INSERT INTO transactions (transaction_id, user_id, type, amount, description, related_id, created_at)
         VALUES (?, ?, 'rebate', ?, '返厂评价返点', ?, NOW())`,
        ['TXN' + Date.now(), req.userId, rebateAmount, returnId]
      );
    }

    res.json(successResponse({
      review_id: returnId,
      rebate: { amount: rebateAmount, rate: '2%' }
    }, '返厂评价提交成功'));
  } catch (error) {
    console.error('提交返厂评价错误:', error);
    res.status(500).json(errorResponse('提交返厂评价失败', 500));
  }
});

// AI对比分析
app.post('/api/v1/reviews/analyze', authenticateToken, async (req, res) => {
  try {
    const { before_images, after_images } = req.body;

    if (!before_images || !after_images) {
      return res.status(400).json(errorResponse('请上传维修前后照片'));
    }

    // TODO: 调用阿里云AI进行对比分析
    // 模拟分析结果
    const analysisResult = {
      quality_score: 92,
      repair_areas: ['前保险杠', '左大灯'],
      issues: [],
      details: {
        repair_rate: 98,
        paint_quality: 95,
        assembly_accuracy: 90
      }
    };

    res.json(successResponse({ analysis: analysisResult }));
  } catch (error) {
    res.status(500).json(errorResponse('AI分析失败', 500));
  }
});

// ===================== 6. 上传相关接口 =====================

// 上传目录：使用项目根目录下的 uploads（与 Nginx 配置 /var/www/simplewin/uploads 一致）
// 可通过 .env 的 UPLOADS_DIR 覆盖，如 UPLOADS_DIR=/var/www/simplewin/uploads
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// 图片上传（multipart，需登录）- multer 可选，未安装时返回 503
let uploadMiddleware = null;
try {
  const multer = require('multer');
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(uploadsDir, new Date().toISOString().slice(0, 10));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = (file.originalname || '').split('.').pop() || 'jpg';
      cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + '.' + ext);
    }
  });
  uploadMiddleware = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } }).single('image');
} catch (e) {
  console.warn('[upload] multer 未安装，图片上传不可用。请在 api-server 目录执行: npm install multer');
}

app.post('/api/v1/upload/image', authenticateToken, (req, res, next) => {
  if (!uploadMiddleware) {
    return res.status(503).json(errorResponse('图片上传功能暂不可用，请在服务器安装 multer 依赖', 503));
  }
  uploadMiddleware(req, res, (err) => {
    if (err) return res.status(400).json(errorResponse(err.message || '上传失败'));
    if (!req.file) return res.status(400).json(errorResponse('请选择图片'));
    const baseUrl = process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
    const relativePath = path.relative(uploadsDir, req.file.path).replace(/\\/g, '/');
    const url = (baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl) + '/uploads/' + relativePath;
    res.json(successResponse({ url }, '上传成功'));
  });
});

// 获取OSS上传签名 (用于前端直传)
app.get('/api/v1/upload/signature', authenticateToken, async (req, res) => {
  try {
    // TODO: 实现阿里云OSS签名生成
    // 这里返回模拟数据
    res.json(successResponse({
      accessid: process.env.OSS_ACCESS_KEY_ID,
      policy: 'base64_encoded_policy',
      signature: 'computed_signature',
      dir: 'uploads/' + new Date().toISOString().slice(0, 10) + '/',
      host: `https://${process.env.OSS_BUCKET}.${process.env.OSS_ENDPOINT}`,
      expire: Math.floor(Date.now() / 1000) + 300
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取上传签名失败', 500));
  }
});

// ===================== 7. 管理端接口（替代云函数） =====================

// 管理端认证：校验 admin_token（与小程序 JWT 兼容，admin 登录后颁发）
const authenticateAdmin = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json(errorResponse('未登录，请先登录管理后台'));
  }

  // 模拟 token 也放行（admin/admin123 登录时发的 mock_token_xxx）
  if (token.startsWith('mock_token_')) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.adminUserId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json(errorResponse('登录已过期，请重新登录'));
  }
};

// 管理端登录
app.post('/api/v1/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'admin123') {
      const token = jwt.sign(
        { userId: 'admin', role: 'admin' },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      return res.json(successResponse({ token, user: { username, role: 'admin' } }, '登录成功'));
    }
    return res.status(401).json(errorResponse('用户名或密码错误'));
  } catch (error) {
    res.status(500).json(errorResponse('登录失败', 500));
  }
});

// 服务商列表（原 getMerchants）
app.get('/api/v1/admin/merchants', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, auditStatus, keyword } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(pageSize);

    let where = 'WHERE 1=1';
    const params = [];

    if (auditStatus === 'pending') {
      where += ' AND (mu.status = 0 OR mu.status IS NULL)';
    } else if (auditStatus === 'approved') {
      where += ' AND mu.status = 1';
    }
    if (keyword) {
      where += ' AND (s.name LIKE ? OR mu.phone LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`);
    }

    const [list] = await pool.execute(
      `SELECT mu.merchant_id as merchantId, mu.phone, mu.status as auditStatus, s.name as merchantName, s.address,
              s.compliance_rate as complianceRate, s.complaint_rate as complaintRate, s.qualification_level as qualificationLevel
       FROM merchant_users mu
       LEFT JOIN shops s ON mu.shop_id = s.shop_id
       ${where}
       LIMIT ? OFFSET ?`,
      [...params, parseInt(pageSize), offset]
    );

    const [countRes] = await pool.execute(
      `SELECT COUNT(*) as total FROM merchant_users mu LEFT JOIN shops s ON mu.shop_id = s.shop_id ${where}`,
      params
    );

    res.json(successResponse({ list, total: countRes[0].total }));
  } catch (error) {
    console.error('获取服务商列表失败:', error);
    res.status(500).json(errorResponse('获取服务商列表失败', 500));
  }
});

// 服务商审核（原 auditMerchant）
app.post('/api/v1/admin/merchants/:id/audit', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { auditStatus, auditNote } = req.body;
    await pool.execute(
      'UPDATE merchant_users SET status = ? WHERE merchant_id = ?',
      [auditStatus === 'approved' ? 1 : 0, id]
    );
    res.json(successResponse(null, '审核成功'));
  } catch (error) {
    res.status(500).json(errorResponse('审核失败', 500));
  }
});

// 订单列表（原 getAllOrders）
app.get('/api/v1/admin/orders', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, orderNo, status, ownerId, merchantId, startDate, endDate } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(pageSize);

    let where = 'WHERE 1=1';
    const params = [];

    if (orderNo) {
      where += ' AND o.order_id = ?';
      params.push(orderNo);
    }
    if (status !== undefined && status !== '') {
      where += ' AND o.status = ?';
      params.push(status);
    }
    if (ownerId) {
      where += ' AND o.user_id = ?';
      params.push(ownerId);
    }
    if (merchantId) {
      where += ' AND o.shop_id = ?';
      params.push(merchantId);
    }
    if (startDate) {
      where += ' AND DATE(o.created_at) >= ?';
      params.push(startDate);
    }
    if (endDate) {
      where += ' AND DATE(o.created_at) <= ?';
      params.push(endDate);
    }

    const [list] = await pool.execute(
      `SELECT o.order_id as orderNo, o.status, o.quoted_amount as orderAmount, o.created_at as createTime,
              u.nickname as ownerName, s.name as merchantName,
              o.order_tier as orderTier, o.complexity_level as complexityLevel, o.reward_preview as rewardPreview,
              o.commission_rate as commissionRate, o.commission as commission
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.user_id
       LEFT JOIN shops s ON o.shop_id = s.shop_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(pageSize), offset]
    );

    const [countRes] = await pool.execute(
      `SELECT COUNT(*) as total FROM orders o ${where}`,
      params
    );

    res.json(successResponse({ list, total: countRes[0].total }));
  } catch (error) {
    console.error('获取订单列表失败:', error);
    res.status(500).json(errorResponse('获取订单列表失败', 500));
  }
});

// 订单详情（原 getOrderDetail）
app.get('/api/v1/admin/orders/:orderNo', authenticateAdmin, async (req, res) => {
  try {
    const { orderNo } = req.params;
    const [orders] = await pool.execute(
      `SELECT o.*, u.nickname as ownerName, u.phone as ownerPhone, s.name as shopName
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.user_id
       LEFT JOIN shops s ON o.shop_id = s.shop_id
       WHERE o.order_id = ?`,
      [orderNo]
    );

    // 查询奖励金/返现明细（transactions type=rebate）
    const [rebateRows] = await pool.execute(
      `SELECT t.transaction_id, t.amount, t.reward_tier as rewardTier, t.review_stage as reviewStage, t.tax_deducted as taxDeducted, t.created_at
       FROM transactions t
       WHERE t.type = 'rebate' AND t.related_id = ?
       ORDER BY t.created_at`,
      [orderNo]
    );
    if (orders.length === 0) {
      return res.status(404).json(errorResponse('订单不存在', 404));
    }
    const order = orders[0];
    const [quotes] = await pool.execute(
      `SELECT q.*, s.name as merchantName FROM quotes q
       LEFT JOIN shops s ON q.shop_id = s.shop_id
       WHERE q.bidding_id = (SELECT bidding_id FROM orders WHERE order_id = ?)`,
      [orderNo]
    );

    let vehicleInfo = {};
    if (order.bidding_id) {
      const [biddings] = await pool.execute(
        'SELECT vehicle_info FROM biddings WHERE bidding_id = ?',
        [order.bidding_id]
      );
      if (biddings.length > 0 && biddings[0].vehicle_info) {
        try {
          vehicleInfo = typeof biddings[0].vehicle_info === 'string'
            ? JSON.parse(biddings[0].vehicle_info) : biddings[0].vehicle_info;
        } catch (_) {}
      }
    }

    const orderDetail = {
      order: {
        orderNo: order.order_id,
        status: order.status,
        quotedAmount: order.quoted_amount,
        actualAmount: order.actual_amount,
        orderTier: order.order_tier,
        complexityLevel: order.complexity_level,
        rewardPreview: order.reward_preview,
        commissionRate: order.commission_rate,
        commission: order.commission,
        reviewStageStatus: order.review_stage_status,
        createdAt: order.created_at,
        createTime: order.created_at,
        vehicleInfo: {
          brand: vehicleInfo.brand,
          model: vehicleInfo.model,
          plate_number: vehicleInfo.plate_number,
          plateNumber: vehicleInfo.plate_number
        }
      },
      ownerInfo: { nickname: order.ownerName, nickName: order.ownerName, phone: order.ownerPhone },
      quotes: quotes.map(q => ({
        quote_id: q.quote_id,
        merchantName: q.merchantName,
        quoteType: 'non-oem',
        amount: q.amount,
        submitTime: q.created_at,
        nonOemQuote: { totalAmount: q.amount, partsCost: q.amount, laborCost: 0, materialCost: 0 },
      })),
      repairOrder: null,
      selectedMerchantInfo: { name: order.shopName },
      refunds: rebateRows.map(r => ({
        transaction_id: r.transaction_id,
        amount: r.amount,
        refundAmount: r.amount,
        reward_tier: r.rewardTier,
        review_stage: r.reviewStage,
        tax_deducted: r.taxDeducted,
        createTime: r.created_at,
        type: 'order',
      })),
      complaints: [],
      review: null,
      settlementProofs: [],
    };
    res.json(successResponse(orderDetail));
  } catch (error) {
    console.error('获取订单详情失败:', error);
    res.status(500).json(errorResponse('获取订单详情失败', 500));
  }
});

// 审核报价（原 auditQuote）
app.post('/api/v1/admin/orders/:orderNo/audit-quote', authenticateAdmin, async (req, res) => {
  try {
    res.json(successResponse(null, '审核成功'));
  } catch (error) {
    res.status(500).json(errorResponse('审核失败', 500));
  }
});

// 统计数据（原 getStatistics）
app.get('/api/v1/admin/statistics', authenticateAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const [userCount] = await pool.execute('SELECT COUNT(*) as c FROM users WHERE status = 1');
    const [shopCount] = await pool.execute('SELECT COUNT(*) as c FROM shops WHERE status = 1');
    const [orderCount] = await pool.execute('SELECT COUNT(*) as c FROM orders');
    const [orderAmount] = await pool.execute('SELECT COALESCE(SUM(quoted_amount), 0) as total FROM orders WHERE status = 3');
    const [completedCount] = await pool.execute('SELECT COUNT(*) as c FROM orders WHERE status = 3');
    // 今日订单（按创建时间）
    const [todayOrders] = await pool.execute(
      "SELECT COUNT(*) as c FROM orders WHERE DATE(created_at) = CURDATE()"
    );
    // 今日成交额（今日完成的订单金额，completed_at 为空时用 updated_at）
    const [todayAmount] = await pool.execute(
      "SELECT COALESCE(SUM(quoted_amount), 0) as total FROM orders WHERE status = 3 AND DATE(COALESCE(completed_at, updated_at)) = CURDATE()"
    );

    let monthlyWhere = '';
    const monthlyParams = [];
    if (startDate) {
      monthlyWhere += ' AND DATE(created_at) >= ?';
      monthlyParams.push(startDate);
    }
    if (endDate) {
      monthlyWhere += ' AND DATE(created_at) <= ?';
      monthlyParams.push(endDate);
    }

    const [monthlyRows] = await pool.execute(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as count
       FROM orders WHERE 1=1 ${monthlyWhere}
       GROUP BY DATE_FORMAT(created_at, '%Y-%m')
       ORDER BY month`,
      monthlyParams
    );

    const monthlyOrders = {};
    monthlyRows.forEach(r => { monthlyOrders[r.month] = r.count; });

    const total = orderCount[0].c;
    const completed = completedCount[0].c;
    const completionRate = total > 0 ? ((completed / total) * 100).toFixed(2) : 0;

    // 奖励金支出总额（transactions type=rebate）
    const [rewardTotalRow] = await pool.execute(
      "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'rebate' AND amount > 0"
    );
    const rewardTotal = parseFloat(rewardTotalRow[0]?.total || 0);

    // 奖励金按订单分级分布
    const [rewardByTier] = await pool.execute(
      `SELECT COALESCE(reward_tier, 0) as tier, SUM(amount) as total
       FROM transactions WHERE type = 'rebate' AND amount > 0
       GROUP BY reward_tier`
    );
    const rewardDistributionByTier = {};
    const tierNames = { 0: '未分级', 1: '一级', 2: '二级', 3: '三级', 4: '四级' };
    rewardByTier.forEach(r => {
      rewardDistributionByTier[tierNames[r.tier] || `第${r.tier}级`] = parseFloat(r.total || 0);
    });

    // 奖励金按评价阶段分布
    const [rewardByStage] = await pool.execute(
      `SELECT COALESCE(review_stage, 'main') as stage, SUM(amount) as total
       FROM transactions WHERE type = 'rebate' AND amount > 0
       GROUP BY review_stage`
    );
    const rewardDistributionByStage = {};
    const stageNames = { main: '主评价', '1m': '1个月追评', '3m': '3个月追评' };
    rewardByStage.forEach(r => {
      rewardDistributionByStage[stageNames[r.stage] || r.stage || '其他'] = parseFloat(r.total || 0);
    });

    res.json(successResponse({
      totalUsers: userCount[0].c,
      totalMerchants: shopCount[0].c,
      totalOrders: total,
      totalOrderAmount: parseFloat(orderAmount[0].total),
      todayOrders: todayOrders[0].c,
      todayAmount: parseFloat(todayAmount[0]?.total || 0),
      completionRate: parseFloat(completionRate),
      monthlyOrders,
      rewardTotal,
      rewardDistributionByTier,
      rewardDistributionByStage,
    }));
  } catch (error) {
    console.error('获取统计数据失败:', error);
    res.status(500).json(errorResponse('获取统计数据失败', 500));
  }
});

// 结算数据（原 getSettlements）
app.get('/api/v1/admin/settlements', authenticateAdmin, async (req, res) => {
  try {
    const [orders] = await pool.execute(
      `SELECT o.order_id as orderNo, s.name as merchantName, o.quoted_amount as orderAmount,
              o.commission as commission, o.completed_at as settlementTime
       FROM orders o
       LEFT JOIN shops s ON o.shop_id = s.shop_id
       WHERE o.status = 3 AND o.completed_at IS NOT NULL
       ORDER BY o.completed_at DESC LIMIT 100`
    );
    const [refunds] = await pool.execute(
      `SELECT t.transaction_id, o.order_id as orderNo, u.nickname as ownerName,
              t.amount as refundAmount, t.created_at as arrivalTime,
              t.reward_tier as rewardTier, t.review_stage as reviewStage, t.tax_deducted as taxDeducted
       FROM transactions t
       LEFT JOIN orders o ON t.related_id = o.order_id
       LEFT JOIN users u ON t.user_id = u.user_id
       WHERE t.type = 'rebate' AND t.amount > 0
       ORDER BY t.created_at DESC LIMIT 50`
    );
    res.json(successResponse({
      settlements: orders,
      refunds: refunds.map(r => ({
        ...r,
        refundType: 'order',
        reward_tier: r.rewardTier,
        review_stage: r.reviewStage,
        tax_deducted: r.taxDeducted,
      })),
      deposits: [],
    }));
  } catch (error) {
    console.error('获取结算数据失败:', error);
    res.status(500).json(errorResponse('获取结算数据失败', 500));
  }
});

// 投诉列表（原 getComplaints）- 无对应表时返回空
app.get('/api/v1/admin/complaints', authenticateAdmin, async (req, res) => {
  res.json(successResponse([]));
});

// 更新投诉（原 updateData complaints）
app.put('/api/v1/admin/complaints/:id', authenticateAdmin, async (req, res) => {
  res.json(successResponse(null, '处理成功'));
});

// 系统配置查询（原 queryData system_config）
app.get('/api/v1/admin/config', authenticateAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT `key`, `value` FROM settings');
    const configList = rows.map(r => ({ key: r.key, value: r.value }));
    res.json(successResponse(configList));
  } catch (error) {
    res.status(500).json(errorResponse('获取配置失败', 500));
  }
});

// 系统配置更新（原 updateData/addData system_config）
app.put('/api/v1/admin/config', authenticateAdmin, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json(errorResponse('key 不能为空'));
    await pool.execute(
      'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
      [key, String(value), String(value)]
    );
    res.json(successResponse(null, '保存成功'));
  } catch (error) {
    res.status(500).json(errorResponse('保存配置失败', 500));
  }
});

// 规则配置批量保存（RuleConfig 专用）
app.post('/api/v1/admin/config/batch', authenticateAdmin, async (req, res) => {
  try {
    const items = req.body.items || [];
    for (const item of items) {
      if (item.key) {
        await pool.execute(
          'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
          [item.key, String(item.value), String(item.value)]
        );
      }
    }
    res.json(successResponse(null, '保存成功'));
  } catch (error) {
    res.status(500).json(errorResponse('保存配置失败', 500));
  }
});

// ===================== A10 奖励金规则配置 =====================
app.get('/api/v1/admin/reward-rules/complexity-levels', authenticateAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, `level`, project_type as projectType, fixed_reward as fixedReward, float_ratio as floatRatio, cap_amount as capAmount FROM repair_complexity_levels ORDER BY `level`'
    );
    res.json(successResponse(rows));
  } catch (error) {
    console.error('获取复杂度等级失败:', error);
    res.status(500).json(errorResponse('获取复杂度等级失败', 500));
  }
});

app.post('/api/v1/admin/reward-rules/complexity-levels', authenticateAdmin, async (req, res) => {
  try {
    const { level, projectType, fixedReward, floatRatio, capAmount } = req.body;
    if (!level || !projectType) return res.status(400).json(errorResponse('level、projectType 必填'));
    await pool.execute(
      'INSERT INTO repair_complexity_levels (`level`, project_type, fixed_reward, float_ratio, cap_amount) VALUES (?, ?, ?, ?, ?)',
      [level, projectType, fixedReward || 0, floatRatio || 0, capAmount || 0]
    );
    res.json(successResponse(null, '添加成功'));
  } catch (error) {
    console.error('添加复杂度等级失败:', error);
    res.status(500).json(errorResponse('添加失败', 500));
  }
});

app.put('/api/v1/admin/reward-rules/complexity-levels/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { level, projectType, fixedReward, floatRatio, capAmount } = req.body;
    await pool.execute(
      'UPDATE repair_complexity_levels SET `level`=COALESCE(?,`level`), project_type=COALESCE(?,project_type), fixed_reward=COALESCE(?,fixed_reward), float_ratio=COALESCE(?,float_ratio), cap_amount=COALESCE(?,cap_amount) WHERE id=?',
      [level, projectType, fixedReward, floatRatio, capAmount, id]
    );
    res.json(successResponse(null, '更新成功'));
  } catch (error) {
    console.error('更新复杂度等级失败:', error);
    res.status(500).json(errorResponse('更新失败', 500));
  }
});

app.delete('/api/v1/admin/reward-rules/complexity-levels/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.execute('DELETE FROM repair_complexity_levels WHERE id = ?', [req.params.id]);
    res.json(successResponse(null, '删除成功'));
  } catch (error) {
    console.error('删除复杂度等级失败:', error);
    res.status(500).json(errorResponse('删除失败', 500));
  }
});

app.get('/api/v1/admin/reward-rules/rules', authenticateAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT id, rule_key as ruleKey, rule_value as ruleValue, description FROM reward_rules');
    const rules = {};
    rows.forEach(r => { rules[r.ruleKey] = { ...r, value: r.ruleValue ? (typeof r.ruleValue === 'string' ? JSON.parse(r.ruleValue || '{}') : r.ruleValue) : {} }; });
    res.json(successResponse(rows));
  } catch (error) {
    console.error('获取奖励金规则失败:', error);
    res.status(500).json(errorResponse('获取奖励金规则失败', 500));
  }
});

app.post('/api/v1/admin/reward-rules/rules', authenticateAdmin, async (req, res) => {
  try {
    const { ruleKey, ruleValue, description } = req.body;
    if (!ruleKey) return res.status(400).json(errorResponse('ruleKey 必填'));
    const val = typeof ruleValue === 'object' ? JSON.stringify(ruleValue) : String(ruleValue || '{}');
    await pool.execute(
      'INSERT INTO reward_rules (rule_key, rule_value, description) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE rule_value=VALUES(rule_value), description=VALUES(description)',
      [ruleKey, val, description || '']
    );
    res.json(successResponse(null, '保存成功'));
  } catch (error) {
    console.error('保存奖励金规则失败:', error);
    res.status(500).json(errorResponse('保存失败', 500));
  }
});

// ===================== A11 评价审核与人工复核 =====================
app.get('/api/v1/admin/review-audit/list', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, status, pool } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(pageSize);
    let where = 'WHERE 1=1';
    const params = [];
    // 必审池：L3-L4、奖励金>800
    if (pool === 'mandatory') {
      where += ` AND (
        o.complexity_level IN ('L3','L4')
        OR COALESCE(r.reward_amount, r.rebate_amount, 0) > 800
      )`;
    }
    // 抽检池：L1-L2（按 review_id 取模实现约 5% 抽检）
    if (pool === 'sample') {
      const sampleRate = 5;
      where += ` AND o.complexity_level IN ('L1','L2') AND (CRC32(r.review_id) % 100) < ?`;
      params.push(sampleRate);
    }
    const [list] = await pool.execute(
      `SELECT r.review_id as reviewId, r.order_id as orderId, r.type, r.review_stage as reviewStage, r.rating, r.content, r.created_at as createTime,
              r.reward_amount as rewardAmount, o.complexity_level as complexityLevel,
              rl.result as auditResult, rl.missing_items as missingItems, rl.audit_type as auditType
       FROM reviews r
       LEFT JOIN orders o ON r.order_id = o.order_id
       LEFT JOIN (
         SELECT r1.review_id, r1.result, r1.missing_items, r1.audit_type
         FROM review_audit_logs r1
         INNER JOIN (SELECT review_id, MAX(id) as max_id FROM review_audit_logs GROUP BY review_id) r2 ON r1.review_id = r2.review_id AND r1.id = r2.max_id
       ) rl ON r.review_id = rl.review_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(pageSize), offset]
    );
    const [countRes] = await pool.execute(
      `SELECT COUNT(*) as total FROM reviews r LEFT JOIN orders o ON r.order_id = o.order_id ${where}`,
      params
    );
    let resultList = list;
    if (status === 'rejected') {
      resultList = list.filter(r => r.auditResult === 'reject');
    }
    res.json(successResponse({ list: resultList, total: status === 'rejected' ? resultList.length : (countRes[0]?.total || 0) }));
  } catch (error) {
    console.error('获取评价审核列表失败:', error);
    res.status(500).json(errorResponse('获取评价审核列表失败', 500));
  }
});

app.post('/api/v1/admin/review-audit/:reviewId/manual', authenticateAdmin, async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { result, missingItems } = req.body;
    if (!result || !['pass', 'reject'].includes(result)) return res.status(400).json(errorResponse('result 必填且为 pass 或 reject'));
    await pool.execute(
      'INSERT INTO review_audit_logs (review_id, audit_type, result, missing_items, operator_id) VALUES (?, ?, ?, ?, ?)',
      [reviewId, 'manual', result, missingItems ? JSON.stringify(missingItems) : null, req.adminUser || 'admin']
    );
    res.json(successResponse(null, '复核完成'));
  } catch (error) {
    console.error('人工复核失败:', error);
    res.status(500).json(errorResponse('复核失败', 500));
  }
});

// ===================== A12 破格升级审核 =====================
app.get('/api/v1/admin/complexity-upgrade/list', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, status } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(pageSize);
    let where = 'WHERE 1=1';
    const params = [];
    if (status !== undefined && status !== '') {
      where += ' AND cur.status = ?';
      params.push(parseInt(status));
    }
    const [list] = await pool.execute(
      `SELECT cur.id, cur.request_id as requestId, cur.order_id as orderId, cur.user_id as userId, cur.current_level as currentLevel,
              cur.requested_level as requestedLevel, cur.reason, cur.status, cur.created_at as createTime,
              u.nickname as userName
       FROM complexity_upgrade_requests cur
       LEFT JOIN users u ON cur.user_id = u.user_id
       ${where}
       ORDER BY cur.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(pageSize), offset]
    );
    const [countRes] = await pool.execute(`SELECT COUNT(*) as total FROM complexity_upgrade_requests cur ${where}`, params);
    res.json(successResponse({ list, total: countRes[0]?.total || 0 }));
  } catch (error) {
    console.error('获取破格升级列表失败:', error);
    res.status(500).json(errorResponse('获取破格升级列表失败', 500));
  }
});

app.post('/api/v1/admin/complexity-upgrade/:requestId/audit', authenticateAdmin, async (req, res) => {
  try {
    const { requestId } = req.params;
    const { status, auditNote } = req.body;
    if (![1, 2].includes(parseInt(status))) return res.status(400).json(errorResponse('status 需为 1(通过) 或 2(拒绝)'));
    await pool.execute(
      'UPDATE complexity_upgrade_requests SET status = ?, auditor_id = ?, audited_at = NOW() WHERE request_id = ?',
      [parseInt(status), req.adminUser || 'admin', requestId]
    );
    res.json(successResponse(null, '审核完成'));
  } catch (error) {
    console.error('破格升级审核失败:', error);
    res.status(500).json(errorResponse('审核失败', 500));
  }
});

// ===================== 防刷管理（黑名单、防刷配置） =====================
app.get('/api/v1/admin/antifraud/blacklist', authenticateAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, blacklist_type as type, blacklist_value as value, reason, created_at as createTime FROM blacklist ORDER BY id DESC'
    );
    res.json(successResponse(rows));
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') return res.json(successResponse([]));
    console.error('获取黑名单失败:', error);
    res.status(500).json(errorResponse('获取黑名单失败', 500));
  }
});

app.post('/api/v1/admin/antifraud/blacklist', authenticateAdmin, async (req, res) => {
  try {
    const { type, value, reason } = req.body;
    if (!type || !value) return res.status(400).json(errorResponse('type、value 必填'));
    const validTypes = ['user_id', 'phone', 'device_id', 'ip', 'id_card'];
    if (!validTypes.includes(type)) return res.status(400).json(errorResponse('type 需为 user_id/phone/device_id/ip/id_card'));
    await pool.execute(
      'INSERT INTO blacklist (blacklist_type, blacklist_value, reason) VALUES (?, ?, ?)',
      [type, String(value).trim(), reason || null]
    );
    await antifraud.writeAuditLog(pool, {
      logType: 'blacklist',
      action: 'create',
      targetTable: 'blacklist',
      newValue: { type, value: String(value).trim(), reason },
      operatorId: req.adminUserId || 'admin',
      ip: req.ip || req.headers['x-forwarded-for'],
    });
    res.json(successResponse(null, '添加成功'));
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') return res.status(500).json(errorResponse('请先执行防刷迁移脚本 migration-20260215-phase2-antifraud.sql'));
    console.error('添加黑名单失败:', error);
    res.status(500).json(errorResponse('添加失败', 500));
  }
});

app.delete('/api/v1/admin/antifraud/blacklist/:id', authenticateAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT blacklist_type, blacklist_value FROM blacklist WHERE id = ?', [req.params.id]);
    await pool.execute('DELETE FROM blacklist WHERE id = ?', [req.params.id]);
    if (rows.length > 0) {
      await antifraud.writeAuditLog(pool, {
        logType: 'blacklist',
        action: 'delete',
        targetTable: 'blacklist',
        targetId: req.params.id,
        oldValue: rows[0],
        operatorId: req.adminUserId || 'admin',
        ip: req.ip || req.headers['x-forwarded-for'],
      });
    }
    res.json(successResponse(null, '删除成功'));
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') return res.status(500).json(errorResponse('请先执行防刷迁移脚本'));
    res.status(500).json(errorResponse('删除失败', 500));
  }
});

app.get('/api/v1/admin/antifraud/config', authenticateAdmin, async (req, res) => {
  try {
    const cfg = await antifraud.getAntifraudConfig(pool);
    res.json(successResponse(cfg));
  } catch (error) {
    res.status(500).json(errorResponse('获取配置失败', 500));
  }
});

app.put('/api/v1/admin/antifraud/config', authenticateAdmin, async (req, res) => {
  try {
    const mapping = {
      orderSameShopDays: 'antifraud_order_same_shop_days',
      orderSameShopMax: 'antifraud_order_same_shop_max',
      newUserDays: 'antifraud_new_user_days',
      newUserOrderMax: 'antifraud_new_user_order_max',
      l1MonthlyCap: 'antifraud_l1_monthly_cap',
      l1l2FreezeDays: 'antifraud_l1l2_freeze_days',
      l1l2SampleRate: 'antifraud_l1l2_sample_rate',
    };
    for (const [camel, key] of Object.entries(mapping)) {
      if (req.body[camel] !== undefined) {
        await pool.execute(
          'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
          [key, String(req.body[camel]), String(req.body[camel])]
        );
      }
    }
    await antifraud.writeAuditLog(pool, {
      logType: 'config',
      action: 'update',
      targetTable: 'settings',
      newValue: req.body,
      operatorId: req.adminUserId || 'admin',
      ip: req.ip || req.headers['x-forwarded-for'],
    });
    res.json(successResponse(null, '保存成功'));
  } catch (error) {
    res.status(500).json(errorResponse('保存失败', 500));
  }
});

// ===================== 违规处理与审计 =====================
app.get('/api/v1/admin/antifraud/violations', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, targetType, level, status } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(pageSize);
    let where = 'WHERE 1=1';
    const params = [];
    if (targetType) { where += ' AND target_type = ?'; params.push(targetType); }
    if (level) { where += ' AND violation_level = ?'; params.push(parseInt(level)); }
    if (status !== undefined && status !== '') { where += ' AND status = ?'; params.push(parseInt(status)); }
    const [list] = await pool.execute(
      `SELECT record_id as recordId, target_type as targetType, target_id as targetId, violation_level as level,
              violation_type as violationType, related_order_id as orderId, related_review_id as reviewId,
              description, penalty_applied as penaltyApplied, status, created_at as createTime
       FROM violation_records ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(pageSize), offset]
    );
    const [countRes] = await pool.execute(`SELECT COUNT(*) as total FROM violation_records ${where}`, params);
    res.json(successResponse({ list, total: countRes[0]?.total || 0 }));
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') return res.json(successResponse({ list: [], total: 0 }));
    res.status(500).json(errorResponse('获取违规列表失败', 500));
  }
});

app.post('/api/v1/admin/antifraud/violations', authenticateAdmin, async (req, res) => {
  try {
    const { targetType, targetId, level, violationType, orderId, reviewId, description, penalty } = req.body;
    if (!targetType || !targetId || !level) return res.status(400).json(errorResponse('targetType、targetId、level 必填'));
    const recordId = 'VIO' + Date.now();
    await pool.execute(
      `INSERT INTO violation_records (record_id, target_type, target_id, violation_level, violation_type,
       related_order_id, related_review_id, description, penalty_applied, status, operator_id, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW())`,
      [recordId, targetType, targetId, parseInt(level), violationType || null, orderId || null, reviewId || null,
       description || null, penalty ? JSON.stringify(penalty) : null, req.adminUserId || 'admin']
    );
    if (targetType === 'user' && [3, 4].includes(parseInt(level))) {
      await pool.execute('UPDATE users SET status = 0 WHERE user_id = ?', [targetId]);
      try {
        await pool.execute(
          'INSERT IGNORE INTO blacklist (blacklist_type, blacklist_value, reason) VALUES (?, ?, ?)',
          ['user_id', targetId, `违规${level}级处罚`]
        );
      } catch (_) {}
    }
    await antifraud.writeAuditLog(pool, {
      logType: 'violation',
      action: 'create',
      targetTable: 'violation_records',
      targetId: recordId,
      newValue: { targetType, targetId, level, description, penalty },
      operatorId: req.adminUserId || 'admin',
      ip: req.ip || req.headers['x-forwarded-for'],
    });
    res.json(successResponse({ recordId }, '处理完成'));
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') return res.status(500).json(errorResponse('请先执行 migration-20260215-phase3-antifraud.sql'));
    res.status(500).json(errorResponse('处理失败', 500));
  }
});

app.get('/api/v1/admin/antifraud/audit-logs', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, pageSize = 50, logType, startDate, endDate } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(pageSize);
    let where = 'WHERE 1=1';
    const params = [];
    if (logType) { where += ' AND log_type = ?'; params.push(logType); }
    if (startDate) { where += ' AND created_at >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND created_at <= ?'; params.push(endDate + ' 23:59:59'); }
    const [list] = await pool.execute(
      `SELECT id, log_type as logType, action, target_table as targetTable, target_id as targetId,
              operator_id as operatorId, ip, created_at as createTime
       FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(pageSize), offset]
    );
    const [countRes] = await pool.execute(`SELECT COUNT(*) as total FROM audit_logs ${where}`, params);
    res.json(successResponse({ list, total: countRes[0]?.total || 0 }));
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') return res.json(successResponse({ list: [], total: 0 }));
    res.status(500).json(errorResponse('获取审计日志失败', 500));
  }
});

// ===================== 防刷数据报表 =====================
app.get('/api/v1/admin/antifraud/statistics', authenticateAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const end = endDate || new Date().toISOString().slice(0, 10);

    const [orderCount] = await pool.execute(
      'SELECT COUNT(*) as c FROM orders WHERE created_at >= ? AND created_at <= ?',
      [start, end + ' 23:59:59']
    );
    const [reviewCount] = await pool.execute(
      'SELECT COUNT(*) as c FROM reviews WHERE created_at >= ? AND created_at <= ? AND type = 1',
      [start, end + ' 23:59:59']
    );
    const [violationCount] = await pool.execute(
      'SELECT COUNT(*) as c FROM violation_records WHERE created_at >= ? AND created_at <= ?',
      [start, end + ' 23:59:59']
    ).catch(() => [{ c: 0 }]);
    const [blacklistCount] = await pool.execute('SELECT COUNT(*) as c FROM blacklist').catch(() => [{ c: 0 }]);
    const [rewardTotal] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'rebate' AND created_at >= ? AND created_at <= ?`,
      [start, end + ' 23:59:59']
    );

    res.json(successResponse({
      orderCount: orderCount[0]?.c || 0,
      reviewCount: reviewCount[0]?.c || 0,
      violationCount: violationCount[0]?.c || 0,
      blacklistCount: blacklistCount[0]?.c || 0,
      rewardTotal: parseFloat(rewardTotal[0]?.total || 0),
      dateRange: { start, end },
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取防刷统计失败', 500));
  }
});

// ===================== 开发工具（仅非生产环境） =====================
if (process.env.NODE_ENV !== 'production') {
  // 获取测试用户 token（用于脚本模拟）
  app.post('/api/v1/dev/test-token', async (req, res) => {
    try {
      const { type, user_id, phone, password } = req.body || {};
      if (type === 'user' && user_id) {
        const [users] = await pool.execute('SELECT user_id, openid FROM users WHERE user_id = ?', [user_id]);
        if (users.length === 0) return res.status(404).json(errorResponse('用户不存在'));
        const u = users[0];
        const token = jwt.sign({ userId: u.user_id, openid: u.openid }, JWT_SECRET, { expiresIn: '7d' });
        return res.json(successResponse({ token, user_id: u.user_id }, 'ok'));
      }
      if (type === 'merchant' && phone && password) {
        const [rows] = await pool.execute(
          'SELECT merchant_id, shop_id, phone, password_hash, status FROM merchant_users WHERE phone = ?',
          [String(phone).trim()]
        );
        if (rows.length === 0) return res.status(401).json(errorResponse('手机号或密码错误'));
        const m = rows[0];
        if (!m.password_hash || !verifyPassword(String(password), m.password_hash)) {
          return res.status(401).json(errorResponse('手机号或密码错误'));
        }
        if (m.status === 0) return res.status(403).json(errorResponse('账号审核中'));
        const token = jwt.sign({ merchantId: m.merchant_id, shopId: m.shop_id }, JWT_SECRET, { expiresIn: '7d' });
        return res.json(successResponse({ token, shop_id: m.shop_id }, 'ok'));
      }
      return res.status(400).json(errorResponse('参数错误：type=user 需 user_id；type=merchant 需 phone+password'));
    } catch (err) {
      console.error('dev/test-token:', err);
      res.status(500).json(errorResponse(err.message || '失败', 500));
    }
  });

  // 一键模拟：定损 → 竞价 → 选厂 → 接单 → 维修 → 确认 → 评价 → 返佣
  app.post('/api/v1/dev/simulate-full-flow', async (req, res) => {
    try {
      const { user_id = 'USER001', merchant_phone = '18658823459', merchant_password = '123456' } = req.body || {};
      const steps = [];
      const addStep = (name, data) => { steps.push({ step: name, ...data }); };

      // 1. 获取用户 token
      const [users] = await pool.execute('SELECT user_id FROM users WHERE user_id = ?', [user_id]);
      if (users.length === 0) return res.status(404).json(errorResponse(`用户 ${user_id} 不存在，请先执行 schema seed`));
      const userToken = jwt.sign(
        { userId: user_id, openid: 'test_openid_001' },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      addStep('1-获取用户token', { user_id });

      // 2. 定损分析（使用模拟结果，不调 AI）
      const reportId = 'RPT' + Date.now();
      const mockResult = getMockAnalysisResult(reportId, { plate_number: '京A12345', brand: '测试', model: '车型' });
      await pool.execute(
        `INSERT INTO damage_reports (report_id, user_id, vehicle_info, images, analysis_result, status, created_at)
         VALUES (?, ?, ?, ?, ?, 1, NOW())`,
        [reportId, user_id, JSON.stringify({}), JSON.stringify(['https://example.com/test.jpg']), JSON.stringify(mockResult)]
      );
      addStep('2-定损报告', { report_id: reportId });

      // 3. 创建竞价
      const biddingId = 'BID' + Date.now();
      const expireAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      await pool.execute(
        `INSERT INTO biddings (bidding_id, user_id, report_id, vehicle_info, range_km, status, expire_at, created_at)
         VALUES (?, ?, ?, ?, 5, 0, ?, NOW())`,
        [biddingId, user_id, reportId, JSON.stringify({ plate_number: '京A12345' }), expireAt]
      );
      addStep('3-创建竞价', { bidding_id: biddingId });

      // 4. 生成报价（优先使用指定服务商所属店铺，否则取第一个维修厂）
      let shopId;
      const [merchants] = await pool.execute(
        'SELECT shop_id FROM merchant_users WHERE phone = ? AND status = 1',
        [merchant_phone]
      );
      if (merchants.length > 0) {
        shopId = merchants[0].shop_id;
      } else {
        const [shops] = await pool.execute('SELECT shop_id FROM shops WHERE status = 1 LIMIT 1');
        if (shops.length === 0) return res.status(400).json(errorResponse('无可用维修厂，请先执行 schema seed'));
        shopId = shops[0].shop_id;
      }
      const quoteAmount = 3500;
      const quoteId = 'QUO' + Date.now();
      await pool.execute(
        `INSERT INTO quotes (quote_id, bidding_id, shop_id, amount, items, duration, warranty, remark)
         VALUES (?, ?, ?, ?, ?, 3, 12, '模拟报价')`,
        [quoteId, biddingId, shopId, quoteAmount, JSON.stringify([{ name: '钣金喷漆', price: 2100 }, { name: '工时费', price: 1400 }])]
      );
      addStep('4-生成报价', { shop_id: shopId, amount: quoteAmount });

      // 5. 用户选厂 → 创建订单
      const orderId = 'ORD' + Date.now();
      await pool.execute(
        `INSERT INTO orders (order_id, bidding_id, user_id, shop_id, quote_id, quoted_amount, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, NOW())`,
        [orderId, biddingId, user_id, shopId, quoteId, quoteAmount]
      );
      await pool.execute('UPDATE biddings SET status = 1, selected_shop_id = ? WHERE bidding_id = ?', [shopId, biddingId]);
      addStep('5-选厂下单', { order_id: orderId });

      // 6. 服务商接单（shopId 已优先取自该服务商，故可直接接单）
      const [merchantsCheck] = await pool.execute(
        'SELECT merchant_id FROM merchant_users WHERE phone = ? AND shop_id = ? AND status = 1',
        [merchant_phone, shopId]
      );
      if (merchantsCheck.length > 0) {
        await pool.execute('UPDATE orders SET status = 1 WHERE order_id = ?', [orderId]);
        addStep('6-服务商接单', { order_id: orderId });
      } else {
        addStep('6-接单', { skip: `服务商 ${merchant_phone} 不存在或不属于店铺 ${shopId}，请先注册并关联该店铺` });
      }

      // 7. 维修完成 → 待确认
      await pool.execute('UPDATE orders SET status = 2 WHERE order_id = ?', [orderId]);
      addStep('7-维修完成', { status: '待用户确认' });

      // 8. 用户确认完成
      await pool.execute('UPDATE orders SET status = 3, completed_at = NOW() WHERE order_id = ?', [orderId]);
      addStep('8-用户确认完成', { order_id: orderId });

      // 9. 用户评价 → 返佣 8%
      const rebateAmount = quoteAmount * 0.08;
      const reviewId = 'REV' + Date.now();
      await pool.execute(
        `INSERT INTO reviews (review_id, order_id, shop_id, user_id, type, rating, content, rebate_amount, rebate_rate, status, created_at)
         VALUES (?, ?, ?, ?, 1, 5, '模拟评价', ?, 0.08, 1, NOW())`,
        [reviewId, orderId, shopId, user_id, rebateAmount]
      );
      await pool.execute(
        'UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?',
        [rebateAmount, rebateAmount, user_id]
      );
      await pool.execute(
        `INSERT INTO transactions (transaction_id, user_id, type, amount, description, related_id, created_at)
         VALUES (?, ?, 'rebate', ?, '评价返点', ?, NOW())`,
        ['TXN' + Date.now(), user_id, rebateAmount, reviewId]
      );
      addStep('9-评价返佣', { review_id: reviewId, rebate_amount: rebateAmount, rate: '8%' });

      res.json(successResponse({
        report_id: reportId,
        bidding_id: biddingId,
        order_id: orderId,
        review_id: reviewId,
        rebate_amount: rebateAmount,
        steps
      }, '全流程模拟完成'));
    } catch (err) {
      console.error('dev/simulate-full-flow:', err);
      res.status(500).json(errorResponse(err.message || '模拟失败', 500));
    }
  });
}

// ===================== 8. 定时任务接口 =====================

// 关闭过期竞价
app.post('/api/v1/cron/closeExpiredBidding', async (req, res) => {
  try {
    const [result] = await pool.execute(
      `UPDATE biddings SET status = 2, updated_at = NOW() 
       WHERE status = 0 AND expire_at < NOW()`
    );

    res.json(successResponse({ 
      closed_count: result.affectedRows 
    }, '过期竞价已关闭'));
  } catch (error) {
    res.status(500).json(errorResponse('关闭过期竞价失败', 500));
  }
});

// ===================== 错误处理 =====================

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json(errorResponse('服务器内部错误', 500));
});

// 404处理
app.use((req, res) => {
  res.status(404).json(errorResponse('接口不存在', 404));
});

// ===================== 启动服务 =====================

app.listen(PORT, '0.0.0.0', async () => {
  console.log('🚀 车厘子 API 服务器已启动');
  console.log(`📡 监听端口: ${PORT}`);
  console.log(`🔗 健康检查: http://localhost:${PORT}/health`);
  await testDBConnection();
});

module.exports = app;
