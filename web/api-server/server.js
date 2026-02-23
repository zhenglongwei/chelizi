// 车厘子 - 事故车维修平台 API 服务器
// 基于 Express + MySQL + 阿里云OSS

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const fs = require('fs');
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
const biddingService = require('./services/bidding-service');
const reviewService = require('./review-service');
const shopSortService = require('./shop-sort-service');
const appointmentService = require('./services/appointment-service');
const damageService = require('./services/damage-service');
const orderService = require('./services/order-service');
const authService = require('./services/auth-service');
const shopService = require('./services/shop-service');
const adminService = require('./services/admin-service');

// 测试数据库连接并验证 schema
async function testDBConnection() {
  try {
    const conn = await pool.getConnection();
    console.log('✅ 数据库连接成功', { host: dbConfig.host, database: dbConfig.database, user: dbConfig.user });
    // 验证 API 实际看到的 schema
    const [cols] = await conn.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'shops' AND COLUMN_NAME IN ('shop_images','qualification_ai_recognized','qualification_ai_result')", [dbConfig.database]);
    const [tables] = await conn.execute("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'blacklist'", [dbConfig.database]);
    const hasCols = cols.length >= 3;
    const hasBlacklist = tables.length > 0;
    console.log(hasCols && hasBlacklist ? '✅ schema 校验通过 (shop_images, qualification_ai_*, blacklist)' : `⚠️ schema 异常: shop_images等列=${hasCols}, blacklist表=${hasBlacklist}`);
    conn.release();
  } catch (error) {
    console.error('❌ 数据库连接失败:', error.message);
  }
}

// ===================== 中间件 =====================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 请求日志与请求 ID（用于链路追踪）
app.use((req, res, next) => {
  req.reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${req.reqId}`);
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

// 资质审核通过才可接单/报价（方案A）
const requireQualification = async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      'SELECT qualification_status FROM shops WHERE shop_id = ?',
      [req.shopId]
    );
    if (rows.length === 0 || (rows[0].qualification_status !== 1 && rows[0].qualification_status !== '1')) {
      return res.status(403).json(errorResponse('请先补充资质信息并通过审核后再接单', 403));
    }
    next();
  } catch (err) {
    res.status(500).json(errorResponse('校验失败', 500));
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
    const result = await authService.userLogin(pool, req, {
      WX_APPID,
      WX_SECRET,
      JWT_SECRET,
    });
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '登录成功'));
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json(errorResponse('登录失败: ' + error.message, 500));
  }
});

// ===================== 服务商认证 =====================

// 服务商注册
app.post('/api/v1/merchant/register', async (req, res) => {
  try {
    const result = await authService.merchantRegister(pool, req, { JWT_SECRET });
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '注册成功'));
  } catch (error) {
    console.error('服务商注册错误:', error);
    res.status(500).json(errorResponse('注册失败', 500));
  }
});

// 营业执照 OCR：调用千问大模型识别（含维修资质等级）
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

// 职业证书 OCR：识别姓名、职业名称、工种、职业等级、证书编号（需 merchant_token）
app.post('/api/v1/merchant/technician-cert/analyze', authenticateMerchant, async (req, res) => {
  try {
    const { img_url } = req.body;
    if (!img_url) return res.status(400).json(errorResponse('图片地址不能为空'));
    const apiKey = process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '';
    if (!apiKey) return res.status(500).json(errorResponse('未配置千问 API Key'));

    const { analyzeVocationalCertificateWithQwen } = require('./qwen-analyzer');
    const data = await analyzeVocationalCertificateWithQwen(img_url, apiKey);
    res.json(successResponse(data));
  } catch (error) {
    console.error('职业证书 OCR 错误:', error);
    res.status(500).json(errorResponse(error.message || '识别失败', 500));
  }
});

// 维修资质证明 OCR：当营业执照未识别到资质时，用户上传资质证明图片分析（需 merchant_token）
app.post('/api/v1/merchant/qualification-cert/analyze', authenticateMerchant, async (req, res) => {
  try {
    const { img_url } = req.body;
    if (!img_url) return res.status(400).json(errorResponse('图片地址不能为空'));
    const apiKey = process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '';
    if (!apiKey) return res.status(500).json(errorResponse('未配置千问 API Key'));

    const { analyzeQualificationCertificateWithQwen } = require('./qwen-analyzer');
    const data = await analyzeQualificationCertificateWithQwen(img_url, apiKey);
    res.json(successResponse(data));
  } catch (error) {
    console.error('资质证明 OCR 错误:', error);
    res.status(500).json(errorResponse(error.message || '识别失败', 500));
  }
});

// 服务商登录
app.post('/api/v1/merchant/login', async (req, res) => {
  try {
    const result = await authService.merchantLogin(pool, req, { JWT_SECRET });
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '登录成功'));
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
    let qualificationStatus = 0;
    let qualificationAuditReason = null;
    let qualificationSubmitted = false;
    const [shopRows] = await pool.execute(
      'SELECT qualification_status, qualification_audit_reason, qualification_level, technician_certs, qualification_withdrawn FROM shops WHERE shop_id = ?',
      [shopId]
    );
    if (shopRows[0]) {
      const s = shopRows[0].qualification_status;
      qualificationStatus = (s === 1 || s === '1') ? 1 : ((s === 2 || s === '2') ? 2 : 0);
      qualificationAuditReason = shopRows[0].qualification_audit_reason || null;
      const withdrawn = (shopRows[0].qualification_withdrawn === 1 || shopRows[0].qualification_withdrawn === '1');
      const ql = shopRows[0].qualification_level;
      const tc = shopRows[0].technician_certs;
      const hasQual = !!(ql && String(ql).trim()) || !!(tc && (typeof tc === 'string' ? (tc.trim() && tc !== '[]' && tc !== 'null') : (Array.isArray(tc) && tc.length > 0)));
      qualificationSubmitted = hasQual && !withdrawn;
    }

    const pendingBiddingCount = await biddingService.countPendingBiddingsForShop(pool, shopId, { reqId: req.reqId || '' });
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
      pending_bidding_count: pendingBiddingCount,
      pending_order_count: pendingOrder[0]?.cnt || 0,
      repairing_count: repairing[0]?.cnt || 0,
      pending_confirm_count: pendingConfirm[0]?.cnt || 0,
      qualification_status: qualificationStatus,
      qualification_audit_reason: qualificationAuditReason,
      qualification_submitted: qualificationSubmitted
    }));
  } catch (error) {
    console.error('服务商工作台错误:', error);
    res.status(500).json(errorResponse('获取工作台数据失败', 500));
  }
});

// 竞价邀请列表（使用统一 bidding-service，与工作台 count 逻辑一致）
app.get('/api/v1/merchant/biddings', authenticateMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));
    const status = (req.query.status || 'pending'); // pending | quoted | ended

    console.log(`[merchant/biddings] shopId=${shopId} status=${status} page=${page} limit=${limit} ${req.reqId || ''}`);
    const { list, total } = await biddingService.listBiddingsForShop(pool, shopId, status, page, limit, { reqId: req.reqId || '' });
    const items = (list || []).map((row) => biddingService.mapBiddingRowToItem(row));

    res.json(successResponse({ list: items, total, page, limit }));
  } catch (error) {
    console.error(`[${req.reqId || ''}] 服务商竞价列表错误:`, error);
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
       WHERE b.bidding_id = ?
         AND (
           EXISTS (SELECT 1 FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.shop_id = ?)
           OR (
             b.status = 0
             AND EXISTS (
               SELECT 1 FROM users u INNER JOIN shops s ON s.shop_id = ?
               WHERE b.user_id = u.user_id AND u.latitude IS NOT NULL AND u.longitude IS NOT NULL
                 AND (6371 * acos(cos(radians(u.latitude)) * cos(radians(s.latitude)) *
                 cos(radians(s.longitude) - radians(u.longitude)) + sin(radians(u.latitude)) * sin(radians(s.latitude)))) <= b.range_km
             )
           )
         )`,
      [id, shopId, shopId]
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
      'SELECT quote_id, amount, items, value_added_services, duration, warranty, remark, quote_status FROM quotes WHERE bidding_id = ? AND shop_id = ?',
      [id, shopId]
    );

    const complexityService = require('./services/complexity-service');
    const repairItems = complexityService.normalizeRepairItems(
      quoted.length > 0 ? (typeof quoted[0].items === 'string' ? JSON.parse(quoted[0].items || '[]') : quoted[0].items) : [],
      analysis
    );
    const { level: complexityLevel } = await complexityService.resolveComplexityFromItems(pool, repairItems);
    const est = analysis.total_estimate;
    const estMid = Array.isArray(est) && est.length >= 2 ? (parseFloat(est[0]) + parseFloat(est[1])) / 2 : 5000;
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
        value_added_services: typeof quoted[0].value_added_services === 'string' ? JSON.parse(quoted[0].value_added_services || '[]') : (quoted[0].value_added_services || []),
        duration: quoted[0].duration,
        warranty: quoted[0].warranty,
        remark: quoted[0].remark,
        quote_status: quoted[0].quote_status != null ? quoted[0].quote_status : 0
      } : null
    }));
  } catch (error) {
    console.error('服务商竞价详情错误:', error);
    res.status(500).json(errorResponse('获取竞价详情失败', 500));
  }
});

// 提交报价（需资质审核通过）
app.post('/api/v1/merchant/quote', authenticateMerchant, requireQualification, async (req, res) => {
  try {
    const { bidding_id, amount, items, value_added_services, duration, warranty, remark } = req.body;
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

    const acosArg = 'cos(radians(u.latitude)) * cos(radians(s.latitude)) * cos(radians(s.longitude) - radians(u.longitude)) + sin(radians(u.latitude)) * sin(radians(s.latitude))';
    const [inRange] = await pool.execute(
      `SELECT 1 FROM biddings b
       INNER JOIN users u ON b.user_id = u.user_id
       INNER JOIN shops s ON s.shop_id = ?
       WHERE b.bidding_id = ? AND u.latitude IS NOT NULL AND u.longitude IS NOT NULL
         AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
         AND (6371 * acos(LEAST(1, GREATEST(-1, ${acosArg})))) <= b.range_km`,
      [shopId, bidding_id]
    );
    if (inRange.length === 0) return res.status(403).json(errorResponse('该竞价未邀请您'));

    const quoteId = 'QUO' + Date.now();
    await pool.execute(
      `INSERT INTO quotes (quote_id, bidding_id, shop_id, amount, items, value_added_services, duration, warranty, remark)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [quoteId, bidding_id, shopId, amount, JSON.stringify(items || []), JSON.stringify(value_added_services || []), duration || 3, warranty || 12, remark || null]
    );

    console.log(`[merchant/quote] ${req.reqId || ''} quoteId=${quoteId} biddingId=${bidding_id} shopId=${shopId} amount=${amount}`);
    res.json(successResponse({ quote_id: quoteId }, '报价已提交'));
  } catch (error) {
    console.error(`[merchant/quote] ${req.reqId || ''} 提交报价错误:`, error);
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
        o.order_tier, o.complexity_level, o.commission_rate, o.repair_plan_status,
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
        commission_rate: cr,
        repair_plan_status: row.repair_plan_status != null ? parseInt(row.repair_plan_status, 10) : 0
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
      'SELECT amount, items, duration, warranty, remark, value_added_services FROM quotes WHERE quote_id = ?',
      [o.quote_id]
    );

    const quoteObj = quote.length > 0 ? {
      amount: quote[0].amount,
      items: typeof quote[0].items === 'string' ? JSON.parse(quote[0].items || '[]') : (quote[0].items || []),
      duration: quote[0].duration,
      warranty: quote[0].warranty,
      remark: quote[0].remark,
      value_added_services: (() => {
        try {
          const v = quote[0].value_added_services;
          if (!v) return [];
          return typeof v === 'string' ? JSON.parse(v || '[]') : (v || []);
        } catch (_) { return []; }
      })()
    } : null;

    const { durationDeadline, durationDeadlineText } = (() => {
      const dur = quoteObj && quoteObj.duration;
      const created = o.created_at;
      if (!dur || !created || dur <= 0) return { durationDeadline: null, durationDeadlineText: null };
      const d = new Date(created);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      next.setHours(0, 0, 0, 0);
      const deadline = new Date(next);
      deadline.setDate(deadline.getDate() + (dur - 1));
      return {
        durationDeadline: deadline.toISOString(),
        durationDeadlineText: `${deadline.getMonth() + 1}月${deadline.getDate()}日`
      };
    })();

    const pendingCancel = await orderService.getPendingCancelRequest(pool, id, shopId);

    let repairPlan = null;
    let repairPlanStatus = 0;
    if (o.repair_plan) {
      try {
        repairPlan = typeof o.repair_plan === 'string' ? JSON.parse(o.repair_plan) : o.repair_plan;
      } catch (_) {}
    }
    if (o.repair_plan_status != null) repairPlanStatus = parseInt(o.repair_plan_status, 10) || 0;

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
      quote: quoteObj,
      repair_plan: repairPlan,
      repair_plan_status: repairPlanStatus,
      duration_deadline: durationDeadline,
      duration_deadline_text: durationDeadlineText,
      created_at: o.created_at,
      accepted_at: o.accepted_at,
      pending_cancel_request: pendingCancel
    }));
  } catch (error) {
    console.error('服务商订单详情错误:', error);
    res.status(500).json(errorResponse('获取订单详情失败', 500));
  }
});

// 接单（需资质审核通过）
app.post('/api/v1/merchant/orders/:id/accept', authenticateMerchant, requireQualification, async (req, res) => {
  try {
    const result = await orderService.acceptOrder(pool, req.params.id, req.shopId);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '接单成功'));
  } catch (error) {
    console.error('接单错误:', error);
    res.status(500).json(errorResponse('接单失败', 500));
  }
});

// 更新订单状态（维修中→待确认，1→2 时 completion_evidence 必传）
app.put('/api/v1/merchant/orders/:id/status', authenticateMerchant, async (req, res) => {
  try {
    const { status, completion_evidence } = req.body || {};
    const result = await orderService.updateOrderStatus(pool, req.params.id, req.shopId, status, completion_evidence);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '已标记为待用户确认'));
  } catch (error) {
    console.error('更新订单状态错误:', error);
    res.status(500).json(errorResponse('更新失败', 500));
  }
});

// 服务商修改维修方案（仅 status=1 时可调用）
app.put('/api/v1/merchant/orders/:id/repair-plan', authenticateMerchant, async (req, res) => {
  try {
    const result = await orderService.updateRepairPlan(pool, req.params.id, req.shopId, req.body || {});
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '维修方案已更新，请等待车主确认'));
  } catch (error) {
    console.error('修改维修方案错误:', error);
    res.status(500).json(errorResponse('更新失败', 500));
  }
});

// 服务商响应撤单申请（同意/拒绝）
app.post('/api/v1/merchant/orders/:id/cancel-request/:requestId/respond', authenticateMerchant, async (req, res) => {
  try {
    const { requestId } = req.params;
    const approve = req.body && req.body.approve === true;
    const result = await orderService.respondCancelRequest(pool, requestId, req.shopId, approve);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    const msg = approve ? '已同意撤单' : '已拒绝，可通知车主';
    res.json(successResponse(result.data, msg));
  } catch (error) {
    console.error('响应撤单申请错误:', error);
    res.status(500).json(errorResponse('操作失败', 500));
  }
});

// 撤回资质提交（仅待审核时可撤回，审核通过/驳回后不可撤回）
app.post('/api/v1/merchant/shop/withdraw-qualification', authenticateMerchant, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT qualification_status, qualification_level, technician_certs, qualification_withdrawn FROM shops WHERE shop_id = ?',
      [req.shopId]
    );
    if (!rows || rows.length === 0) return res.status(404).json(errorResponse('店铺不存在'));
    const s = rows[0];
    const status = s.qualification_status;
    if (status === 1 || status === '1' || status === 2 || status === '2') {
      return res.status(403).json(errorResponse('审核已完毕，不可撤回，请直接修改后重新提交'));
    }
    const hasQual = !!(s.qualification_level && String(s.qualification_level).trim());
    const tc = s.technician_certs;
    const hasTech = !!(tc && (typeof tc === 'string' ? (tc.trim() && tc !== '[]') : (Array.isArray(tc) && tc.length > 0)));
    if (!hasQual && !hasTech) return res.status(400).json(errorResponse('暂无资质信息可撤回'));
    await pool.execute(
      'UPDATE shops SET qualification_withdrawn = 1, updated_at = NOW() WHERE shop_id = ?',
      [req.shopId]
    );
    res.json(successResponse(null, '已撤回，可修改后重新提交'));
  } catch (error) {
    console.error('撤回资质失败:', error);
    res.status(500).json(errorResponse(error.message || '撤回失败', 500));
  }
});

// 服务商消息列表
app.get('/api/v1/merchant/messages', authenticateMerchant, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const offset = (page - 1) * limit;

    const [list] = await pool.execute(
      `SELECT message_id, type, title, content, related_id, is_read, created_at
       FROM merchant_messages
       WHERE merchant_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [req.merchantId, limit, offset]
    );

    const [countRes] = await pool.execute(
      'SELECT COUNT(*) as total FROM merchant_messages WHERE merchant_id = ?',
      [req.merchantId]
    );

    res.json(successResponse({
      list,
      total: countRes[0].total,
      page,
      limit
    }));
  } catch (error) {
    if (String(error.message || '').includes('merchant_messages')) {
      return res.json(successResponse({ list: [], total: 0, page: 1, limit: 10 }));
    }
    console.error('获取服务商消息失败:', error);
    res.status(500).json(errorResponse('获取消息失败', 500));
  }
});

// 服务商消息标记已读
app.post('/api/v1/merchant/messages/read', authenticateMerchant, async (req, res) => {
  try {
    const { message_ids } = req.body;
    if (!message_ids || !Array.isArray(message_ids) || message_ids.length === 0) {
      return res.status(400).json(errorResponse('请提供 message_ids 数组'));
    }
    const placeholders = message_ids.map(() => '?').join(',');
    await pool.execute(
      `UPDATE merchant_messages SET is_read = 1 WHERE merchant_id = ? AND message_id IN (${placeholders})`,
      [req.merchantId, ...message_ids]
    );
    res.json(successResponse(null, '已标记已读'));
  } catch (error) {
    if (String(error.message || '').includes('merchant_messages')) return res.json(successResponse(null, '已标记已读'));
    console.error('标记已读失败:', error);
    res.status(500).json(errorResponse('标记已读失败', 500));
  }
});

// 服务商未读消息数
app.get('/api/v1/merchant/messages/unread-count', authenticateMerchant, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT COUNT(*) as count FROM merchant_messages WHERE merchant_id = ? AND is_read = 0',
      [req.merchantId]
    );
    res.json(successResponse({ count: rows[0].count, unread_count: rows[0].count }));
  } catch (error) {
    if (String(error.message || '').includes('merchant_messages')) return res.json(successResponse({ count: 0, unread_count: 0 }));
    console.error('获取未读数失败:', error);
    res.status(500).json(errorResponse('获取未读数失败', 500));
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
    const shopImages = s.shop_images ? (typeof s.shop_images === 'string' ? JSON.parse(s.shop_images || '[]') : s.shop_images) : [];
    res.json(successResponse({
      shop_id: s.shop_id,
      name: s.name,
      logo: s.logo,
      shop_images: Array.isArray(shopImages) ? shopImages : [],
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
      qualification_ai_recognized: s.qualification_ai_recognized || null,
      qualification_ai_result: s.qualification_ai_result || null,
      technician_certs: typeof s.technician_certs === 'string' ? (s.technician_certs ? JSON.parse(s.technician_certs) : null) : s.technician_certs,
      qualification_status: s.qualification_status != null ? s.qualification_status : 0,
      qualification_audit_reason: s.qualification_audit_reason || null,
      qualification_withdrawn: (s.qualification_withdrawn === 1 || s.qualification_withdrawn === '1') ? 1 : 0
    }));
  } catch (error) {
    console.error('获取店铺信息错误:', error);
    res.status(500).json(errorResponse('获取店铺信息失败', 500));
  }
});

app.put('/api/v1/merchant/shop', authenticateMerchant, async (req, res) => {
  try {
    const { name, address, latitude, longitude, phone, business_hours, categories, qualification_level, qualification_ai_recognized, qualification_ai_result, technician_certs, shop_images, certifications } = req.body;
    const [preCheck] = await pool.execute(
      'SELECT qualification_status, qualification_level, technician_certs, qualification_withdrawn FROM shops WHERE shop_id = ?',
      [req.shopId]
    );
    if (preCheck && preCheck.length > 0) {
      const s = preCheck[0];
      const status = s.qualification_status;
      const withdrawn = (s.qualification_withdrawn === 1 || s.qualification_withdrawn === '1');
      const hasQual = !!(s.qualification_level && String(s.qualification_level).trim());
      const tc = s.technician_certs;
      const hasTech = !!(tc && (typeof tc === 'string' ? (tc.trim() && tc !== '[]') : (Array.isArray(tc) && tc.length > 0)));
      if ((status === 0 || status === '0') && (hasQual || hasTech) && !withdrawn) {
        return res.status(403).json(errorResponse('资质审核中，不可修改。如需修改请先撤回'));
      }
    }
    const [shops] = await pool.execute(
      'SELECT name, address, latitude, longitude, phone, business_hours, categories, qualification_level, qualification_ai_recognized, qualification_ai_result, technician_certs, shop_images, certifications, qualification_status, qualification_audit_reason FROM shops WHERE shop_id = ?',
      [req.shopId]
    );
    if (!shops || shops.length === 0) return res.status(404).json(errorResponse('店铺不存在'));

    const s = shops[0];
    const newQualLevel = qualification_level !== undefined ? (qualification_level || null) : s.qualification_level;
    const newQualAiRecognized = qualification_ai_recognized !== undefined ? (qualification_ai_recognized || null) : (s.qualification_ai_recognized ?? null);
    const newQualAiResult = qualification_ai_result !== undefined ? (qualification_ai_result || null) : (s.qualification_ai_result ?? null);
    const newTechCerts = technician_certs !== undefined ? (technician_certs ? JSON.stringify(technician_certs) : null) : s.technician_certs;
    const newShopImages = shop_images !== undefined ? (shop_images && Array.isArray(shop_images) && shop_images.length ? JSON.stringify(shop_images) : null) : s.shop_images;
    const newCerts = certifications !== undefined ? (certifications && Array.isArray(certifications) && certifications.length ? JSON.stringify(certifications) : s.certifications) : s.certifications;
    const qualChanged = (newQualLevel !== (s.qualification_level || null)) || (newTechCerts !== (s.technician_certs || null)) || (newCerts !== (s.certifications || null));
    const currentRejected = (s.qualification_status === 2 || s.qualification_status === '2');
    const hasQualData = !!(newQualLevel && String(newQualLevel).trim()) || !!(newTechCerts && String(newTechCerts).trim() && newTechCerts !== '[]');
    // 驳回后重新保存：按首次提交逻辑处理，重置为待审核
    const isResubmitAfterReject = currentRejected && hasQualData;

    let newQualStatus = s.qualification_status != null ? s.qualification_status : 0;
    let auditReason = (s.qualification_audit_reason ?? null);

    if (qualChanged || isResubmitAfterReject) {
      newQualStatus = 0;
      auditReason = null;
      const techCerts = Array.isArray(technician_certs) ? technician_certs : [];
      for (const t of techCerts) {
        if (t.certificate_url && t.ai_recognized_level && (t.level || '') !== (t.ai_recognized_level || '')) {
          auditReason = '用户修改了技师职业等级，需人工复核';
          break;
        }
      }
      if (!auditReason && newQualLevel) {
        const qualAi = (qualChanged || isResubmitAfterReject) ? newQualAiRecognized : s.qualification_ai_recognized;
        const qualAiRes = (qualChanged || isResubmitAfterReject) ? newQualAiResult : s.qualification_ai_result;
        if (!qualAi || (newQualLevel || '') !== (qualAi || '')) {
          auditReason = qualAiRes === 'recognition_failed' ? 'AI识别失败，用户手动选择，需人工复核' : (qualAiRes === 'no_qualification_found' ? 'AI未识别到资质，用户手动选择，需人工复核' : '用户修改了资质等级，需人工复核');
        }
      }
    }

    const updates = {
      name: name != null ? String(name).trim() : s.name,
      address: address != null ? String(address).trim() : s.address,
      latitude: latitude != null && !isNaN(Number(latitude)) ? Number(latitude) : s.latitude,
      longitude: longitude != null && !isNaN(Number(longitude)) ? Number(longitude) : s.longitude,
      phone: phone != null ? String(phone).trim() : s.phone,
      business_hours: business_hours != null ? String(business_hours) : s.business_hours,
      categories: categories != null ? JSON.stringify(categories) : s.categories,
      qualification_level: newQualLevel,
      qualification_ai_recognized: newQualAiRecognized,
      qualification_ai_result: newQualAiResult,
      technician_certs: newTechCerts,
      shop_images: newShopImages,
      certifications: newCerts
    };

    await pool.execute(
      `UPDATE shops SET name = ?, address = ?, latitude = ?, longitude = ?, phone = ?, business_hours = ?, categories = ?, qualification_level = ?, qualification_ai_recognized = ?, qualification_ai_result = ?, technician_certs = ?, shop_images = ?, certifications = ?, qualification_status = ?, qualification_audit_reason = ?, qualification_withdrawn = 0, updated_at = NOW()
       WHERE shop_id = ?`,
      [updates.name, updates.address, updates.latitude, updates.longitude, updates.phone, updates.business_hours, updates.categories, updates.qualification_level, updates.qualification_ai_recognized, updates.qualification_ai_result, updates.technician_certs, updates.shop_images, updates.certifications, newQualStatus, auditReason, req.shopId]
    );
    res.json(successResponse(null, (qualChanged || isResubmitAfterReject) ? '保存成功，资质信息已提交审核' : '保存成功'));
  } catch (error) {
    console.error('更新店铺信息错误:', error.message, error.sql || '', error.code || '');
    res.status(500).json(errorResponse('保存失败：' + (error.message || '未知错误'), 500));
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
    const { nickname, avatar_url, phone, latitude, longitude, province, city, district } = req.body;
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
    if (latitude != null && !isNaN(Number(latitude))) {
      updates.push('latitude = ?');
      params.push(Number(latitude));
    }
    if (longitude != null && !isNaN(Number(longitude))) {
      updates.push('longitude = ?');
      params.push(Number(longitude));
    }
    if (province !== undefined && province !== null) {
      updates.push('province = ?');
      params.push(String(province).trim());
    }
    if (city !== undefined && city !== null) {
      updates.push('city = ?');
      params.push(String(city).trim());
    }
    if (district !== undefined && district !== null) {
      updates.push('district = ?');
      params.push(String(district).trim());
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
        o.repair_plan_status,
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

    const listWithStatus = (list || []).map((row) => ({
      ...row,
      repair_plan_status: row.repair_plan_status != null ? parseInt(row.repair_plan_status, 10) : 0
    }));

    res.json(successResponse({
      list: listWithStatus,
      total: countRes[0].total,
      page,
      limit
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取订单列表失败', 500));
  }
});

// 用户订单详情（含车辆信息、损伤情况、报价、维修方案，不含服务商专属字段如佣金）
app.get('/api/v1/user/orders/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT o.*, s.name as shop_name, s.logo as shop_logo, s.phone as shop_phone, s.address,
        b.vehicle_info, b.report_id, dr.analysis_result,
        q.duration as quote_duration
       FROM orders o
       LEFT JOIN shops s ON o.shop_id = s.shop_id
       LEFT JOIN biddings b ON o.bidding_id = b.bidding_id
       LEFT JOIN damage_reports dr ON b.report_id = dr.report_id
       LEFT JOIN quotes q ON o.quote_id = q.quote_id
       WHERE o.order_id = ? AND o.user_id = ?`,
      [id, req.userId]
    );
    if (rows.length === 0) return res.status(404).json(errorResponse('订单不存在', 404));
    const order = rows[0];

    let vehicleInfo = {};
    let analysisResult = {};
    try {
      vehicleInfo = typeof order.vehicle_info === 'string' ? JSON.parse(order.vehicle_info || '{}') : (order.vehicle_info || {});
      analysisResult = typeof order.analysis_result === 'string' ? JSON.parse(order.analysis_result || '{}') : (order.analysis_result || {});
    } catch (_) {}

    let quote = null;
    if (order.quote_id) {
      const [qRows] = await pool.execute(
        'SELECT amount, items, duration, warranty, value_added_services FROM quotes WHERE quote_id = ?',
        [order.quote_id]
      );
      if (qRows.length > 0) {
        const q = qRows[0];
        quote = {
          amount: q.amount,
          items: typeof q.items === 'string' ? (q.items ? JSON.parse(q.items) : []) : (q.items || []),
          duration: q.duration,
          warranty: q.warranty,
          value_added_services: typeof q.value_added_services === 'string' ? (q.value_added_services ? JSON.parse(q.value_added_services) : []) : (q.value_added_services || [])
        };
      }
    }

    let repairPlan = null;
    if (order.repair_plan) {
      try {
        repairPlan = typeof order.repair_plan === 'string' ? JSON.parse(order.repair_plan) : order.repair_plan;
      } catch (_) {}
    }

    order.vehicle_info = vehicleInfo;
    order.analysis_result = analysisResult;
    order.quote = quote;
    order.repair_plan = repairPlan;
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
    if (order.status !== 3 && order.status !== 4) {
      const needRequest = order.status >= 1 && order.accepted_at;
      let within30 = false;
      if (needRequest && order.accepted_at) {
        const at = new Date(order.accepted_at);
        within30 = Date.now() - at.getTime() <= 30 * 60 * 1000;
      }
      order.can_cancel = true;
      order.cancel_needs_reason = needRequest && !within30;
      const cancelReq = await orderService.getLatestCancelRequestForUser(pool, id, req.userId);
      if (cancelReq && cancelReq.status === 2) {
        order.cancel_rejected = true;
        order.cancel_request_id = cancelReq.request_id;
      }
    }
    const dur = order.quote_duration;
    const created = order.created_at;
    if (dur && created && dur > 0) {
      const d = new Date(created);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      next.setHours(0, 0, 0, 0);
      const deadline = new Date(next);
      deadline.setDate(deadline.getDate() + (dur - 1));
      order.duration_deadline = deadline.toISOString();
      order.duration_deadline_text = `${deadline.getMonth() + 1}月${deadline.getDate()}日`;
      order.quote_duration = dur;
    }
    res.json(successResponse(order));
  } catch (error) {
    res.status(500).json(errorResponse('获取订单详情失败', 500));
  }
});

// 奖励金预估（按《全指标底层逻辑梳理》第四章核算）
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
    let quotePlan = null;
    let repairPlan = null;

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
        order.quote_id
          ? 'SELECT items, value_added_services, amount, duration, warranty FROM quotes WHERE quote_id = ?'
          : 'SELECT items, value_added_services, amount, duration, warranty FROM quotes WHERE bidding_id = ? AND shop_id = ?',
        order.quote_id ? [order.quote_id] : [order.bidding_id, order.shop_id]
      );
      if (quotes.length > 0) {
        const q = quotes[0];
        if (q.items) {
          try {
            repairItems = typeof q.items === 'string' ? JSON.parse(q.items) : q.items;
          } catch (_) {}
        }
        quotePlan = {
          items: typeof q.items === 'string' ? (q.items ? JSON.parse(q.items) : []) : (q.items || []),
          value_added_services: typeof q.value_added_services === 'string' ? (q.value_added_services ? JSON.parse(q.value_added_services) : []) : (q.value_added_services || []),
          amount: q.amount,
          duration: q.duration,
          warranty: q.warranty
        };
      }
    }

    if (order.repair_plan) {
      try {
        repairPlan = typeof order.repair_plan === 'string' ? JSON.parse(order.repair_plan) : order.repair_plan;
      } catch (_) {}
    }

    // 奖励金按《全指标底层逻辑梳理》第四章核算，此处仅作展示用占位
    const amount = parseFloat(order.actual_amount || order.quoted_amount) || 0;
    const rebateAmount = order.reward_preview != null ? parseFloat(order.reward_preview) : (amount * 0.08);

    let completionEvidence = null;
    if (order.completion_evidence) {
      try {
        completionEvidence = typeof order.completion_evidence === 'string' ? JSON.parse(order.completion_evidence) : order.completion_evidence;
      } catch (_) {}
    }
    const merchantSettlement = completionEvidence?.settlement_photos || [];
    const merchantCompletion = completionEvidence?.repair_photos || [];
    const merchantMaterials = completionEvidence?.material_photos || [];

    res.json(successResponse({
      order_id: order.order_id,
      shop_name: order.shop_name,
      shop_logo: order.shop_logo,
      quoted_amount: order.quoted_amount,
      before_images: beforeImages,
      repair_items: repairItems,
      rebate_rate: '8%',
      rebate_amount: rebateAmount.toFixed(2),
      merchant_settlement_list: merchantSettlement,
      merchant_completion_images: merchantCompletion,
      merchant_material_images: merchantMaterials,
      quote_plan: quotePlan,
      repair_plan: repairPlan
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取评价信息失败', 500));
  }
});

// 取消订单（直接撤销或创建撤单申请，按《订单撤单与维修完成流程.md》）
app.post('/api/v1/user/orders/:id/cancel', authenticateToken, async (req, res) => {
  try {
    const reason = (req.body && req.body.reason) || '';
    const result = await orderService.cancelOrder(pool, req.params.id, req.userId, reason);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    const msg = result.data.direct ? '已撤销，可重新选择其他报价' : '撤单申请已提交，请等待服务商处理';
    res.json(successResponse(result.data, msg));
  } catch (error) {
    res.status(500).json(errorResponse('取消订单失败', 500));
  }
});

// 车主提交人工通道（撤单申请被服务商拒绝后）
app.post('/api/v1/user/orders/:id/cancel-request/:requestId/escalate', authenticateToken, async (req, res) => {
  try {
    const { id, requestId } = req.params;
    const [orders] = await pool.execute('SELECT order_id FROM orders WHERE order_id = ? AND user_id = ?', [id, req.userId]);
    if (orders.length === 0) return res.status(404).json(errorResponse('订单不存在'));
    const result = await orderService.escalateCancelRequest(pool, requestId, req.userId);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '已提交人工通道，请等待处理'));
  } catch (error) {
    res.status(500).json(errorResponse('提交失败', 500));
  }
});

// 确认完成（维修厂完成后，用户确认维修完成，状态 2->3）
app.post('/api/v1/user/orders/:id/confirm', authenticateToken, async (req, res) => {
  try {
    const result = await orderService.confirmOrder(pool, req.params.id, req.userId);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '已确认完成'));
  } catch (error) {
    res.status(500).json(errorResponse('确认完成失败', 500));
  }
});

// 车主确认维修方案（同意/不同意）
app.post('/api/v1/user/orders/:id/repair-plan/approve', authenticateToken, async (req, res) => {
  try {
    const approved = req.body && req.body.approved === true;
    const result = await orderService.approveRepairPlan(pool, req.params.id, req.userId, approved);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    const msg = approved ? '已同意维修方案' : (result.msg || '已记录，如有疑问请联系客服');
    res.json(successResponse(result.data, msg));
  } catch (error) {
    res.status(500).json(errorResponse('操作失败', 500));
  }
});

// ===================== 2. 定损相关接口 =====================

// 获取定损每日剩余次数
app.get('/api/v1/damage/daily-quota', authenticateToken, async (req, res) => {
  try {
    const quota = await damageService.getDamageDailyQuota(pool, req.userId);
    res.json(successResponse(quota));
  } catch (error) {
    console.error('获取定损配额失败:', error);
    res.status(500).json(errorResponse('获取配额失败', 500));
  }
});

// AI定损分析
app.post('/api/v1/damage/analyze', authenticateToken, async (req, res) => {
  try {
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    const result = await damageService.analyzeDamage(pool, req, baseUrl);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '分析完成'));
  } catch (error) {
    console.error('AI定损分析错误:', error);
    res.status(500).json(errorResponse('分析失败', 500));
  }
});

// 获取定损报告列表
app.get('/api/v1/damage/reports', authenticateToken, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));
    const result = await damageService.listReports(pool, req.userId, page, limit);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取定损报告列表失败:', error);
    res.status(500).json(errorResponse('获取报告列表失败', 500));
  }
});

// 获取定损报告
app.get('/api/v1/damage/report/:id', authenticateToken, async (req, res) => {
  try {
    const result = await damageService.getReport(pool, req.params.id, req.userId);
    if (!result.success) {
      return res.status(result.statusCode || 404).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data));
  } catch (error) {
    res.status(500).json(errorResponse('获取报告失败', 500));
  }
});

// ===================== 3. 竞价相关接口 =====================

// 创建竞价
app.post('/api/v1/bidding/create', authenticateToken, async (req, res) => {
  const reqId = req.reqId || '';
  try {
    const result = await biddingService.createBidding(pool, req.userId, req.body);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    const msg = result.message || (result.data?.duplicate ? '该定损单已发起竞价，正在跳转' : '竞价创建成功');
    console.log(`[bidding/create] ${reqId} biddingId=${result.data.bidding_id} userId=${req.userId} duplicate=${!!result.data?.duplicate}`);
    res.json(successResponse(result.data, msg));
  } catch (error) {
    console.error(`[bidding/create] ${reqId} 创建竞价错误:`, error);
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

// 计算两点距离（km，Haversine）
function haversineKm(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// 获取报价列表（距离在应用层计算，避免 MariaDB 对复杂 SQL 的解析问题）
// 经纬度优先用请求参数，若无则从 users 表回退（创建竞价时已写入用户选定地址）
app.get('/api/v1/bidding/:id/quotes', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { sort_type = 'default' } = req.query;

    let lat = parseFloat(req.query.latitude);
    let lng = parseFloat(req.query.longitude);
    let hasLocation = !isNaN(lat) && !isNaN(lng);
    // (0,0) 多为前端无缓存时的占位，视为无效，回退到数据库
    if (hasLocation && lat === 0 && lng === 0) hasLocation = false;

    if (!hasLocation) {
      const [biddingUser] = await pool.execute(
        'SELECT u.latitude, u.longitude FROM biddings b JOIN users u ON b.user_id = u.user_id WHERE b.bidding_id = ? AND u.latitude IS NOT NULL AND u.longitude IS NOT NULL',
        [id]
      );
      if (biddingUser.length > 0) {
        lat = parseFloat(biddingUser[0].latitude);
        lng = parseFloat(biddingUser[0].longitude);
        hasLocation = !isNaN(lat) && !isNaN(lng);
      }
    }

    const [quotes] = await pool.execute(
      `SELECT q.*, s.name as shop_name, s.logo, s.rating, s.shop_score, s.deviation_rate, s.total_orders, s.latitude as shop_lat, s.longitude as shop_lng
       FROM quotes q
       JOIN shops s ON q.shop_id = s.shop_id
       WHERE q.bidding_id = ?`,
      [id]
    );

    // 应用层计算距离
    const quotesWithDistance = quotes.map((q) => {
      const dist = hasLocation ? haversineKm(lat, lng, parseFloat(q.shop_lat), parseFloat(q.shop_lng)) : null;
      return { ...q, distance: dist };
    });

    let list = quotesWithDistance;
    if (sort_type === 'default') {
      const [biddingRows] = await pool.execute(
        'SELECT b.vehicle_info, dr.analysis_result FROM biddings b LEFT JOIN damage_reports dr ON b.report_id = dr.report_id WHERE b.bidding_id = ?',
        [id]
      );
      let benchmarkAmount = 0;
      if (biddingRows.length > 0 && biddingRows[0].analysis_result) {
        try {
          const ar = typeof biddingRows[0].analysis_result === 'string' ? JSON.parse(biddingRows[0].analysis_result) : biddingRows[0].analysis_result;
          const est = ar?.total_estimate;
          if (Array.isArray(est) && est.length >= 2) {
            benchmarkAmount = (parseFloat(est[0]) + parseFloat(est[1])) / 2;
          } else if (est != null) benchmarkAmount = parseFloat(est) || 0;
        } catch (_) {}
      }
      await shopSortService.ensureShopScores(pool, quotesWithDistance);
      list = biddingService.sortQuotesByScore(quotesWithDistance, benchmarkAmount);
    } else if (sort_type === 'price_asc') {
      list = [...quotesWithDistance].sort((a, b) => (parseFloat(a.amount) || 0) - (parseFloat(b.amount) || 0));
    } else if (sort_type === 'rating') {
      list = [...quotesWithDistance].sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0));
    } else if (sort_type === 'distance' && hasLocation) {
      list = [...quotesWithDistance].sort((a, b) => (parseFloat(a.distance) || 999) - (parseFloat(b.distance) || 999));
    } else if (sort_type === 'warranty') {
      list = [...quotesWithDistance].sort((a, b) => (parseInt(b.warranty) || 0) - (parseInt(a.warranty) || 0));
    } else {
      list = [...quotesWithDistance].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }

    res.json(successResponse({
      list: list.map(q => ({
        quote_id: q.quote_id,
        shop_id: q.shop_id,
        shop_name: q.shop_name,
        logo: q.logo,
        rating: q.rating,
        deviation_rate: q.deviation_rate,
        total_orders: q.total_orders,
        amount: q.amount,
        items: JSON.parse(q.items || '[]'),
        value_added_services: typeof q.value_added_services === 'string' ? JSON.parse(q.value_added_services || '[]') : (q.value_added_services || []),
        duration: q.duration,
        warranty: q.warranty,
        remark: q.remark,
        distance: q.distance != null ? Math.round(q.distance * 10) / 10 : null,
        created_at: q.created_at
      })),
      total: list.length
    }));
  } catch (error) {
    console.error('获取报价列表错误:', error);
    res.status(500).json(errorResponse('获取报价列表失败', 500));
  }
});

// 选择维修厂
app.post('/api/v1/bidding/:id/select', authenticateToken, async (req, res) => {
  const reqId = req.reqId || '';
  try {
    const result = await biddingService.selectQuote(pool, req);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    console.log(`[bidding/select] ${reqId} biddingId=${req.params.id} shopId=${req.body.shop_id} orderId=${result.data.order_id} userId=${req.userId}`);
    res.json(successResponse(result.data, '选择成功，订单已生成'));
  } catch (error) {
    console.error(`[bidding/select] ${reqId} 选择维修厂失败:`, error);
    res.status(500).json(errorResponse('选择维修厂失败', 500));
  }
});

// 结束竞价
app.post('/api/v1/bidding/:id/end', authenticateToken, async (req, res) => {
  const reqId = req.reqId || '';
  try {
    const result = await biddingService.endBidding(pool, req.params.id, req.userId);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    console.log(`[bidding/end] ${reqId} biddingId=${req.params.id} userId=${req.userId} quotesInvalidated=${result.data.quotesInvalidated}`);
    res.json(successResponse(null, '竞价已结束'));
  } catch (error) {
    console.error(`[bidding/end] ${reqId} 结束竞价失败:`, error);
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
          `INSERT INTO quotes (quote_id, bidding_id, shop_id, amount, items, value_added_services, duration, warranty, remark)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            quoteId,
            bidding_id,
            shopId,
            amount,
            JSON.stringify([{ name: '钣金喷漆', price: amount * 0.6 }, { name: '工时费', price: amount * 0.4 }]),
            JSON.stringify([]),
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
    const result = await shopService.getNearby(pool, req.query);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取维修厂错误:', error);
    res.status(500).json(errorResponse('获取维修厂列表失败: ' + (error.message || String(error)), 500));
  }
});

// 搜索维修厂（keyword、category、sort、分页）
app.get('/api/v1/shops/search', async (req, res) => {
  try {
    const result = await shopService.search(pool, req.query);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('搜索维修厂错误:', error);
    res.status(500).json(errorResponse('搜索维修厂失败: ' + (error.message || String(error)), 500));
  }
});

// 获取维修厂详情（仅展示资质审核通过的维修厂）
app.get('/api/v1/shops/:id', async (req, res) => {
  try {
    const result = await shopService.getDetail(pool, req.params.id);
    if (!result.success) {
      return res.status(result.statusCode || 404).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data));
  } catch (error) {
    res.status(500).json(errorResponse('获取维修厂详情失败', 500));
  }
});

// 获取维修厂评价（排序：内容完整度优先、发布时间最新，与好评率脱钩）
app.get('/api/v1/shops/:id/reviews', async (req, res) => {
  try {
    const result = await shopService.getReviews(pool, req.params.id, req.query);
    res.json(successResponse(result.data));
  } catch (error) {
    res.status(500).json(errorResponse('获取评价失败', 500));
  }
});

// 提交预约
app.post('/api/v1/appointments', authenticateToken, async (req, res) => {
  try {
    const result = await appointmentService.createAppointment(pool, req.userId, req.body);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '预约提交成功'));
  } catch (error) {
    console.error('提交预约错误:', error);
    res.status(500).json(errorResponse('预约提交失败: ' + (error.message || String(error)), 500));
  }
});

// ===================== 5. 评价相关接口 =====================

// 提交评价（评价体系：3 模块 1 次提交，支持新格式与旧格式兼容）
app.post('/api/v1/reviews', authenticateToken, async (req, res) => {
  try {
    const result = await reviewService.submitReview(pool, req, { port: PORT });
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '评价提交成功'));
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
    const tierConfig = { 1: { fixed: 10, ratio: 0.01, cap: 50 }, 2: { fixed: 20, ratio: 0.02, cap: 200 }, 3: { fixed: 50, ratio: 0.03, cap: 800 }, 4: { fixed: 100, ratio: 0.04, cap: 2000 } };
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

// 服务商端图片上传（需 merchant_token）
app.post('/api/v1/merchant/upload/image', authenticateMerchant, (req, res, next) => {
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
    const result = await adminService.login(pool, req, { JWT_SECRET });
    if (!result.success) {
      return res.status(result.statusCode || 401).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, result.message));
  } catch (error) {
    res.status(500).json(errorResponse('登录失败', 500));
  }
});

// 服务商列表（原 getMerchants）
app.get('/api/v1/admin/merchants', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getMerchants(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取服务商列表失败:', error);
    res.status(500).json(errorResponse('获取服务商列表失败', 500));
  }
});

// 资质审核（方案A：注册免审，资质需审核通过方可接单展示）
app.post('/api/v1/admin/merchants/:id/qualification-audit', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.qualificationAudit(pool, req);
    if (!result.success) {
      return res.status(result.statusCode || 404).json(errorResponse(result.error));
    }
    res.json(successResponse(null, result.message));
  } catch (error) {
    console.error('资质审核失败:', error);
    res.status(500).json(errorResponse('审核失败', 500));
  }
});

// 服务商审核（保留兼容，现注册免审，此接口主要用于历史数据）
app.post('/api/v1/admin/merchants/:id/audit', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.merchantAudit(pool, req);
    res.json(successResponse(null, result.message));
  } catch (error) {
    res.status(500).json(errorResponse('审核失败', 500));
  }
});

// 订单列表（原 getAllOrders）
app.get('/api/v1/admin/orders', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getOrders(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取订单列表失败:', error);
    res.status(500).json(errorResponse('获取订单列表失败', 500));
  }
});

// 订单详情（原 getOrderDetail）
app.get('/api/v1/admin/orders/:orderNo', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getOrderDetail(pool, req);
    if (!result.success) {
      return res.status(result.statusCode || 404).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取订单详情失败:', error);
    res.status(500).json(errorResponse('获取订单详情失败', 500));
  }
});

// 审核报价（原 auditQuote）
app.post('/api/v1/admin/orders/:orderNo/audit-quote', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.auditQuote(pool, req);
    res.json(successResponse(null, result.message));
  } catch (error) {
    res.status(500).json(errorResponse('审核失败', 500));
  }
});

// 撤单申请列表（status=3 已提交人工）
app.get('/api/v1/admin/order-cancel-requests', authenticateAdmin, async (req, res) => {
  try {
    const list = await orderService.listCancelRequestsForAdmin(pool, 3);
    res.json(successResponse({ list }));
  } catch (error) {
    console.error('获取撤单申请列表失败:', error);
    res.status(500).json(errorResponse('获取失败', 500));
  }
});

// 人工处理撤单申请（同意/拒绝）
app.post('/api/v1/admin/order-cancel-requests/:id/resolve', authenticateAdmin, async (req, res) => {
  try {
    const approve = req.body && req.body.approve === true;
    const result = await orderService.resolveCancelRequestByAdmin(pool, req.params.id, approve);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, approve ? '已同意撤单' : '已拒绝'));
  } catch (error) {
    console.error('人工处理撤单失败:', error);
    res.status(500).json(errorResponse('处理失败', 500));
  }
});

// 统计数据（原 getStatistics）
app.get('/api/v1/admin/statistics', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getStatistics(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取统计数据失败:', error);
    res.status(500).json(errorResponse('获取统计数据失败', 500));
  }
});

// 结算数据（原 getSettlements）
app.get('/api/v1/admin/settlements', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getSettlements(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取结算数据失败:', error);
    res.status(500).json(errorResponse('获取结算数据失败', 500));
  }
});

// 投诉列表（原 getComplaints）- 无对应表时返回空
app.get('/api/v1/admin/complaints', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getComplaints(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    res.status(500).json(errorResponse('获取投诉列表失败', 500));
  }
});

// 更新投诉（原 updateData complaints）
app.put('/api/v1/admin/complaints/:id', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.putComplaint(pool, req);
    res.json(successResponse(null, result.message));
  } catch (error) {
    res.status(500).json(errorResponse('处理失败', 500));
  }
});

// 系统配置查询（原 queryData system_config）
app.get('/api/v1/admin/config', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getConfig(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    res.status(500).json(errorResponse('获取配置失败', 500));
  }
});

// 系统配置更新（原 updateData/addData system_config）
app.put('/api/v1/admin/config', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.putConfig(pool, req);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(null, result.message));
  } catch (error) {
    res.status(500).json(errorResponse('保存配置失败', 500));
  }
});

// 规则配置批量保存（RuleConfig 专用）
app.post('/api/v1/admin/config/batch', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.batchConfig(pool, req);
    res.json(successResponse(null, result.message));
  } catch (error) {
    res.status(500).json(errorResponse('保存配置失败', 500));
  }
});

// ===================== A10 奖励金规则配置 =====================
app.get('/api/v1/admin/reward-rules/complexity-levels', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getComplexityLevels(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取复杂度等级失败:', error);
    res.status(500).json(errorResponse('获取复杂度等级失败', 500));
  }
});

app.post('/api/v1/admin/reward-rules/complexity-levels', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.postComplexityLevel(pool, req);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(null, result.message));
  } catch (error) {
    console.error('添加复杂度等级失败:', error);
    res.status(500).json(errorResponse('添加失败', 500));
  }
});

app.put('/api/v1/admin/reward-rules/complexity-levels/:id', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.putComplexityLevel(pool, req);
    res.json(successResponse(null, result.message));
  } catch (error) {
    console.error('更新复杂度等级失败:', error);
    res.status(500).json(errorResponse('更新失败', 500));
  }
});

app.delete('/api/v1/admin/reward-rules/complexity-levels/:id', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.deleteComplexityLevel(pool, req);
    res.json(successResponse(null, result.message));
  } catch (error) {
    console.error('删除复杂度等级失败:', error);
    res.status(500).json(errorResponse('删除失败', 500));
  }
});

app.get('/api/v1/admin/reward-rules/rules', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getRewardRules(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取奖励金规则失败:', error);
    res.status(500).json(errorResponse('获取奖励金规则失败', 500));
  }
});

app.post('/api/v1/admin/reward-rules/rules', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.postRewardRule(pool, req);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(null, result.message));
  } catch (error) {
    console.error('保存奖励金规则失败:', error);
    res.status(500).json(errorResponse('保存失败', 500));
  }
});

// ===================== A11 评价审核与人工复核 =====================
app.get('/api/v1/admin/review-audit/list', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getReviewAuditList(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取评价审核列表失败:', error);
    res.status(500).json(errorResponse('获取评价审核列表失败', 500));
  }
});

app.post('/api/v1/admin/review-audit/:reviewId/manual', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.postReviewAuditManual(pool, req);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(null, result.message));
  } catch (error) {
    console.error('人工复核失败:', error);
    res.status(500).json(errorResponse('复核失败', 500));
  }
});

// ===================== A12 破格升级审核 =====================
app.get('/api/v1/admin/complexity-upgrade/list', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getComplexityUpgradeList(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取破格升级列表失败:', error);
    res.status(500).json(errorResponse('获取破格升级列表失败', 500));
  }
});

app.post('/api/v1/admin/complexity-upgrade/:requestId/audit', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.postComplexityUpgradeAudit(pool, req);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(null, result.message));
  } catch (error) {
    console.error('破格升级审核失败:', error);
    res.status(500).json(errorResponse('审核失败', 500));
  }
});

// ===================== 防刷管理（黑名单、防刷配置） =====================
app.get('/api/v1/admin/antifraud/blacklist', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getBlacklist(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取黑名单失败:', error);
    res.status(500).json(errorResponse('获取黑名单失败', 500));
  }
});

app.post('/api/v1/admin/antifraud/blacklist', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.postBlacklist(pool, req);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(null, result.message));
  } catch (error) {
    console.error('添加黑名单失败:', error);
    res.status(500).json(errorResponse('添加失败', 500));
  }
});

app.delete('/api/v1/admin/antifraud/blacklist/:id', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.deleteBlacklist(pool, req);
    if (!result.success) {
      return res.status(result.statusCode || 500).json(errorResponse(result.error));
    }
    res.json(successResponse(null, result.message));
  } catch (error) {
    res.status(500).json(errorResponse('删除失败', 500));
  }
});

app.get('/api/v1/admin/antifraud/config', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getAntifraudConfig(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    res.status(500).json(errorResponse('获取配置失败', 500));
  }
});

app.put('/api/v1/admin/antifraud/config', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.putAntifraudConfig(pool, req);
    res.json(successResponse(null, result.message));
  } catch (error) {
    res.status(500).json(errorResponse('保存失败', 500));
  }
});

// ===================== 违规处理与审计 =====================
app.get('/api/v1/admin/antifraud/violations', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getViolations(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取违规列表失败:', error);
    res.status(500).json(errorResponse('获取违规列表失败', 500));
  }
});

app.post('/api/v1/admin/antifraud/violations', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.postViolation(pool, req);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, result.message));
  } catch (error) {
    console.error('违规处理失败:', error);
    res.status(500).json(errorResponse('处理失败', 500));
  }
});

app.get('/api/v1/admin/antifraud/audit-logs', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getAuditLogs(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取审计日志失败:', error);
    res.status(500).json(errorResponse('获取审计日志失败', 500));
  }
});

// ===================== 防刷数据报表 =====================
app.get('/api/v1/admin/antifraud/statistics', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getAntifraudStatistics(pool, req);
    res.json(successResponse(result.data));
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
        if (!m.password_hash || !authService.verifyPassword(String(password), m.password_hash)) {
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
      const mockResult = damageService.getMockAnalysisResult(reportId, { plate_number: '京A12345', brand: '测试', model: '车型' });
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
        `INSERT INTO quotes (quote_id, bidding_id, shop_id, amount, items, value_added_services, duration, warranty, remark)
         VALUES (?, ?, ?, ?, ?, ?, 3, 12, '模拟报价')`,
        [quoteId, biddingId, shopId, quoteAmount, JSON.stringify([{ name: '钣金喷漆', price: 2100 }, { name: '工时费', price: 1400 }]), JSON.stringify([])]
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
