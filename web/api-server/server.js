// 辙见 - 事故车维修平台 API 服务器
// 基于 Express + MySQL + 阿里云OSS

const path = require('path');
const fs = require('fs');

// 环境变量：先加载 web 根目录 .env，再加载 api-server/.env（后者覆盖前者）
// 避免生产仅部署 /var/www/.../api-server/.env 时读不到 JWT_SECRET 导致进程反复退出
const envWebRoot = path.join(__dirname, '..', '.env');
const envApiServer = path.join(__dirname, '.env');
require('dotenv').config({ path: envWebRoot });
if (fs.existsSync(envApiServer)) {
  require('dotenv').config({ path: envApiServer, override: true });
}

// 生产环境强制校验 JWT_SECRET，避免使用默认值导致伪造风险
const isProd = process.env.NODE_ENV === 'production';
if (isProd && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'your-secret-key')) {
  console.error(
    '❌ 生产环境必须配置 JWT_SECRET。已尝试加载：',
    fs.existsSync(envWebRoot) ? envWebRoot : '(无文件)',
    '与',
    fs.existsSync(envApiServer) ? envApiServer : '(无文件)',
    '；也可在 pm2 ecosystem 的 env 中注入 JWT_SECRET。'
  );
  process.exit(1);
}

/**
 * 追评提交：是否跳过「完工/首评基准满 1 个月 / 3 个月」时间窗校验。
 * - 生产环境：永远校验。
 * - 非生产：默认跳过（便于测试）；设置 SKIP_FOLLOWUP_TIME_CHECK=0|false|no 则开启校验。
 */
function shouldSkipFollowupTimeCheck() {
  if (isProd) return false;
  const v = String(process.env.SKIP_FOLLOWUP_TIME_CHECK || '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no') return false;
  return true;
}

const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const { sanitizeAnalysisResultForRead } = require('./utils/analysis-result-sanitize');
const { enrichAnalysisResultHumanDisplay } = require('./utils/human-display');

const app = express();

// ===================== 配置 =====================
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// 微信小程序配置
const WX_APPID = process.env.WX_APPID;
const WX_SECRET = process.env.WX_SECRET;

// 阿里云 AI Key（千问等，见 qwen-analyzer 使用 ALIYUN_AI_KEY / DASHSCOPE_API_KEY）
const ALIYUN_AI_KEY = process.env.ALIYUN_AI_KEY;

// ===================== 数据库连接池 =====================
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'zhejian',
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
const biddingDistribution = require('./services/bidding-distribution');
const reviewService = require('./review-service');
const shopSortService = require('./shop-sort-service');
const shopScoreService = require('./shop-score');
const appointmentService = require('./services/appointment-service');
const damageService = require('./services/damage-service');
const capabilityService = require('./services/capability-service');
const { CAPABILITIES } = require('./constants/capabilities');
const orchestratorService = require('./services/orchestrator-service');
const orderService = require('./services/order-service');
const orderLifecycleService = require('./services/order-lifecycle-service');
const authService = require('./services/auth-service');
const shopService = require('./services/shop-service');
const adminService = require('./services/admin-service');
const reviewLikeService = require('./services/review-like-service');
const materialAuditService = require('./services/material-audit-service');
const merchantEvidenceService = require('./services/merchant-evidence-service');
const shopProductService = require('./services/shop-product-service');
const productOrderService = require('./services/product-order-service');
const userBookingService = require('./services/user-booking-service');
const reviewFeedService = require('./services/review-feed-service');
const commissionWalletService = require('./services/commission-wallet-service');
const rewardTransferService = require('./services/reward-transfer-service');
const shopIncomeService = require('./services/shop-income-service');
const repairOrderPaymentService = require('./services/repair-order-payment-service');
const historicalFairPriceService = require('./services/historical-fair-price-service');
const orderQuoteProposalService = require('./services/order-quote-proposal-service');
const merchantIncomeWithdrawService = require('./services/merchant-income-withdraw-service');
const orderWarrantyCardService = require('./services/order-warranty-card-service');
const repairMilestoneService = require('./services/repair-milestone-service');
const { hasColumn: dbHasColumn } = require('./utils/db-utils');
const merchantCorpIncomeWithdrawService = require('./services/merchant-corp-income-withdraw-service');
const quoteImportService = require('./services/quote-import-service');
const quoteTemplateXlsx = require('./services/quote-template-xlsx');
const shopTechnicianUtils = require('./utils/shop-technician-utils');
const { buildQuoteTimelineForReview } = require('./utils/review-quote-timeline');
const { buildEvidenceSections, buildObjectiveHints } = require('./utils/review-for-review-evidence');
const { isInsuranceOrder, reviewScene } = require('./utils/review-objective-schema');
const quoteNomenclature = require('./utils/quote-nomenclature');
const quoteProposalPublic = require('./utils/quote-proposal-public-list');
const reviewSystemCheckService = require('./services/review-system-check-service');
const { sanitizeSystemChecksForUserFacing } = require('./utils/review-public-system-sanitize');
const qwenAnalyzer = require('./qwen-analyzer');
const openapiAuth = require('./services/openapi-auth-service');
const wechatJssdkService = require('./services/wechat-jssdk-service');
let moduleRegistry;
try {
  moduleRegistry = require('./modules/module-registry');
} catch (err) {
  // 线上发布若漏传 modules 目录时，避免主服务直接崩溃；模块能力会被跳过并打印告警。
  console.error('[module-registry] load failed, skip capability modules:', err && err.message ? err.message : err);
  moduleRegistry = {
    registerAllModules() {
      console.warn('[module-registry] capability modules disabled (modules directory missing)');
    },
  };
}
const multer = require('multer');
const quoteImportXlsxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
}).single('file');
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
// CORS：生产环境限制为可信域名，开发环境全开放
const corsOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : [];
const corsOptions = isProd && corsOrigins.length > 0
  ? { origin: (o, cb) => (corsOrigins.includes(o) ? cb(null, true) : cb(null, false)), credentials: true }
  : {};
app.use(cors(corsOptions));

// 信任代理：API 若在 nginx 等反向代理后，需信任 X-Forwarded-For，否则 express-rate-limit 会报 ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
app.set('trust proxy', 1);

// 微信支付佣金回调：须使用 raw body 验签（需在 express.json 之前注册）
app.post('/api/v1/pay/wechat/commission-notify', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const raw = req.body.toString('utf8');
    await commissionWalletService.handleWechatPayNotify(pool, raw, req.headers);
    res.status(200).json({ code: 'SUCCESS', message: '成功' });
  } catch (e) {
    console.error('[commission-notify]', e.message);
    res.status(500).json({ code: 'FAIL', message: '失败' });
  }
});

app.post('/api/v1/pay/wechat/product-order-notify', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const raw = req.body.toString('utf8');
    await productOrderService.handleProductOrderNotify(pool, raw, req.headers);
    res.status(200).json({ code: 'SUCCESS', message: '成功' });
  } catch (e) {
    console.error('[product-order-notify]', e.message);
    res.status(500).json({ code: 'FAIL', message: '失败' });
  }
});

app.post('/api/v1/pay/wechat/repair-order-notify', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const raw = req.body.toString('utf8');
    await repairOrderPaymentService.handleRepairOrderNotify(pool, raw, req.headers);
    res.status(200).json({ code: 'SUCCESS', message: '成功' });
  } catch (e) {
    console.error('[repair-order-notify]', e.message);
    res.status(500).json({ code: 'FAIL', message: '失败' });
  }
});

// 奖励金提现：商家转账到零钱（用户确认模式）结果通知，须 raw body 验签
app.post('/api/v1/pay/wechat/reward-transfer-notify', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const raw = req.body.toString('utf8');
    await rewardTransferService.handleRewardTransferNotify(pool, raw, req.headers);
    res.status(200).json({ code: 'SUCCESS' });
  } catch (e) {
    console.error('[reward-transfer-notify]', e.message);
    res.status(500).json({ code: 'FAIL', message: e.message || '失败' });
  }
});

app.post('/api/v1/pay/wechat/merchant-income-transfer-notify', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const raw = req.body.toString('utf8');
    await merchantIncomeWithdrawService.handleMerchantIncomeTransferNotify(pool, raw, req.headers);
    res.status(200).json({ code: 'SUCCESS' });
  } catch (e) {
    console.error('[merchant-income-transfer-notify]', e.message);
    res.status(500).json({ code: 'FAIL', message: e.message || '失败' });
  }
});

// 请求体大小：2mb 足够业务使用（图片上传走 OSS 直传），降低 DoS 风险
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ===================== 网关规范：reqId / 幂等 / 基础限流 =====================

function makeReqId() {
  try {
    return 'req_' + crypto.randomBytes(8).toString('hex');
  } catch (_) {
    return 'req_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
  }
}

// 为所有请求生成/透传 reqId（便于链路追踪与审计）
app.use((req, res, next) => {
  const fromHeader = req.headers['x-request-id'];
  const reqId = (fromHeader && String(fromHeader).trim()) || makeReqId();
  req.reqId = reqId;
  res.setHeader('X-Request-Id', reqId);
  next();
});

// 幂等：仅当客户端提供 Idempotency-Key 时启用（避免影响旧客户端）
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const _idemStore = new Map(); // key -> { expiresAt, statusCode, body }

function idemKeyFor(req) {
  const k = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
  const key = k ? String(k).trim() : '';
  if (!key) return '';
  // 以 path+method 做隔离，避免同 key 误命中不同接口
  return `${req.method}:${req.path}:${key}`;
}

function cleanupIdemStore() {
  const now = Date.now();
  for (const [k, v] of _idemStore.entries()) {
    if (!v || v.expiresAt <= now) _idemStore.delete(k);
  }
}

app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const ik = idemKeyFor(req);
  if (!ik) return next();
  cleanupIdemStore();
  const hit = _idemStore.get(ik);
  if (hit && hit.expiresAt > Date.now()) {
    return res.status(hit.statusCode || 200).json(hit.body);
  }

  // 记录本次响应
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    try {
      _idemStore.set(ik, {
        expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
        statusCode: res.statusCode,
        body,
      });
    } catch (_) {}
    return originalJson(body);
  };
  next();
});

// 基础限流（分发优先：先保护公共接口与高成本AI接口；默认较宽松）
function simpleTokenBucket({ windowMs, max }) {
  const buckets = new Map(); // key -> { resetAt, used }
  return (key) => {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { resetAt: now + windowMs, used: 0 };
      buckets.set(key, b);
    }
    b.used += 1;
    return { allowed: b.used <= max, remaining: Math.max(0, max - b.used), resetAt: b.resetAt };
  };
}

const _publicBucket = simpleTokenBucket({ windowMs: 60 * 1000, max: 120 });
app.use((req, res, next) => {
  // 仅对 public 接口做轻量保护（第三方/搜索落地页的入口）
  if (!String(req.path || '').startsWith('/api/v1/public/')) return next();
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || 'unknown';
  const r = _publicBucket(ip);
  if (!r.allowed) {
    res.setHeader('Retry-After', Math.ceil((r.resetAt - Date.now()) / 1000));
    return res.status(429).json(errorResponse('请求过于频繁，请稍后再试', 429));
  }
  res.setHeader('X-RateLimit-Remaining', String(r.remaining));
  next();
});

// 安全头（Helmet）
try {
  const helmet = require('helmet');
  app.use(helmet({ contentSecurityPolicy: false }));
} catch (_) {
  console.warn('helmet 未安装，跳过安全头。可选: npm install helmet');
}

// 速率限制：敏感接口防暴力破解
let rateLimit;
try {
  rateLimit = require('express-rate-limit');
} catch (_) {
  rateLimit = null;
}
const authLimiter = rateLimit ? rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  validate: { xForwardedForHeader: false },
  handler: (req, res) => res.status(429).json({ code: 429, message: '请求过于频繁，请稍后再试' })
}) : (req, res, next) => next();
if (rateLimit) {
  app.use('/api/v1/auth/login', authLimiter);
  app.use('/api/v1/merchant/login', authLimiter);
  app.use('/api/v1/merchant/register', authLimiter);
  app.use('/api/v1/merchant/wechat-login', authLimiter);
  app.use('/api/v1/merchant/check-openid', authLimiter);
  app.use('/api/v1/merchant/reset-password', authLimiter);
}

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

// 可选认证：有 token 则解析并设置 userId，无 token 不报错（用于评价列表等需区分是否本人）
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (_) {
    next();
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

// 资质审核通过即可接单/报价；技师持证为选填（完工时仍可选手动负责人）
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

// ===================== 模块装配（Capability Modules） =====================
// 仅负责注册路由；不改变业务语义。逐步把 server.js 中的业务路由迁到 modules/。
moduleRegistry.registerAllModules(app, {
  pool,
  authenticateToken,
  authenticateOpenApiKey,
  requireCapability,
  capabilityService,
  CAPABILITIES,
  damageService,
  qwenAnalyzer,
  repairMilestoneService,
  wechatJssdkService,
  WX_APPID,
  WX_SECRET,
  successResponse,
  errorResponse,
});

/**
 * 能力门禁（Phase1：settings 全局开关）
 * - 不通过：403
 * - 缺省：开（不影响现有功能）
 */
function requireCapability(capabilityKey, options = {}) {
  const msg = options && options.message ? String(options.message) : '当前功能未开放';
  return async (req, res, next) => {
    try {
      const ok = await capabilityService.ensureCapability(pool, capabilityKey);
      if (!ok) {
        return res.status(403).json(errorResponse(msg, 403));
      }
      return next();
    } catch (err) {
      console.warn('[capability] check failed:', capabilityKey, err && err.message);
      return next();
    }
  };
}

// OpenAPI：第三方 API Key 鉴权（用于 AI 搜索/Agent/合作方接入）
async function authenticateOpenApiKey(req, res, next) {
  try {
    const key = req.headers['x-api-key'] || req.headers['authorization'];
    const raw = String(key || '').replace(/^Bearer\s+/i, '').trim();
    const info = await openapiAuth.resolveApiKey(pool, raw);
    if (!info) {
      return res.status(401).json(errorResponse('缺少或无效的 OpenAPI Key', 401));
    }
    // daily_limit（最小可用）：按 api_key_id + 当天审计记录数计数
    if (info.source === 'db' && info.daily_limit && info.daily_limit > 0) {
      const hasAudit = await openapiAuth.tableExists(pool, 'api_call_audit');
      if (hasAudit) {
        const [cntRows] = await pool.execute(
          `SELECT COUNT(*) AS c FROM api_call_audit
           WHERE api_key_id = ? AND created_at >= CURDATE()`,
          [info.api_key_id]
        );
        const used = parseInt(cntRows[0]?.c, 10) || 0;
        if (used >= info.daily_limit) {
          return res.status(429).json(errorResponse('今日调用次数已达上限', 429));
        }
      }
    }
    req.openApi = info;
    next();
  } catch (e) {
    console.error('[openapi] auth error:', e && e.message);
    return res.status(500).json(errorResponse('OpenAPI鉴权失败', 500));
  }
}

// OpenAPI：审计写入（仅当 req.openApi 存在且表已迁移）
app.use(async (req, res, next) => {
  if (!req.openApi) return next();
  let hasAudit = false;
  try {
    hasAudit = await openapiAuth.tableExists(pool, 'api_call_audit');
  } catch (_) {
    hasAudit = false;
  }
  if (!hasAudit) return next();

  const start = Date.now();
  const reqId = req.reqId || null;
  res.on('finish', async () => {
    try {
      const durationMs = Date.now() - start;
      const auditId = crypto.randomBytes(18).toString('hex');
      const pathOnly = String(req.originalUrl || req.url || '').split('?')[0];
      await pool.execute(
        `INSERT INTO api_call_audit (audit_id, req_id, api_key_id, user_id, merchant_id, path, method, status_code, duration_ms, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          auditId,
          reqId,
          req.openApi.api_key_id || null,
          req.userId || null,
          req.merchantId || null,
          pathOnly,
          String(req.method || 'GET'),
          parseInt(res.statusCode, 10) || 200,
          parseInt(durationMs, 10) || 0,
          null,
        ]
      );
    } catch (e) {
      console.warn('[openapi] audit insert failed:', e && e.message);
    }
  });
  return next();
});

/**
 * 能力门禁（Phase1：settings 全局开关）
 * - 不通过：403
 * - 缺省：开（不影响现有功能）
 */
function requireCapability(capabilityKey, options = {}) {
  const msg = options && options.message ? String(options.message) : '当前功能未开放';
  return async (req, res, next) => {
    try {
      const ok = await capabilityService.ensureCapability(pool, capabilityKey);
      if (!ok) {
        return res.status(403).json(errorResponse(msg, 403));
      }
      return next();
    } catch (err) {
      console.warn('[capability] check failed:', capabilityKey, err && err.message);
      return next();
    }
  };
}

// 生产环境不向前端返回 error.message，避免泄露内部实现/SQL/路径等
function safeErrorMessage(err, fallback) {
  if (isProd) return fallback;
  const msg = err && (typeof err.message === 'string' ? err.message : String(err));
  return (msg && msg.trim()) ? msg : fallback;
}

/** mysql2 execute 对部分环境 LIMIT/OFFSET 占位符不兼容，分页改为安全整数字面量 */
function clampPagination(pageRaw, limitRaw, defaultLimit = 20, maxLimit = 100) {
  let p = parseInt(pageRaw, 10);
  let l = parseInt(limitRaw, 10);
  if (!Number.isFinite(p) || p < 1) p = 1;
  if (!Number.isFinite(l) || l < 1) l = defaultLimit;
  l = Math.min(maxLimit, Math.max(1, l));
  const off = (p - 1) * l;
  return { page: p, limit: l, offset: off, lim: l, off };
}

// ===================== 路由 =====================

// 健康检查（/health 本地直连，/api/health 经 Nginx 代理）
// 本地排查：GET /health?diag=1 返回当前连接的数据库名、关键表是否存在（仅非 production）
const healthHandler = async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    if (req.query.diag === '1' && !isProd) {
      const [dbRow] = await connection.query('SELECT DATABASE() AS db');
      const [tblMu] = await connection.query("SHOW TABLES LIKE 'merchant_users'");
      const [tblOrders] = await connection.query("SHOW TABLES LIKE 'orders'");
      return res.json(
        successResponse({
          status: 'ok',
          database: 'connected',
          current_database: dbRow[0]?.db ?? null,
          merchant_users_exists: tblMu.length > 0,
          orders_exists: tblOrders.length > 0,
          timestamp: new Date().toISOString(),
        })
      );
    }
    res.json(
      successResponse(
        {
          status: 'ok',
          database: 'connected',
          timestamp: new Date().toISOString(),
        },
        'API服务运行正常'
      )
    );
  } catch (error) {
    res.status(500).json(errorResponse('数据库连接失败', 500));
  } finally {
    if (connection) connection.release();
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
    res.status(500).json(errorResponse(safeErrorMessage(error, '登录失败'), 500));
  }
});

// 手机号：微信 getPhoneNumber 授权（需已登录）
app.post('/api/v1/auth/phone', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body || {};
    const result = await authService.getPhoneFromCodeAndUpdate(pool, req.userId, code, {
      WX_APPID,
      WX_SECRET,
    });
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '手机号已更新'));
  } catch (error) {
    console.error('[auth/phone]', error);
    res.status(500).json(errorResponse(safeErrorMessage(error, '获取手机号失败'), 500));
  }
});

// 手机号：短信验证（预留，短信包未开通）
app.post('/api/v1/auth/phone/verify-sms', authenticateToken, async (req, res) => {
  try {
    const { phone, sms_code } = req.body || {};
    const result = await authService.verifyPhoneBySms(pool, req.userId, phone, sms_code);
    if (!result.success) {
      return res.status(result.statusCode || 501).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '验证成功'));
  } catch (error) {
    res.status(500).json(errorResponse(safeErrorMessage(error, '验证失败'), 500));
  }
});

// ===================== 服务商认证 =====================

// 服务商注册
app.post('/api/v1/merchant/register', async (req, res) => {
  try {
    const result = await authService.merchantRegister(pool, req, {
      JWT_SECRET,
      WX_APPID,
      WX_SECRET,
    });
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
    res.status(500).json(errorResponse(safeErrorMessage(error, '识别失败'), 500));
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
    res.status(500).json(errorResponse(safeErrorMessage(error, '识别失败'), 500));
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
    res.status(500).json(errorResponse(safeErrorMessage(error, '识别失败'), 500));
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

// 服务商微信快捷登录（openid 已绑定 merchant_users）
app.post('/api/v1/merchant/wechat-login', async (req, res) => {
  try {
    const result = await authService.merchantWechatLogin(pool, req, { JWT_SECRET, WX_APPID, WX_SECRET });
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '登录成功'));
  } catch (error) {
    console.error('服务商微信登录错误:', error);
    res.status(500).json(errorResponse('登录失败', 500));
  }
});

// 服务商：当前微信是否已绑定账号（仅检测，用于「我的」页展示入口）
app.post('/api/v1/merchant/check-openid', async (req, res) => {
  try {
    const result = await authService.merchantCheckOpenid(pool, req, { WX_APPID, WX_SECRET });
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, 'ok'));
  } catch (error) {
    console.error('服务商 openid 检测错误:', error);
    res.status(500).json(errorResponse('检测失败', 500));
  }
});

// 服务商找回密码（当前微信 openid 与账号一致）
app.post('/api/v1/merchant/reset-password', async (req, res) => {
  try {
    const result = await authService.merchantResetPassword(pool, req, { WX_APPID, WX_SECRET });
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '密码已重置'));
  } catch (error) {
    console.error('服务商重置密码错误:', error);
    res.status(500).json(errorResponse('重置失败', 500));
  }
});

// ===================== 服务商端接口（需 merchant_token） =====================

// 服务商绑定 openid（用于订阅消息推送，登录后进入工作台时调用）
app.post('/api/v1/merchant/bind-openid', authenticateMerchant, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json(errorResponse('请提供微信 code'));
    if (!WX_APPID || !WX_SECRET) return res.status(503).json(errorResponse('未配置微信小程序'));
    const wxRes = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: { appid: WX_APPID, secret: WX_SECRET, js_code: code, grant_type: 'authorization_code' },
    });
    const d = wxRes.data;
    if (d.errcode) return res.status(400).json(errorResponse('微信授权失败: ' + (d.errmsg || d.errcode)));
    const openid = d.openid;
    if (!openid) return res.status(400).json(errorResponse('未获取到 openid'));
    await pool.execute('UPDATE merchant_users SET openid = ?, updated_at = NOW() WHERE merchant_id = ?', [openid, req.merchantId]);
    res.json(successResponse({ bound: true }, '已绑定'));
  } catch (err) {
    console.error('bind-openid error:', err);
    res.status(500).json(errorResponse(safeErrorMessage(err, '绑定失败')));
  }
});

// ---------- 佣金钱包 / 微信支付（服务商）----------
app.get('/api/v1/merchant/commission/wallet', authenticateMerchant, async (req, res) => {
  try {
    const w = await commissionWalletService.getWallet(pool, req.shopId);
    res.json(successResponse(w));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '获取失败'), 500));
  }
});

app.put('/api/v1/merchant/commission/deduct-mode', authenticateMerchant, async (req, res) => {
  try {
    const mode = (req.body && (req.body.mode || req.body.deduct_mode)) || '';
    const r = await commissionWalletService.setDeductMode(pool, req.shopId, mode);
    if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
    res.json(successResponse(r.data));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '保存失败'), 500));
  }
});

app.get('/api/v1/merchant/commission/ledger', authenticateMerchant, async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const data = await commissionWalletService.listLedger(pool, req.shopId, { page, limit });
    res.json(successResponse(data));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '加载失败'), 500));
  }
});

app.get('/api/v1/merchant/shop-income/ledger', authenticateMerchant, async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const data = await shopIncomeService.listIncomeLedger(pool, req.shopId, { page, limit });
    res.json(successResponse(data));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '加载失败'), 500));
  }
});

app.post('/api/v1/merchant/shop-income/withdraw', authenticateMerchant, async (req, res) => {
  try {
    const { amount, real_name, id_card_no } = req.body || {};
    const result = await merchantIncomeWithdrawService.submitMerchantIncomeWithdraw(
      pool,
      req.shopId,
      req.merchantId,
      amount,
      { realName: real_name, idCardNo: id_card_no }
    );
    if (result.action === 'resume_pending') {
      let msg = '请在微信中确认收款';
      if (result.warning === 'no_package') {
        msg = result.hint || '请先取消待确认提现后再发起';
      }
      return res.json(
        successResponse(
          {
            withdraw_id: result.withdraw_id,
            transfer_mode: 'wechat',
            action: result.action,
            amount: result.amount,
            warning: result.warning,
            hint: result.hint,
            package_info: result.package_info,
            mch_id: result.mch_id,
            app_id: result.app_id,
            openid: result.openid,
            state: result.state,
          },
          msg
        )
      );
    }
    return res.json(
      successResponse(
        {
          withdraw_id: result.withdraw_id,
          transfer_mode: 'wechat',
          action: result.action,
          amount: result.amount,
          package_info: result.package_info,
          mch_id: result.mch_id,
          app_id: result.app_id,
          openid: result.openid,
          state: result.state,
        },
        '请在微信中确认收款'
      )
    );
  } catch (error) {
    if (error.code === 'VALIDATION') {
      return res.status(error.status && error.status >= 400 ? error.status : 400).json(errorResponse(error.message));
    }
    if (error.code === 'CONFLICT') {
      return res.status(409).json(errorResponse(error.message, 409));
    }
    const msg = error.message || '提现申请失败';
    const status = error.status && error.status >= 400 && error.status < 500 ? error.status : 500;
    res.status(status).json(errorResponse(msg, status));
  }
});

app.post('/api/v1/merchant/shop-income/withdraw/reconcile', authenticateMerchant, async (req, res) => {
  try {
    const { withdraw_id } = req.body || {};
    const out = await merchantIncomeWithdrawService.reconcileMerchantIncomeWithdraw(
      pool,
      req.shopId,
      req.merchantId,
      withdraw_id
    );
    res.json(successResponse(out));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '同步失败'), 500));
  }
});

app.post('/api/v1/merchant/shop-income/withdraw/cancel', authenticateMerchant, async (req, res) => {
  try {
    const { withdraw_id } = req.body || {};
    const out = await merchantIncomeWithdrawService.cancelPendingMerchantIncomeWithdraw(
      pool,
      req.shopId,
      req.merchantId,
      withdraw_id
    );
    res.json(successResponse(out));
  } catch (error) {
    if (error.code === 'VALIDATION') {
      return res.status(400).json(errorResponse(error.message));
    }
    res.status(500).json(errorResponse(safeErrorMessage(error, '撤销失败'), 500));
  }
});

app.post('/api/v1/merchant/shop-income/corp-withdraw', authenticateMerchant, async (req, res) => {
  try {
    const r = await merchantCorpIncomeWithdrawService.submitCorpWithdraw(pool, req.shopId, req.merchantId, req.body || {});
    if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
    res.json(successResponse(r.data, r.data.message || '已提交'));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '提交失败'), 500));
  }
});

app.get('/api/v1/merchant/shop-income/corp-withdrawals', authenticateMerchant, async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const data = await merchantCorpIncomeWithdrawService.listCorpWithdrawalsForMerchant(pool, req.shopId, {
      page,
      limit,
    });
    res.json(successResponse(data));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '加载失败'), 500));
  }
});

app.post('/api/v1/merchant/shop-income/corp-withdraw/cancel', authenticateMerchant, async (req, res) => {
  try {
    const { request_id } = req.body || {};
    const r = await merchantCorpIncomeWithdrawService.cancelCorpWithdrawByMerchant(
      pool,
      req.shopId,
      req.merchantId,
      request_id
    );
    if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
    res.json(successResponse(r.data, '已撤销'));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '撤销失败'), 500));
  }
});

app.post('/api/v1/merchant/commission/recharge-prepay', authenticateMerchant, async (req, res) => {
  try {
    const { amount, code } = req.body || {};
    if (!code) return res.status(400).json(errorResponse('请提供微信 code'));
    if (!WX_APPID || !WX_SECRET) return res.status(503).json(errorResponse('未配置微信小程序'));
    const wxRes = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: { appid: WX_APPID, secret: WX_SECRET, js_code: code, grant_type: 'authorization_code' },
    });
    const d = wxRes.data;
    if (d.errcode || !d.openid) return res.status(400).json(errorResponse('微信授权失败'));
    const r = await commissionWalletService.createRechargePrepay(pool, req.shopId, req.merchantId, amount, d.openid);
    if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
    res.json(successResponse(r.data));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '下单失败'), 500));
  }
});

app.post('/api/v1/merchant/commission/pay-order-prepay', authenticateMerchant, async (req, res) => {
  try {
    const { order_id, code } = req.body || {};
    if (!order_id || !code) return res.status(400).json(errorResponse('缺少 order_id 或 code'));
    if (!WX_APPID || !WX_SECRET) return res.status(503).json(errorResponse('未配置微信小程序'));
    const wxRes = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: { appid: WX_APPID, secret: WX_SECRET, js_code: code, grant_type: 'authorization_code' },
    });
    const d = wxRes.data;
    if (d.errcode || !d.openid) return res.status(400).json(errorResponse('微信授权失败'));
    const r = await commissionWalletService.createOrderCommissionPrepay(pool, req.shopId, req.merchantId, order_id, d.openid);
    if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
    res.json(successResponse(r.data));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '下单失败'), 500));
  }
});

app.post('/api/v1/merchant/orders/:id/commission-finalize', authenticateMerchant, async (req, res) => {
  try {
    const { actual_amount, payment_proof_urls } = req.body || {};
    if (actual_amount == null) return res.status(400).json(errorResponse('请填写实际维修金额'));
    const r = await commissionWalletService.finalizeCommissionProof(
      pool,
      req.shopId,
      req.params.id,
      actual_amount,
      payment_proof_urls || []
    );
    if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
    res.json(successResponse(r.data));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '提交失败'), 500));
  }
});

app.post('/api/v1/merchant/commission/refund', authenticateMerchant, async (req, res) => {
  try {
    const { amount } = req.body || {};
    const r = await commissionWalletService.requestRefund(pool, req.shopId, req.merchantId, amount);
    if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
    res.json(successResponse(r.data));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '退款失败'), 500));
  }
});

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
    const [openidRows] = await pool.execute(
      'SELECT openid FROM merchant_users WHERE merchant_id = ?',
      [req.merchantId]
    );
    const openidBound = !!(openidRows[0]?.openid && String(openidRows[0].openid).trim());
    let shop_score_detail = null;
    try {
      shop_score_detail = await shopScoreService.getMerchantWorkbenchScore(pool, shopId);
    } catch (e) {
      console.warn('[merchant/dashboard] shop_score_detail', e && e.message);
    }
    res.json(successResponse({
      pending_bidding_count: pendingBiddingCount,
      pending_order_count: pendingOrder[0]?.cnt || 0,
      repairing_count: repairing[0]?.cnt || 0,
      pending_confirm_count: pendingConfirm[0]?.cnt || 0,
      qualification_status: qualificationStatus,
      qualification_audit_reason: qualificationAuditReason,
      qualification_submitted: qualificationSubmitted,
      openid_bound: openidBound,
      shop_score_detail
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
    if (status === 'pending') {
      try {
        await biddingDistribution.sendDelayedBiddingMessagesForShop(pool, shopId);
      } catch (e) {
        console.warn(`[merchant/biddings] sendDelayedBiddingMessagesForShop error:`, e?.message);
      }
    }
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
      `SELECT b.*, dr.images, dr.analysis_result, dr.user_description
       FROM biddings b
       INNER JOIN damage_reports dr ON b.report_id = dr.report_id
       WHERE b.bidding_id = ?
         AND (
           EXISTS (SELECT 1 FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.shop_id = ?)
           OR (
             b.status = 0
             AND (
               (
                 NOT EXISTS (SELECT 1 FROM bidding_distribution bd2 WHERE bd2.bidding_id = b.bidding_id)
                 AND EXISTS (
                   SELECT 1 FROM users u INNER JOIN shops s ON s.shop_id = ?
                   WHERE b.user_id = u.user_id AND u.latitude IS NOT NULL AND u.longitude IS NOT NULL
                     AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
                     AND (6371 * acos(LEAST(1, GREATEST(-1, cos(radians(u.latitude)) * cos(radians(s.latitude)) *
                     cos(radians(s.longitude) - radians(u.longitude)) + sin(radians(u.latitude)) * sin(radians(s.latitude)))))) <= b.range_km
                 )
               )
               OR EXISTS (
                 SELECT 1 FROM bidding_distribution bd
                 WHERE bd.bidding_id = b.bidding_id AND bd.shop_id = ?
               )
             )
           )
         )`,
      [id, shopId, shopId, shopId]
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
      analysis = sanitizeAnalysisResultForRead(
        typeof b.analysis_result === 'string' ? JSON.parse(b.analysis_result || '{}') : (b.analysis_result || {})
      );
      enrichAnalysisResultHumanDisplay(analysis);
      images = typeof b.images === 'string' ? JSON.parse(b.images || '[]') : (b.images || []);
    } catch (_) {}

    const [quoted] = await pool.execute(
      'SELECT quote_id, amount, items, value_added_services, duration, remark, quote_status, quote_valid_until FROM quotes WHERE bidding_id = ? AND shop_id = ?',
      [id, shopId]
    );

    const complexityService = require('./services/complexity-service');
    let quoteItemsForNorm = [];
    if (quoted.length > 0) {
      try {
        quoteItemsForNorm =
          typeof quoted[0].items === 'string' ? JSON.parse(quoted[0].items || '[]') : (quoted[0].items || []);
      } catch (_) {
        quoteItemsForNorm = [];
      }
    }
    const repairItems = complexityService.normalizeRepairItems(quoteItemsForNorm, analysis);
    let complexityLevel = 'L2';
    try {
      const resolved = await complexityService.resolveComplexityFromItems(pool, repairItems);
      if (resolved && resolved.level) complexityLevel = resolved.level;
    } catch (cErr) {
      console.warn(
        '[merchant/bidding/:id] 复杂度依赖 reward_rules.complexityLevels，本地未配置时降级 L2。云端请在后台补全奖励规则。',
        cErr.message
      );
    }
    const est = analysis.total_estimate;
    const estMid = Array.isArray(est) && est.length >= 2 ? (parseFloat(est[0]) + parseFloat(est[1])) / 2 : 5000;
    const orderTier = estMid < 1000 ? 1 : estMid < 5000 ? 2 : estMid < 20000 ? 3 : 4;

    const userDescription = (b.user_description || '').trim() || null;

    let insuranceInfo = {};
    try {
      insuranceInfo =
        typeof b.insurance_info === 'string' ? JSON.parse(b.insurance_info || '{}') : (b.insurance_info || {});
    } catch (_) {
      insuranceInfo = {};
    }

    let myQuote = null;
    if (quoted.length > 0) {
      const q0 = quoted[0];
      let qItems = [];
      let qVa = [];
      try {
        qItems = typeof q0.items === 'string' ? JSON.parse(q0.items || '[]') : (q0.items || []);
      } catch (_) {
        qItems = [];
      }
      try {
        qVa =
          typeof q0.value_added_services === 'string'
            ? JSON.parse(q0.value_added_services || '[]')
            : (q0.value_added_services || []);
      } catch (_) {
        qVa = [];
      }
      myQuote = {
        quote_id: q0.quote_id,
        amount: q0.amount,
        items: qItems,
        value_added_services: qVa,
        duration: q0.duration,
        remark: q0.remark,
        quote_status: q0.quote_status != null ? q0.quote_status : 0,
        quote_valid_until: q0.quote_valid_until
      };
    }

    res.json(successResponse({
      bidding_id: b.bidding_id,
      report_id: b.report_id,
      vehicle_info: vehicleInfo,
      insurance_info: insuranceInfo,
      range_km: b.range_km,
      expire_at: b.expire_at,
      status: b.status,
      images,
      user_description: userDescription,
      analysis_result: analysis,
      complexity_level: complexityLevel,
      order_tier: orderTier,
      my_quote: myQuote
    }));
  } catch (error) {
    console.error('服务商竞价详情错误:', error);
    res.status(500).json(errorResponse(safeErrorMessage(error, '获取竞价详情失败'), 500));
  }
});

// 提交报价（需资质审核通过）
app.post('/api/v1/merchant/quote', authenticateMerchant, requireQualification, async (req, res) => {
  try {
    const { bidding_id, amount, items, value_added_services, duration, remark } = req.body;
    const shopId = req.shopId;

    if (!bidding_id || !amount || amount <= 0) {
      return res.status(400).json(errorResponse('请填写有效报价金额'));
    }
    // 预报价有效期：固定 24 小时（规则强约束），不允许服务商自定义，避免选厂时口径不一致
    const dur = duration != null && duration !== '' ? parseInt(duration, 10) : NaN;
    if (isNaN(dur) || dur < 0) {
      return res.status(400).json(errorResponse('请填写预计工期（天）'));
    }

    const sanitized = quoteImportService.sanitizeQuoteItemsStrict(items);
    if (!sanitized.ok) {
      return res.status(400).json(errorResponse(sanitized.error));
    }
    const amtNum = parseFloat(amount);
    if (Math.abs(sanitized.sumPrice - amtNum) > 0.51) {
      return res.status(400).json(
        errorResponse(`分项金额合计 ¥${sanitized.sumPrice} 与总报价 ¥${amtNum} 不一致，请核对`)
      );
    }
    const war = sanitized.maxWarranty;

    const [biddingCheck] = await pool.execute(
      'SELECT bidding_id, status FROM biddings WHERE bidding_id = ?',
      [bidding_id]
    );
    if (biddingCheck.length === 0) return res.status(404).json(errorResponse('竞价不存在'));
    if (biddingCheck[0].status !== 0) return res.status(400).json(errorResponse('该竞价已结束'));

    const [bTime] = await pool.execute(
      'SELECT expire_at FROM biddings WHERE bidding_id = ?',
      [bidding_id]
    );
    if (bTime.length > 0 && bTime[0].expire_at) {
      const ex = new Date(bTime[0].expire_at).getTime();
      if (Date.now() > ex) {
        return res.status(400).json(errorResponse('竞价报价窗口已结束，无法提交新报价'));
      }
    }

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

    const visible = await biddingDistribution.isShopVisibleForBidding(pool, shopId, bidding_id, 'pending');
    if (!visible) return res.status(403).json(errorResponse('该竞价未邀请您'));

    const quoteId = 'QUO' + Date.now();
    // 有效期与 NOW() 比较一致，避免 toISOString(UTC) 写入 DATETIME 导致与库时区错位、提前判过期
    await pool.execute(
      `INSERT INTO quotes (quote_id, bidding_id, shop_id, amount, items, value_added_services, duration, warranty, remark, quote_valid_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))`,
      [quoteId, bidding_id, shopId, amount, JSON.stringify(sanitized.items), JSON.stringify(value_added_services || []), dur, war, remark || null]
    );

    try {
      const { hasColumn } = require('./utils/db-utils');
      const crypto = require('crypto');
      const [biddingRows] = await pool.execute('SELECT user_id FROM biddings WHERE bidding_id = ?', [bidding_id]);
      if (biddingRows.length > 0) {
        const ownerUserId = biddingRows[0].user_id;
        const [shops] = await pool.execute('SELECT name FROM shops WHERE shop_id = ?', [shopId]);
        const shopName = (shops.length > 0 && shops[0].name) ? String(shops[0].name).trim() : '维修厂';

        if (await hasColumn(pool, 'user_messages', 'message_id')) {
          const msgId = 'umsg_' + crypto.randomBytes(12).toString('hex');
          const title = '新报价待查看';
          const content = `${shopName.slice(0, 24)} 已提交报价 ¥${amtNum}，请进入竞价详情比价。`;
          await pool.execute(
            `INSERT INTO user_messages (message_id, user_id, type, title, content, related_id, is_read)
             VALUES (?, ?, 'bidding', ?, ?, ?, 0)`,
            [msgId, ownerUserId, title, content, bidding_id]
          );
        }

        const subMsg = require('./services/subscribe-message-service');
        subMsg.sendToUser(
          pool,
          ownerUserId,
          'user_bidding_quote',
          { title: '您有新报价', content: `${shopName.slice(0, 6)}已报价，请查看`, relatedId: bidding_id },
          process.env.WX_APPID,
          process.env.WX_SECRET
        ).catch((e) => console.warn('[merchant/quote] 订阅消息发送异常:', e));
      }
    } catch (msgErr) {
      if (!String((msgErr && msgErr.message) || '').includes('subscribe')) {
        console.warn('[merchant/quote] 通知车主失败:', msgErr && msgErr.message);
      }
    }

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
    const lim = Math.trunc(limit);
    const off = Math.trunc((page - 1) * limit);

    let where = 'WHERE o.shop_id = ?';
    const params = [shopId];
    if (status !== undefined && status !== '' && status !== null) {
      where += ' AND o.status = ?';
      params.push(parseInt(status, 10));
    }

    const [list] = await pool.execute(
      `SELECT o.order_id, o.bidding_id, o.quoted_amount, o.status, o.created_at,
        o.order_tier, o.complexity_level, o.commission_rate, o.repair_plan_status,
        o.commission, o.commission_status, o.commission_provisional, o.commission_final, o.commission_paid_amount,
        b.vehicle_info, dr.analysis_result
       FROM orders o
       LEFT JOIN biddings b ON o.bidding_id = b.bidding_id
       LEFT JOIN damage_reports dr ON b.report_id = dr.report_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT ${lim} OFFSET ${off}`,
      [...params]
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
        repair_plan_status: row.repair_plan_status != null ? parseInt(row.repair_plan_status, 10) : 0,
        commission: row.commission,
        commission_status: row.commission_status,
        commission_provisional: row.commission_provisional,
        commission_final: row.commission_final,
        commission_paid_amount: row.commission_paid_amount,
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
      `SELECT o.*, b.vehicle_info, b.report_id, b.insurance_info, dr.analysis_result, dr.images,
        dr.user_description AS damage_report_user_description,
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
    let insuranceInfo = {};
    try {
      vehicleInfo = typeof o.vehicle_info === 'string' ? JSON.parse(o.vehicle_info) : (o.vehicle_info || {});
      analysis = sanitizeAnalysisResultForRead(
        typeof o.analysis_result === 'string' ? JSON.parse(o.analysis_result || '{}') : (o.analysis_result || {})
      );
      enrichAnalysisResultHumanDisplay(analysis);
      images = typeof o.images === 'string' ? JSON.parse(o.images || '[]') : (o.images || []);
      insuranceInfo = typeof o.insurance_info === 'string' ? JSON.parse(o.insurance_info || '{}') : (o.insurance_info || {});
    } catch (_) {}
    const orderAccidentTypeLabels = {
      single: '单方事故',
      self_fault: '己方全责',
      other_fault: '对方全责',
      equal_fault: '同等责任',
      other_main: '对方主责',
      self_main: '己方主责'
    };
    if (insuranceInfo.is_insurance && insuranceInfo.accident_type) {
      insuranceInfo.accident_type_label = orderAccidentTypeLabels[insuranceInfo.accident_type] || insuranceInfo.accident_type;
    }
    const damageReportUserDescription = (o.damage_report_user_description || '').trim() || null;

    const [quote] = await pool.execute(
      'SELECT amount, items, duration, remark, value_added_services FROM quotes WHERE quote_id = ?',
      [o.quote_id]
    );

    const quoteObj = quote.length > 0 ? {
      amount: quote[0].amount,
      items: typeof quote[0].items === 'string' ? JSON.parse(quote[0].items || '[]') : (quote[0].items || []),
      duration: quote[0].duration,
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

    // 撤单申请旧链路已下线
    const pendingCancel = null;

    let materialAuditStatus = null;
    let materialAuditRejectReason = null;
    if (parseInt(o.status, 10) === 1) {
      try {
        const [auditRows] = await pool.execute(
          `SELECT status, reject_reason FROM material_audit_tasks WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`,
          [id]
        );
        if (auditRows.length > 0) {
          materialAuditStatus = auditRows[0].status;
          materialAuditRejectReason = auditRows[0].reject_reason;
        }
      } catch (_) {}
    }

    let repairPlan = null;
    let repairPlanStatus = 0;
    if (o.repair_plan) {
      try {
        repairPlan = typeof o.repair_plan === 'string' ? JSON.parse(o.repair_plan) : o.repair_plan;
      } catch (_) {}
    }
    if (o.repair_plan_status != null) repairPlanStatus = parseInt(o.repair_plan_status, 10) || 0;

    const parseSnap = (v) => {
      if (v == null || v === '') return null;
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch (_) {
        return null;
      }
    };

    let quoteProposals = [];
    try {
      if (await orderQuoteProposalService.proposalsTableExists(pool)) {
        quoteProposals = await orderQuoteProposalService.listFormatted(pool, id);
      }
    } catch (_) {}

    let repairMilestones = [];
    try {
      if (await repairMilestoneService.milestonesTableExists(pool)) {
        repairMilestones = await repairMilestoneService.listForOrder(pool, id);
      }
    } catch (_) {}

    // 车主自救请求（维修商未处理/强制结单）
    let selfHelpRequests = [];
    try {
      const [sRows] = await pool.execute(
        `SELECT request_id, user_id, request_type, note, image_urls, status, created_at
         FROM order_self_help_requests
         WHERE order_id = ?
         ORDER BY created_at DESC
         LIMIT 20`,
        [id]
      );
      selfHelpRequests = (sRows || []).map((r) => {
        let imgs = [];
        try {
          imgs = typeof r.image_urls === 'string' ? JSON.parse(r.image_urls || '[]') : (r.image_urls || []);
        } catch (_) {
          imgs = [];
        }
        return {
          request_id: r.request_id,
          user_id: r.user_id,
          request_type: r.request_type,
          note: r.note,
          status: r.status,
          image_urls: Array.isArray(imgs) ? imgs : [],
          created_at: r.created_at
        };
      });
    } catch (_) {}

    // 等待配件延期记录
    let waitingPartsExtensions = [];
    try {
      const [eRows] = await pool.execute(
        `SELECT extension_id, shop_id, note, proof_urls, extend_days, status, created_at
         FROM order_waiting_parts_extensions
         WHERE order_id = ?
         ORDER BY created_at DESC
         LIMIT 20`,
        [id]
      );
      waitingPartsExtensions = (eRows || []).map((p) => {
        let imgs = [];
        try {
          imgs = typeof p.proof_urls === 'string' ? JSON.parse(p.proof_urls || '[]') : (p.proof_urls || []);
        } catch (_) {
          imgs = [];
        }
        return {
          extension_id: p.extension_id,
          shop_id: p.shop_id,
          note: p.note,
          extend_days: p.extend_days,
          status: p.status,
          proof_urls: Array.isArray(imgs) ? imgs : [],
          created_at: p.created_at
        };
      });
    } catch (_) {}

    res.json(successResponse({
      order_id: o.order_id,
      bidding_id: o.bidding_id,
      status: o.status,
      is_insurance_accident: o.is_insurance_accident === 1 || o.is_insurance_accident === '1' ? 1 : 0,
      quoted_amount: o.quoted_amount,
      order_tier: o.order_tier,
      complexity_level: o.complexity_level,
      commission_rate: o.commission_rate,
      vehicle_info: vehicleInfo,
      analysis_result: analysis,
      images,
      user_description: damageReportUserDescription,
      insurance_info: insuranceInfo,
      owner_nickname: o.nickname,
      owner_phone: o.owner_phone,
      quote: quoteObj,
      repair_plan: repairPlan,
      repair_plan_status: repairPlanStatus,
      pre_quote_snapshot: parseSnap(o.pre_quote_snapshot),
      final_quote_snapshot: parseSnap(o.final_quote_snapshot),
      final_quote_status: o.final_quote_status != null ? parseInt(o.final_quote_status, 10) : null,
      loss_assessment_documents: parseSnap(o.loss_assessment_documents),
      final_quote_submitted_at: o.final_quote_submitted_at || null,
      final_quote_confirmed_at: o.final_quote_confirmed_at || null,
      deviation_rate: o.deviation_rate != null ? parseFloat(o.deviation_rate) : null,
      duration_deadline: durationDeadline,
      duration_deadline_text: durationDeadlineText,
      lifecycle_main: o.lifecycle_main || null,
      lifecycle_sub: o.lifecycle_sub || null,
      lifecycle_started_at: o.lifecycle_started_at || null,
      lifecycle_deadline_at: o.lifecycle_deadline_at || null,
      promised_delivery_at: o.promised_delivery_at || null,
      created_at: o.created_at,
      accepted_at: o.accepted_at,
      pending_cancel_request: null,
      material_audit_status: materialAuditStatus,
      material_audit_reject_reason: materialAuditRejectReason,
      quote_proposals: quoteProposals,
      repair_milestones: repairMilestones,
      self_help_requests: selfHelpRequests,
      waiting_parts_extensions: waitingPartsExtensions,
      warranty_card_template_id:
        o.warranty_card_template_id != null && o.warranty_card_template_id !== ''
          ? orderWarrantyCardService.normalizeTemplateId(o.warranty_card_template_id)
          : null
    }));
  } catch (error) {
    console.error('服务商订单详情错误:', error);
    res.status(500).json(errorResponse('获取订单详情失败', 500));
  }
});

// 电子质保凭证（商户只读，存证数据）
app.get('/api/v1/merchant/orders/:id/warranty-card', authenticateMerchant, async (req, res) => {
  try {
    const r = await orderWarrantyCardService.getWarrantyCard(pool, req.params.id, { shopId: req.shopId });
    if (!r.ok) return res.status(r.statusCode || 400).json(errorResponse(r.error));
    res.json(successResponse(r.data));
  } catch (error) {
    console.error('商户电子质保凭证错误:', error);
    res.status(500).json(errorResponse('获取电子质保凭证失败', 500));
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

// 服务商：确认车主到店（生命周期倒计时推进）
app.post('/api/v1/merchant/orders/:id/arrived-confirm', authenticateMerchant, requireQualification, async (req, res) => {
  try {
    const result = await orderLifecycleService.merchantConfirmArrived(pool, req.params.id, req.shopId);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '已确认到店'));
  } catch (error) {
    console.error('merchant arrived-confirm error:', error);
    res.status(500).json(errorResponse('确认到店失败', 500));
  }
});

// 服务商：设置承诺交车时间（硬deadline）
app.put('/api/v1/merchant/orders/:id/promised-delivery', authenticateMerchant, requireQualification, async (req, res) => {
  try {
    const raw = req.body && (req.body.promised_delivery_at || req.body.promisedDeliveryAt);
    const dt = raw ? new Date(raw) : null;
    if (!dt || Number.isNaN(dt.getTime())) return res.status(400).json(errorResponse('请提供有效的承诺交车时间'));
    const now = Date.now();
    const min = now + 24 * 3600 * 1000;
    const max = now + 30 * 24 * 3600 * 1000;
    if (dt.getTime() < min) return res.status(400).json(errorResponse('承诺交车时间不得早于24小时后'));
    if (dt.getTime() > max) return res.status(400).json(errorResponse('承诺交车时间不得晚于30天后'));
    await pool.execute(
      `UPDATE orders SET promised_delivery_at = ?, updated_at = NOW() WHERE order_id = ? AND shop_id = ?`,
      [dt, req.params.id, req.shopId]
    );
    res.json(successResponse({ order_id: req.params.id, promised_delivery_at: dt.toISOString() }, '已设置承诺交车时间'));
  } catch (e) {
    console.error('promised-delivery error:', e);
    res.status(500).json(errorResponse('设置失败', 500));
  }
});

// 服务商：拆检项目清单/收据留痕（图片必填，金额/备注可选）
app.post('/api/v1/merchant/orders/:id/offline-fee-proof', authenticateMerchant, requireQualification, async (req, res) => {
  try {
    const { amount, note, image_urls } = req.body || {};
    const urls = Array.isArray(image_urls) ? image_urls.map((u) => String(u || '').trim()).filter(Boolean) : [];
    if (!urls.length) return res.status(400).json(errorResponse('请至少上传 1 张图片'));
    const proofId = 'oofp_' + crypto.randomBytes(12).toString('hex');
    const amt = amount != null && amount !== '' ? parseFloat(amount) : null;
    const noteTrim = note != null ? String(note).trim() : '';
    await pool.execute(
      `INSERT INTO order_offline_fee_proofs
        (proof_id, order_id, uploader_type, uploader_id, proof_kind, amount, note, image_urls)
       VALUES (?, ?, 'merchant', ?, 'diagnostic_fee_receipt', ?, ?, ?)`,
      [proofId, req.params.id, String(req.shopId), Number.isFinite(amt) ? amt : null, noteTrim || null, JSON.stringify(urls)]
    );
    res.json(successResponse({ proof_id: proofId }, '已提交留痕'));
  } catch (e) {
    console.error('merchant offline fee proof error:', e);
    res.status(500).json(errorResponse('提交失败', 500));
  }
});

// 服务商：等待配件延期（上传采购凭证，默认延长 15 天）
app.post('/api/v1/merchant/orders/:id/waiting-parts-extension', authenticateMerchant, requireQualification, async (req, res) => {
  try {
    const { note, proof_urls, extend_days } = req.body || {};
    const urls = Array.isArray(proof_urls) ? proof_urls.map((u) => String(u || '').trim()).filter(Boolean) : [];
    if (!urls.length) return res.status(400).json(errorResponse('请至少上传 1 张采购/到货凭证'));
    const daysRaw = extend_days != null && extend_days !== '' ? parseInt(extend_days, 10) : 15;
    const days = Number.isNaN(daysRaw) ? 15 : Math.min(30, Math.max(1, daysRaw));
    const extId = 'owpe_' + crypto.randomBytes(12).toString('hex');
    await pool.execute(
      `INSERT INTO order_waiting_parts_extensions (extension_id, order_id, shop_id, note, proof_urls, extend_days, status)
       VALUES (?, ?, ?, ?, ?, ?, 'approved')`,
      [extId, req.params.id, String(req.shopId), note ? String(note).trim() : null, JSON.stringify(urls), days]
    );
    // 延长订单 deadline（仅当存在 lifecycle_deadline_at）
    try {
      await pool.execute(
        `UPDATE orders
         SET lifecycle_sub = 'waiting_parts',
             lifecycle_deadline_at = CASE
               WHEN lifecycle_deadline_at IS NULL THEN DATE_ADD(NOW(), INTERVAL ? DAY)
               ELSE DATE_ADD(lifecycle_deadline_at, INTERVAL ? DAY)
             END,
             updated_at = NOW()
         WHERE order_id = ? AND shop_id = ?`,
        [days, days, req.params.id, req.shopId]
      );
    } catch (_) {}
    res.json(successResponse({ extension_id: extId, extend_days: days }, '已记录等待配件延期'));
  } catch (e) {
    console.error('waiting parts extension error:', e);
    res.status(500).json(errorResponse('提交失败', 500));
  }
});

// 更新订单状态（维修中→待确认；1→2 先提交材料并创建审核任务，审核通过后再推进到 2，不阻塞商户提交）
app.put('/api/v1/merchant/orders/:id/status', authenticateMerchant, async (req, res) => {
  try {
    const { status, completion_evidence, warranty_card_template_id } = req.body || {};
    const result = await orderService.updateOrderStatus(pool, req.params.id, req.shopId, status, {
      completion_evidence,
      warranty_card_template_id
    });
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    if (result.data.task_id) {
      const baseUrl = process.env.BASE_URL || (req.protocol || 'http') + '://' + (req.get?.('host') || `localhost:${PORT}`);
      materialAuditService.runMaterialAuditAsync(pool, result.data.task_id, baseUrl);
    }
    const msg = result.data.task_id
      ? '已提交完工材料；后台将核验结算单与金额一致性，通过后自动进入待验收'
      : '已标记为待用户确认';
    res.json(successResponse(result.data, msg));
  } catch (error) {
    console.error('更新订单状态错误:', error);
    res.status(500).json(errorResponse('更新失败', 500));
  }
});

// 维修过程关键节点（维修中留痕 + 通知车主）
app.post(
  '/api/v1/merchant/orders/:id/repair-milestones',
  authenticateMerchant,
  requireCapability(CAPABILITIES.REPAIR_TIMELINE_PUBLIC, { message: '维修过程留痕暂未开放' }),
  async (req, res) => {
  try {
    const r = await repairMilestoneService.createMilestone(
      pool,
      req.params.id,
      req.shopId,
      req.body || {},
      req.merchantId
    );
    if (!r.success) {
      return res.status(r.statusCode || 400).json(errorResponse(r.error));
    }
    res.json(successResponse(r.data, '已记录维修进展'));
  } catch (error) {
    console.error('维修进展记录错误:', error);
    res.status(500).json(errorResponse('记录失败', 500));
  }
  }
);

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

// 服务商提交到店最终报价（双阶段报价；车主确认前）
app.put('/api/v1/merchant/orders/:id/final-quote', authenticateMerchant, async (req, res) => {
  try {
    const result = await orderService.submitFinalQuote(pool, req.params.id, req.shopId, req.body || {});
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '已提交最终报价，请等待车主确认'));
  } catch (error) {
    console.error('提交最终报价错误:', error);
    res.status(500).json(errorResponse('提交失败', 500));
  }
});

// 商户申诉：待申诉列表
app.get('/api/v1/merchant/appeals', authenticateMerchant, async (req, res) => {
  try {
    const status = req.query.status;
    const limit = parseInt(req.query.limit) || 20;
    const list = await merchantEvidenceService.listAppealRequests(pool, req.shopId, { status, limit });
    res.json(successResponse({ list }));
  } catch (error) {
    console.error('获取申诉列表错误:', error);
    res.status(500).json(errorResponse('获取失败', 500));
  }
});

// 商户申诉：提交申诉材料（提交后异步 AI 初审）
app.post('/api/v1/merchant/appeals/:requestId/submit', authenticateMerchant, async (req, res) => {
  try {
    const { requestId } = req.params;
    const { evidence_urls } = req.body || {};
    const result = await merchantEvidenceService.submitAppealRequest(pool, requestId, req.shopId, evidence_urls);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    const baseUrl = process.env.BASE_URL || (req.protocol || 'http') + '://' + (req.get?.('host') || `localhost:${PORT}`);
    merchantEvidenceService.runAppealReviewAsync(pool, requestId, baseUrl);
    res.json(successResponse(result.data, '申诉材料已提交，请等待审核'));
  } catch (error) {
    console.error('提交申诉材料错误:', error);
    res.status(500).json(errorResponse('提交失败', 500));
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
    res.status(500).json(errorResponse(safeErrorMessage(error, '撤回失败'), 500));
  }
});

// 服务商消息列表
app.get('/api/v1/merchant/messages', authenticateMerchant, async (req, res) => {
  try {
    const { page, limit, lim, off } = clampPagination(req.query.page, req.query.limit, 10, 50);

    const [list] = await pool.execute(
      `SELECT message_id, type, title, content, related_id, is_read, created_at
       FROM merchant_messages
       WHERE merchant_id = ?
       ORDER BY created_at DESC
       LIMIT ${lim} OFFSET ${off}`,
      [req.merchantId]
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
// 服务商商品管理
app.get('/api/v1/merchant/products', authenticateMerchant, async (req, res) => {
  try {
    const result = await shopProductService.listByShop(pool, req.shopId);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取商品列表错误:', error);
    res.status(500).json(errorResponse('获取商品列表失败', 500));
  }
});

app.post('/api/v1/merchant/products', authenticateMerchant, async (req, res) => {
  try {
    const result = await shopProductService.create(pool, req.shopId, req.body);
    if (!result.success) return res.status(result.statusCode || 400).json(errorResponse(result.error));
    res.json(successResponse(result.data, result.data?.message || '已提交审核'));
  } catch (error) {
    console.error('上架商品错误:', error);
    res.status(500).json(errorResponse('上架商品失败', 500));
  }
});

app.put('/api/v1/merchant/products/:productId', authenticateMerchant, async (req, res) => {
  try {
    const result = await shopProductService.update(pool, req.shopId, req.params.productId, req.body);
    if (!result.success) return res.status(result.statusCode || 400).json(errorResponse(result.error));
    res.json(successResponse(result.data, result.data?.message || '已更新'));
  } catch (error) {
    console.error('编辑商品错误:', error);
    res.status(500).json(errorResponse('编辑商品失败', 500));
  }
});

app.post('/api/v1/merchant/products/:productId/off-shelf', authenticateMerchant, async (req, res) => {
  try {
    const result = await shopProductService.offShelf(pool, req.shopId, req.params.productId);
    if (!result.success) return res.status(result.statusCode || 400).json(errorResponse(result.error));
    res.json(successResponse(result.data, '已下架'));
  } catch (error) {
    console.error('下架商品错误:', error);
    res.status(500).json(errorResponse('下架商品失败', 500));
  }
});

app.delete('/api/v1/merchant/products/:productId', authenticateMerchant, async (req, res) => {
  try {
    const result = await shopProductService.deletePending(pool, req.shopId, req.params.productId);
    if (!result.success) return res.status(result.statusCode || 400).json(errorResponse(result.error));
    res.json(successResponse(result.data, '已撤回'));
  } catch (error) {
    console.error('撤回商品错误:', error);
    res.status(500).json(errorResponse('撤回失败', 500));
  }
});

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
      qualification_withdrawn: (s.qualification_withdrawn === 1 || s.qualification_withdrawn === '1') ? 1 : 0,
      warranty_card_template_id: orderWarrantyCardService.normalizeTemplateId(s.warranty_card_template_id)
    }));
  } catch (error) {
    console.error('获取店铺信息错误:', error);
    res.status(500).json(errorResponse('获取店铺信息失败', 500));
  }
});

app.get('/api/v1/merchant/warranty-card/templates', authenticateMerchant, async (req, res) => {
  try {
    res.json(successResponse({ templates: orderWarrantyCardService.listTemplates() }));
  } catch (e) {
    res.status(500).json(errorResponse('获取模板失败', 500));
  }
});

app.put('/api/v1/merchant/shop', authenticateMerchant, async (req, res) => {
  try {
    const { name, address, latitude, longitude, phone, business_hours, categories, qualification_level, qualification_ai_recognized, qualification_ai_result, technician_certs, shop_images, certifications, warranty_card_template_id } = req.body;
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
    const hasShopWctCol = await dbHasColumn(pool, 'shops', 'warranty_card_template_id');
    const shopSelectExtra = hasShopWctCol ? ', warranty_card_template_id' : '';
    const [shops] = await pool.execute(
      `SELECT name, address, latitude, longitude, phone, business_hours, categories, qualification_level, qualification_ai_recognized, qualification_ai_result, technician_certs, shop_images, certifications, qualification_status, qualification_audit_reason${shopSelectExtra} FROM shops WHERE shop_id = ?`,
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
      const mergedForTech =
        technician_certs !== undefined ? technician_certs : shopTechnicianUtils.parseTechnicianCerts(s.technician_certs);
      const techMin = shopTechnicianUtils.validateOptionalTechnicianCerts(mergedForTech);
      if (!techMin.ok) {
        return res.status(400).json(errorResponse(techMin.error));
      }
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

    const newWarrantyTpl =
      hasShopWctCol && warranty_card_template_id !== undefined
        ? orderWarrantyCardService.normalizeTemplateId(warranty_card_template_id)
        : hasShopWctCol
          ? orderWarrantyCardService.normalizeTemplateId(s.warranty_card_template_id)
          : null;

    if (hasShopWctCol) {
      await pool.execute(
        `UPDATE shops SET name = ?, address = ?, latitude = ?, longitude = ?, phone = ?, business_hours = ?, categories = ?, qualification_level = ?, qualification_ai_recognized = ?, qualification_ai_result = ?, technician_certs = ?, shop_images = ?, certifications = ?, warranty_card_template_id = ?, qualification_status = ?, qualification_audit_reason = ?, qualification_withdrawn = 0, updated_at = NOW()
         WHERE shop_id = ?`,
        [
          updates.name,
          updates.address,
          updates.latitude,
          updates.longitude,
          updates.phone,
          updates.business_hours,
          updates.categories,
          updates.qualification_level,
          updates.qualification_ai_recognized,
          updates.qualification_ai_result,
          updates.technician_certs,
          updates.shop_images,
          updates.certifications,
          newWarrantyTpl,
          newQualStatus,
          auditReason,
          req.shopId
        ]
      );
    } else {
      await pool.execute(
        `UPDATE shops SET name = ?, address = ?, latitude = ?, longitude = ?, phone = ?, business_hours = ?, categories = ?, qualification_level = ?, qualification_ai_recognized = ?, qualification_ai_result = ?, technician_certs = ?, shop_images = ?, certifications = ?, qualification_status = ?, qualification_audit_reason = ?, qualification_withdrawn = 0, updated_at = NOW()
         WHERE shop_id = ?`,
        [
          updates.name,
          updates.address,
          updates.latitude,
          updates.longitude,
          updates.phone,
          updates.business_hours,
          updates.categories,
          updates.qualification_level,
          updates.qualification_ai_recognized,
          updates.qualification_ai_result,
          updates.technician_certs,
          updates.shop_images,
          updates.certifications,
          newQualStatus,
          auditReason,
          req.shopId
        ]
      );
    }
    res.json(successResponse(null, (qualChanged || isResubmitAfterReject) ? '保存成功，资质信息已提交审核' : '保存成功'));
  } catch (error) {
    console.error('更新店铺信息错误:', error.message, error.sql || '', error.code || '');
    res.status(500).json(errorResponse(safeErrorMessage(error, '保存失败'), 500));
  }
});

/** 标准报价表模板（CSV 说明与示例，供电脑填表后导入） */
app.get('/api/v1/merchant/quote-template', authenticateMerchant, (req, res) => {
  try {
    res.json(successResponse(quoteImportService.getQuoteTemplatePayload()));
  } catch (e) {
    res.status(500).json(errorResponse('获取模板失败', 500));
  }
});

/** 标准报价表 Excel 模板（含中文使用说明 + 报价明细，下载到本地用 Excel/WPS 打开） */
app.get('/api/v1/merchant/quote-template.xlsx', authenticateMerchant, async (req, res) => {
  try {
    const buf = await quoteTemplateXlsx.buildQuoteTemplateXlsxBuffer();
    const asciiName = 'zhejian-quote-template.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(quoteTemplateXlsx.TEMPLATE_FILENAME)}`
    );
    res.send(buf);
  } catch (e) {
    console.error('[quote-template.xlsx]', e && e.message);
    res.status(500).json(errorResponse('生成 Excel 模板失败', 500));
  }
});

/** 解析上传的 CSV 文本 → 报价 items 预览 */
app.post('/api/v1/merchant/quote-import/preview', authenticateMerchant, async (req, res) => {
  try {
    const csvText = (req.body && req.body.csv_text) != null ? String(req.body.csv_text) : '';
    const r = quoteImportService.parseQuoteImportCsv(csvText);
    if (!r.ok) {
      return res.status(400).json(errorResponse((r.errors && r.errors.join('；')) || '解析失败'));
    }
    const payload = {
      items: r.items,
      amount_sum: r.amount_sum,
      ai_enriched: false,
      missing_fields: [],
      ai_warnings: [],
    };
    const apiKey = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.ALIYUN_AI_KEY;
    const wantAi = req.body && req.body.ai_enrich !== false && process.env.QUOTE_IMPORT_AI_ENRICH !== '0';
    if (apiKey && wantAi) {
      try {
        const enriched = await qwenAnalyzer.enrichQuoteItemsWithQwen(r.items, r.amount_sum, apiKey);
        payload.items = enriched.items && enriched.items.length ? enriched.items : r.items;
        payload.missing_fields = enriched.missing_fields || [];
        payload.ai_warnings = enriched.warnings || [];
        payload.ai_enriched = true;
      } catch (aiErr) {
        payload.ai_enrich_error = safeErrorMessage(aiErr, 'AI 规范化失败');
      }
    }
    res.json(successResponse(payload));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '解析失败'), 500));
  }
});

/** 解析上传的 Excel（.xlsx）→ 报价 items 预览（与 CSV 预览字段一致） */
app.post(
  '/api/v1/merchant/quote-import/preview-xlsx',
  authenticateMerchant,
  (req, res, next) => {
    quoteImportXlsxUpload(req, res, (err) => {
      if (err) {
        const msg =
          err.code === 'LIMIT_FILE_SIZE' ? 'Excel 文件请不超过 5MB' : err.message || '上传失败';
        return res.status(400).json(errorResponse(msg, 400));
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const buf = req.file && req.file.buffer;
      if (!buf || !buf.length) {
        return res.status(400).json(errorResponse('请选择 .xlsx 文件', 400));
      }
      const r = await quoteImportService.parseQuoteImportXlsx(buf);
      if (!r.ok) {
        return res.status(400).json(errorResponse((r.errors && r.errors.join('；')) || '解析失败'));
      }
      const payload = {
        items: r.items,
        amount_sum: r.amount_sum,
        ai_enriched: false,
        missing_fields: [],
        ai_warnings: [],
      };
      const apiKey = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.ALIYUN_AI_KEY;
      const wantAi =
        req.body &&
        req.body.ai_enrich !== 'false' &&
        req.body.ai_enrich !== '0' &&
        process.env.QUOTE_IMPORT_AI_ENRICH !== '0';
      if (apiKey && wantAi) {
        try {
          const enriched = await qwenAnalyzer.enrichQuoteItemsWithQwen(r.items, r.amount_sum, apiKey);
          payload.items = enriched.items && enriched.items.length ? enriched.items : r.items;
          payload.missing_fields = enriched.missing_fields || [];
          payload.ai_warnings = enriched.warnings || [];
          payload.ai_enriched = true;
        } catch (aiErr) {
          payload.ai_enrich_error = safeErrorMessage(aiErr, 'AI 规范化失败');
        }
      }
      res.json(successResponse(payload));
    } catch (e) {
      res.status(500).json(errorResponse(safeErrorMessage(e, '解析失败'), 500));
    }
  }
);

/** 报价单拍照 AI 结构化（需配置 QWEN_API_KEY / DASHSCOPE_API_KEY） */
app.post(
  '/api/v1/merchant/quote-sheet/analyze-image',
  authenticateMerchant,
  requireCapability(CAPABILITIES.QUOTE_OCR_IMPORT, { message: '报价单识别暂未开放' }),
  async (req, res) => {
  try {
    const imageUrl = req.body && req.body.image_url;
    const apiKey = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.ALIYUN_AI_KEY;
    if (!apiKey) {
      return res.status(503).json(errorResponse('未配置千问 API Key，无法使用拍照识别', 503));
    }
    const out = await qwenAnalyzer.analyzeRepairQuoteSheetWithQwen(imageUrl, apiKey);
    res.json(successResponse(out));
  } catch (e) {
    res.status(400).json(errorResponse(e.message || '识别失败'));
  }
  }
);

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
    const trust = await antifraud.getUserTrustLevel(pool, req.userId);
    const levelNames = { 0: '风险受限', 1: '基础注册', 2: '普通可信', 3: '活跃可信', 4: '核心标杆' };
    const idNo = user.id_card_no ? String(user.id_card_no) : '';
    const phoneRaw = user.phone;
    const phoneOut =
      phoneRaw == null || phoneRaw === ''
        ? ''
        : Buffer.isBuffer(phoneRaw)
          ? phoneRaw.toString('utf8').trim()
          : String(phoneRaw).trim();
    res.json(successResponse({
      user_id: user.user_id,
      nickname: user.nickname,
      avatar_url: user.avatar_url,
      phone: phoneOut,
      withdraw_real_name: user.withdraw_real_name || '',
      id_card_tail: idNo.length >= 4 ? idNo.slice(-4) : '',
      level: trust.level,
      level_name: levelNames[trust.level] || levelNames[0],
      needs_verification: trust.needsVerification === true,
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
    // 手机号更新：同步实名认证，并尝试触发回溯奖励
    if (phone !== undefined && phone !== null && String(phone).trim()) {
      try {
        await pool.execute(
          `INSERT INTO user_verification (user_id, verified, verified_at) VALUES (?, 1, NOW())
           ON DUPLICATE KEY UPDATE verified = 1, verified_at = COALESCE(verified_at, NOW())`,
          [req.userId]
        );
        const trust = await antifraud.getUserTrustLevel(pool, req.userId);
        if (trust.level >= 1) {
          await pool.execute(
            'UPDATE users SET level = ?, level_updated_at = NOW() WHERE user_id = ?',
            [trust.level, req.userId]
          );
          const backfill = await antifraud.processWithheldRewards(pool, req.userId);
          if (backfill.paid > 0) {
            console.log(`[user/profile] 用户 ${req.userId} 完成认证，回溯发放奖励 ${backfill.paid} 元`);
          }
        }
      } catch (e) {
        console.error('[user/profile] 实名同步或回溯失败:', e.message);
      }
    }
    res.json(successResponse(null, '更新成功'));
  } catch (error) {
    console.error('[PUT /api/v1/user/profile]', error);
    res.status(500).json(errorResponse(safeErrorMessage(error, '更新失败'), 500));
  }
});

// 获取用户等级与可信度（供前端展示、判断是否需提示实名/车辆）
app.get('/api/v1/user/trust-level', authenticateToken, async (req, res) => {
  try {
    const trust = await antifraud.getUserTrustLevel(pool, req.userId);
    res.json(successResponse({
      level: trust.level,
      level_name: trust.levelName,
      weight: trust.weight,
      needs_verification: trust.needsVerification === true,
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取等级失败', 500));
  }
});

// 获取用户等级详情（升级进度、权益、保级条件，供个人中心等级详情页）
app.get('/api/v1/user/level-detail', authenticateToken, async (req, res) => {
  try {
    const detail = await antifraud.getUserLevelDetail(pool, req.userId);
    res.json(successResponse(detail));
  } catch (error) {
    res.status(500).json(errorResponse('获取等级详情失败', 500));
  }
});

// 绑定一级推荐人（仅首次；成功后 is_distribution_buyer=1，供转化/post_verify 作者侧减半）
app.post('/api/v1/user/referral/bind', authenticateToken, async (req, res) => {
  try {
    const referralService = require('./services/referral-service');
    const { referrer_user_id } = req.body || {};
    const result = await referralService.bindReferrer(pool, req.userId, referrer_user_id);
    if (!result.success) {
      return res.status(400).json(errorResponse(result.error || '绑定失败'));
    }
    res.json(successResponse({ bound: true }));
  } catch (error) {
    console.error('[user/referral/bind]', error);
    res.status(500).json(errorResponse(safeErrorMessage(error, '绑定失败'), 500));
  }
});

// 绑定车辆（阶段1：实名+车辆完成可升级1级并触发回溯）
app.post('/api/v1/user/vehicles', authenticateToken, async (req, res) => {
  try {
    const { plate_number, vin, vehicle_info } = req.body || {};
    const [count] = await pool.execute(
      'SELECT COUNT(*) as c FROM user_vehicles WHERE user_id = ? AND status = 1',
      [req.userId]
    );
    if ((count[0]?.c || 0) >= 3) {
      return res.status(400).json(errorResponse('最多绑定 3 台车辆'));
    }
    const vInfo = vehicle_info && typeof vehicle_info === 'object' ? JSON.stringify(vehicle_info) : null;
    await pool.execute(
      'INSERT INTO user_vehicles (user_id, plate_number, vin, vehicle_info, status) VALUES (?, ?, ?, ?, 1)',
      [req.userId, (plate_number || '').trim() || null, (vin || '').trim() || null, vInfo]
    );
    const trust = await antifraud.getUserTrustLevel(pool, req.userId);
    if (trust.level >= 1) {
      await pool.execute(
        'UPDATE users SET level = ?, level_updated_at = NOW() WHERE user_id = ?',
        [trust.level, req.userId]
      );
      const backfill = await antifraud.processWithheldRewards(pool, req.userId);
      if (backfill.paid > 0) {
        console.log(`[user/vehicles] 用户 ${req.userId} 完成车辆绑定，回溯发放奖励 ${backfill.paid} 元`);
      }
    }
    res.json(successResponse(null, '绑定成功'));
  } catch (error) {
    console.error('[POST /api/v1/user/vehicles]', error);
    res.status(500).json(errorResponse(safeErrorMessage(error, '绑定失败'), 500));
  }
});

// 获取绑定车辆列表
app.get('/api/v1/user/vehicles', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, plate_number, vin, vehicle_info, status, created_at FROM user_vehicles WHERE user_id = ? AND status = 1 ORDER BY created_at DESC',
      [req.userId]
    );
    const list = (rows || []).map((r) => ({
      id: r.id,
      plate_number: r.plate_number,
      vin: r.vin,
      vehicle_info: r.vehicle_info ? (typeof r.vehicle_info === 'string' ? JSON.parse(r.vehicle_info) : r.vehicle_info) : null,
      created_at: r.created_at,
    }));
    res.json(successResponse({ list }));
  } catch (error) {
    res.status(500).json(errorResponse('获取失败', 500));
  }
});

// 获取余额、累计返点、明细列表
app.get('/api/v1/user/balance', authenticateToken, async (req, res) => {
  try {
    const { page, limit, lim, off } = clampPagination(req.query.page, req.query.limit, 20, 100);
    const month = (req.query.month || '').trim();
    const typeFilter = (req.query.type || '').trim();

    let where = 'user_id = ?';
    const params = [req.userId];
    if (month) {
      where += ' AND settlement_month = ?';
      params.push(month);
    }
    if (typeFilter) {
      const types = typeFilter.split(',').map(s => s.trim()).filter(Boolean);
      if (types.length > 0) {
        where += ' AND type IN (' + types.map(() => '?').join(',') + ')';
        params.push(...types);
      }
    }

    const [userRes, transRes, countRes] = await Promise.all([
      pool.execute('SELECT balance, total_rebate FROM users WHERE user_id = ?', [req.userId]),
      pool.execute(
        `SELECT transaction_id, type, amount, description, settlement_month, related_id, reward_tier, review_stage, tax_deducted, created_at
         FROM transactions WHERE ${where}
         ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`,
        [...params]
      ),
      pool.execute(`SELECT COUNT(*) as total FROM transactions WHERE ${where}`, params)
    ]);

    const userRows = userRes[0];
    const transactions = transRes[0];
    const countResult = countRes[0];
    const balance = userRows && userRows.length > 0 ? parseFloat(userRows[0].balance) || 0 : 0;
    const total_rebate = userRows && userRows.length > 0 ? parseFloat(userRows[0].total_rebate) || 0 : 0;

    const typeLabels = { rebate: '主评价/追评奖励', upgrade_diff: '评价升级差额', like_bonus: '常规点赞追加', conversion_bonus: '内容转化追加', post_verify_bonus: '事后验证补发' };

    // 奖励明细：对 rebate/upgrade_diff 关联 review+order 获取复杂度，构建 breakdown
    const rebateIds = transactions.filter(t => (t.type === 'rebate' || t.type === 'upgrade_diff') && t.related_id).map(t => t.related_id);
    let reviewOrderMap = {};
    if (rebateIds.length > 0) {
      const [reviewOrders] = await pool.execute(
        `SELECT r.review_id, r.order_id, r.content_quality_level, r.content_quality, o.bidding_id, o.complexity_level, o.quoted_amount, o.actual_amount
         FROM reviews r JOIN orders o ON r.order_id = o.order_id
         WHERE r.review_id IN (${rebateIds.map(() => '?').join(',')})`,
        rebateIds
      );
      const biddingIds = [...new Set((reviewOrders || []).map(ro => ro.bidding_id).filter(Boolean))];
      let biddingVehicleMap = {};
      if (biddingIds.length > 0) {
        const [biddingRows] = await pool.execute(
          `SELECT bidding_id, vehicle_info FROM biddings WHERE bidding_id IN (${biddingIds.map(() => '?').join(',')})`,
          biddingIds
        );
        for (const b of biddingRows || []) {
          try {
            const vi = typeof b.vehicle_info === 'string' ? JSON.parse(b.vehicle_info || '{}') : (b.vehicle_info || {});
            const vp = vi.vehicle_price != null ? parseFloat(vi.vehicle_price) : null;
            const vpt = vi.vehicle_price_tier || '';
            const brand = vi.brand || '';
            let coeff = 1.0;
            if (vp != null && vp > 0) {
              const pw = vp / 10000;
              if (pw <= 10) coeff = 1.0; else if (pw <= 20) coeff = 1.2; else if (pw <= 30) coeff = 1.5; else if (pw <= 50) coeff = 2.0; else coeff = 3.0;
            } else if (['low', 'mid', 'high'].includes(vpt.toLowerCase())) {
              coeff = { low: 1.0, mid: 1.3, high: 1.5 }[vpt.toLowerCase()];
            } else if (brand && /沃尔沃|奔驰|宝马|奥迪|特斯拉|蔚来|理想/i.test(brand)) coeff = 1.3;
            biddingVehicleMap[b.bidding_id] = coeff;
          } catch (_) {}
        }
      }
      const amt = (o) => parseFloat(o.actual_amount || o.quoted_amount) || 0;
      const tierLabel = (tier) => ({ 1: '一级(≤1000元)', 2: '二级(1000-5000元)', 3: '三级(5000-2万)', 4: '四级(>2万)' }[tier] || `第${tier}级`);
      const stagePercent = (stage) => (stage === 'main' ? '100%' : { '1m': '追评补发', '3m': '追评补发' }[stage] || '');
      const contentLevelLabel = (level, contentQuality) => {
        const L = parseInt(level, 10) || 1;
        const names = { 1: '基础', 2: '优质', 3: '标杆', 4: '爆款' };
        const name = contentQuality || names[L] || '';
        return name ? `${L}级 ${name}` : `${L}级`;
      };
      for (const ro of reviewOrders || []) {
        reviewOrderMap[ro.review_id] = ro;
      }
      for (const t of transactions) {
        if ((t.type === 'rebate' || t.type === 'upgrade_diff') && t.related_id && reviewOrderMap[t.related_id]) {
          const ro = reviewOrderMap[t.related_id];
          const tier = t.reward_tier ?? (amt(ro) <= 1000 ? 1 : amt(ro) <= 5000 ? 2 : amt(ro) <= 20000 ? 3 : 4);
          const pct = stagePercent(t.review_stage || 'main');
          const vehicleCoeff = ro.bidding_id ? (biddingVehicleMap[ro.bidding_id] ?? 1) : 1;
          t._reward_breakdown = {
            tier_label: tierLabel(tier),
            stage_label: { main: '主评价', '1m': '1个月追评', '3m': '3个月追评' }[t.review_stage || 'main'] || t.review_stage || '主评价',
            stage_percent: pct,
            content_quality_level: contentLevelLabel(ro.content_quality_level, ro.content_quality),
            complexity_level: (ro.complexity_level || 'L2').toUpperCase(),
            vehicle_coeff: vehicleCoeff,
            amount_before_tax: (parseFloat(t.amount) + parseFloat(t.tax_deducted || 0)).toFixed(2),
            tax_deducted: (parseFloat(t.tax_deducted || 0)).toFixed(2),
            amount_after_tax: parseFloat(t.amount).toFixed(2)
          };
        }
      }
    }

    res.json(successResponse({
      balance,
      total_rebate,
      list: transactions.map(t => ({
        transaction_id: t.transaction_id,
        type: t.type,
        type_label: typeLabels[t.type] || t.type,
        amount: t.amount,
        description: t.description,
        settlement_month: t.settlement_month,
        related_id: t.related_id,
        reward_tier: t.reward_tier,
        review_stage: t.review_stage,
        tax_deducted: t.tax_deducted || 0,
        created_at: t.created_at,
        reward_breakdown: t._reward_breakdown || null
      })),
      total: countResult[0].total,
      page,
      limit
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取余额明细失败', 500));
  }
});

// 申请提现（已开通商家转账时：返回 package_info，小程序调 wx.requestMerchantTransfer 拉起确认收款）
app.post('/api/v1/user/withdraw', authenticateToken, async (req, res) => {
  try {
    const { amount, real_name, id_card_no } = req.body;
    const result = await rewardTransferService.submitUserWithdraw(pool, req.userId, amount, {
      realName: real_name,
      idCardNo: id_card_no,
    });
    if (result.mode === 'legacy') {
      return res.json(successResponse({ withdraw_id: result.withdraw_id, transfer_mode: 'legacy' }, '提现申请已提交'));
    }
    let msg = '请在微信中确认收款';
    if (result.action === 'resume_pending') {
      msg =
        result.warning === 'no_package'
          ? result.hint || '请先取消待确认提现后再发起'
          : '请继续完成上一笔提现的微信确认';
    }
    return res.json(
      successResponse(
        {
          withdraw_id: result.withdraw_id,
          transfer_mode: 'wechat',
          action: result.action,
          amount: result.amount,
          warning: result.warning,
          hint: result.hint,
          package_info: result.package_info,
          mch_id: result.mch_id,
          app_id: result.app_id,
          openid: result.openid,
          state: result.state,
        },
        msg
      )
    );
  } catch (error) {
    if (error.code === 'VALIDATION') {
      return res.status(400).json(errorResponse(error.message));
    }
    if (error.code === 'CONFLICT') {
      return res.status(409).json(errorResponse(error.message, 409));
    }
    const msg = error.message || '提现申请失败';
    const status = error.status && error.status >= 400 && error.status < 500 ? error.status : 500;
    res.status(status).json(errorResponse(msg, status));
  }
});

// 同步待确认提现与微信单据，并返回是否可再次 requestMerchantTransfer
app.post('/api/v1/user/withdraw/reconcile', authenticateToken, async (req, res) => {
  try {
    const { withdraw_id } = req.body || {};
    const out = await rewardTransferService.reconcileUserWithdraw(pool, req.userId, withdraw_id);
    res.json(successResponse(out));
  } catch (error) {
    res.status(500).json(errorResponse(error.message || '同步失败', 500));
  }
});

// 撤销「待用户确认」转账单（用户未确认或无法拉起确认页时），余额退回以终态回调/查询为准
app.post('/api/v1/user/withdraw/cancel-pending', authenticateToken, async (req, res) => {
  try {
    const { withdraw_id } = req.body || {};
    const out = await rewardTransferService.cancelPendingUserWithdraw(pool, req.userId, withdraw_id);
    res.json(successResponse(out));
  } catch (error) {
    if (error.code === 'VALIDATION') {
      return res.status(400).json(errorResponse(error.message));
    }
    res.status(500).json(errorResponse(error.message || '撤销失败', 500));
  }
});

// 获取用户消息列表
app.get('/api/v1/user/messages', authenticateToken, async (req, res) => {
  try {
    const { page, limit, lim, off } = clampPagination(req.query.page, req.query.limit, 10, 50);

    const [list] = await pool.execute(
      `SELECT message_id, type, title, content, related_id, is_read, created_at
       FROM user_messages
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ${lim} OFFSET ${off}`,
      [req.userId]
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
    const { page, limit, lim, off } = clampPagination(req.query.page, req.query.limit, 20, 100);

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
       LIMIT ${lim} OFFSET ${off}`,
      [...params]
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
        analysis_result: row.analysis_result
          ? sanitizeAnalysisResultForRead(
              (() => {
                try {
                  return JSON.parse(row.analysis_result || '{}');
                } catch (_) {
                  return {};
                }
              })()
            )
          : null
      };
    });

    res.json(successResponse({
      list: items,
      total: countRes[0].total,
      page,
      limit
    }));
  } catch (error) {
    console.error('获取用户竞价列表失败:', error);
    res.status(500).json(errorResponse(safeErrorMessage(error, '获取竞价列表失败'), 500));
  }
});

// 用户订单列表
app.get('/api/v1/user/orders', authenticateToken, async (req, res) => {
  try {
    const status = req.query.status; // 0-待接单 1-维修中 2-待确认 3-已完成 4-已取消，to_review-待评价（status=3且未评价）
    const { page, limit, lim, off } = clampPagination(req.query.page, req.query.limit, 20, 100);

    let where = 'WHERE o.user_id = ?';
    const params = [req.userId];
    if (status !== undefined && status !== '' && status !== null) {
      const statusStr = String(status).toLowerCase();
      if (statusStr === 'to_review') {
        // 待评价：status=3 且无主评价
        where += ` AND o.status = 3 AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.order_id = o.order_id AND r.type = 1)`;
      } else if (statusStr === 'completed') {
        // 已完成：已评价(status=3且有主评价) 或 已取消(status=4)
        where += ` AND (o.status = 4 OR (o.status = 3 AND EXISTS (SELECT 1 FROM reviews r WHERE r.order_id = o.order_id AND r.type = 1)))`;
      } else {
        const statusNum = parseInt(status, 10);
        if (!isNaN(statusNum)) {
          where += ' AND o.status = ?';
          params.push(statusNum);
        }
      }
    }

    const [list] = await pool.execute(
      `SELECT o.order_id, o.bidding_id, o.shop_id, o.quoted_amount, o.status, o.created_at,
        o.repair_plan_status,
        s.name as shop_name, s.logo as shop_logo
       FROM orders o
       LEFT JOIN shops s ON o.shop_id = s.shop_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT ${lim} OFFSET ${off}`,
      [...params]
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
        b.vehicle_info, b.report_id, dr.analysis_result, dr.images as damage_report_images,
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
      analysisResult = sanitizeAnalysisResultForRead(
        typeof order.analysis_result === 'string' ? JSON.parse(order.analysis_result || '{}') : (order.analysis_result || {})
      );
    } catch (_) {}

    let damageReportImages = [];
    try {
      const raw = order.damage_report_images;
      const arr =
        typeof raw === 'string' ? JSON.parse(raw || '[]') : Array.isArray(raw) ? raw : [];
      damageReportImages = arr
        .map((u) => {
          if (typeof u === 'string') return u.trim();
          if (u && typeof u.url === 'string') return u.url.trim();
          return '';
        })
        .filter((u) => u.length > 0);
    } catch (_) {
      damageReportImages = [];
    }
    order.damage_report_images = damageReportImages;

    // 拆检费线下支付留痕（车主支付凭证/服务商收据）
    try {
      const [pRows] = await pool.execute(
        `SELECT proof_id, uploader_type, proof_kind, amount, note, image_urls, created_at
         FROM order_offline_fee_proofs
         WHERE order_id = ?
         ORDER BY created_at DESC
         LIMIT 20`,
        [id]
      );
      order.offline_fee_proofs = (pRows || []).map((p) => {
        let imgs = [];
        try {
          imgs = typeof p.image_urls === 'string' ? JSON.parse(p.image_urls || '[]') : (p.image_urls || []);
        } catch (_) {
          imgs = [];
        }
        return {
          proof_id: p.proof_id,
          uploader_type: p.uploader_type,
          proof_kind: p.proof_kind,
          amount: p.amount,
          note: p.note,
          image_urls: Array.isArray(imgs) ? imgs : [],
          created_at: p.created_at
        };
      });
    } catch (e) {
      if (!String((e && e.message) || '').includes('order_offline_fee_proofs')) {
        console.warn('[user/orders] offline fee proofs query error:', e && e.message);
      }
      order.offline_fee_proofs = [];
    }

    // 等待配件延期留痕（服务商上传采购凭证）
    try {
      const [eRows] = await pool.execute(
        `SELECT extension_id, shop_id, note, proof_urls, extend_days, status, created_at
         FROM order_waiting_parts_extensions
         WHERE order_id = ?
         ORDER BY created_at DESC
         LIMIT 20`,
        [id]
      );
      order.waiting_parts_extensions = (eRows || []).map((p) => {
        let imgs = [];
        try {
          imgs = typeof p.proof_urls === 'string' ? JSON.parse(p.proof_urls || '[]') : (p.proof_urls || []);
        } catch (_) {
          imgs = [];
        }
        return {
          extension_id: p.extension_id,
          shop_id: p.shop_id,
          note: p.note,
          extend_days: p.extend_days,
          status: p.status,
          proof_urls: Array.isArray(imgs) ? imgs : [],
          created_at: p.created_at
        };
      });
    } catch (e) {
      if (!String((e && e.message) || '').includes('order_waiting_parts_extensions')) {
        console.warn('[user/orders] waiting parts extensions query error:', e && e.message);
      }
      order.waiting_parts_extensions = [];
    }

    // 车主自救请求留痕（维修商未处理/强制结单）
    try {
      const [sRows] = await pool.execute(
        `SELECT request_id, user_id, request_type, note, image_urls, status, created_at
         FROM order_self_help_requests
         WHERE order_id = ?
         ORDER BY created_at DESC
         LIMIT 20`,
        [id]
      );
      order.self_help_requests = (sRows || []).map((r) => {
        let imgs = [];
        try {
          imgs = typeof r.image_urls === 'string' ? JSON.parse(r.image_urls || '[]') : (r.image_urls || []);
        } catch (_) {
          imgs = [];
        }
        return {
          request_id: r.request_id,
          user_id: r.user_id,
          request_type: r.request_type,
          note: r.note,
          status: r.status,
          image_urls: Array.isArray(imgs) ? imgs : [],
          created_at: r.created_at
        };
      });
    } catch (e) {
      if (!String((e && e.message) || '').includes('order_self_help_requests')) {
        console.warn('[user/orders] self help requests query error:', e && e.message);
      }
      order.self_help_requests = [];
    }

    // 生命周期字段（用于倒计时/解释）
    order.lifecycle_main = order.lifecycle_main || null;
    order.lifecycle_sub = order.lifecycle_sub || null;
    order.lifecycle_started_at = order.lifecycle_started_at || null;
    order.lifecycle_deadline_at = order.lifecycle_deadline_at || null;
    order.promised_delivery_at = order.promised_delivery_at || null;

    let quote = null;
    if (order.quote_id) {
      const [qRows] = await pool.execute(
        'SELECT amount, items, duration, value_added_services FROM quotes WHERE quote_id = ?',
        [order.quote_id]
      );
      if (qRows.length > 0) {
        const q = qRows[0];
        quote = {
          amount: q.amount,
          items: typeof q.items === 'string' ? (q.items ? JSON.parse(q.items) : []) : (q.items || []),
          duration: q.duration,
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
        `SELECT review_id, created_at, rebate_amount, reward_amount, tax_deducted, content_quality, ai_analysis
         FROM reviews WHERE order_id = ? AND type = 1 ORDER BY created_at DESC LIMIT 1`,
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
      if (firstReview.length > 0) {
        const fr = firstReview[0];
        order.first_review_id = fr.review_id;
        order.first_review_rebate_amount = fr.rebate_amount != null ? parseFloat(fr.rebate_amount) : 0;
        order.first_review_reward_amount = fr.reward_amount != null ? parseFloat(fr.reward_amount) : 0;
        order.first_review_tax_deducted = fr.tax_deducted != null ? parseFloat(fr.tax_deducted) : 0;
        order.first_review_content_quality = fr.content_quality != null ? String(fr.content_quality) : null;
        order.first_review_invalid = fr.content_quality === 'invalid';
        order.first_review_pending_human = fr.content_quality === 'pending_human';
        order.first_review_human_feedback = null;
        if (fr.content_quality === 'invalid' && fr.ai_analysis != null && fr.ai_analysis !== '') {
          try {
            const ai =
              typeof fr.ai_analysis === 'string' ? JSON.parse(fr.ai_analysis) : fr.ai_analysis;
            if (ai && ai.human_audit && ai.human_audit.decision === 'reject') {
              const note = String(ai.human_audit.note || '').trim();
              order.first_review_human_feedback = note
                ? `我们已仔细查看了您的评价。结合内容与相关材料，本单暂未符合奖励金发放条件，这不影响您对服务的真实感受。说明供您参考：${note}。您仍可通过追评补充说明，或联系客服，我们很乐意为您解答。`
                : `我们已仔细查看了您的评价。结合内容与相关材料，本单暂未符合奖励金发放条件，这不影响您对服务的真实感受。您可通过追评补充说明，或联系客服，我们很乐意为您解答。`;
            }
          } catch (_) {
            order.first_review_human_feedback = null;
          }
        }
      }
      if (firstReview.length > 0 && followup.length === 0 && returnReview.length === 0) {
        const created = new Date(firstReview[0].created_at);
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        const inWindow = created >= sixMonthsAgo;
        order.can_followup = inWindow;
        order.can_return = inWindow;
      }
    }
    if (order.status !== 3 && order.status !== 4) {
      // 撤单申请旧链路已下线：取消交易不再需要理由，也不存在“提交人工通道”
      order.can_cancel = true;
      order.cancel_needs_reason = false;
      order.cancel_rejected = false;
      order.cancel_request_id = null;
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
    const ins = order.is_insurance_accident === 1 || order.is_insurance_accident === '1';
    const rps = order.repair_payment_status;
    order.can_pay_repair =
      order.status === 3 &&
      !ins &&
      order.commission_status === 'pending_owner_repair_pay' &&
      rps !== 'paid';
    order.repair_pay_amount =
      order.actual_amount != null ? parseFloat(order.actual_amount) : null;
    try {
      if (await orderQuoteProposalService.proposalsTableExists(pool)) {
        order.quote_proposals = await orderQuoteProposalService.listFormatted(pool, id);
      } else {
        order.quote_proposals = [];
      }
    } catch (_) {
      order.quote_proposals = [];
    }
    try {
      if (await repairMilestoneService.milestonesTableExists(pool)) {
        order.repair_milestones = await repairMilestoneService.listForOrder(pool, id);
      } else {
        order.repair_milestones = [];
      }
    } catch (_) {
      order.repair_milestones = [];
    }
    res.json(successResponse(order));
  } catch (error) {
    res.status(500).json(errorResponse('获取订单详情失败', 500));
  }
});

// 电子质保凭证（车主）
app.get('/api/v1/user/orders/:id/warranty-card', authenticateToken, async (req, res) => {
  try {
    const r = await orderWarrantyCardService.getWarrantyCard(pool, req.params.id, { userId: req.userId });
    if (!r.ok) return res.status(r.statusCode || 400).json(errorResponse(r.error));
    res.json(successResponse(r.data));
  } catch (error) {
    console.error('用户电子质保凭证错误:', error);
    res.status(500).json(errorResponse('获取电子质保凭证失败', 500));
  }
});

// 电子质保凭证存证核验（公开，无需登录）
app.post('/api/v1/public/warranty-card/verify', async (req, res) => {
  try {
    const orderId = (req.body && req.body.order_id) != null ? String(req.body.order_id).trim() : '';
    const code =
      (req.body && (req.body.anti_fake_code != null ? req.body.anti_fake_code : req.body.code)) != null
        ? String(req.body.anti_fake_code != null ? req.body.anti_fake_code : req.body.code)
        : '';
    const r = await orderWarrantyCardService.verifyAntiFakeCode(pool, orderId, code);
    if (!r.ok) return res.status(400).json(errorResponse(r.error));
    res.json(successResponse(r.data));
  } catch (error) {
    console.error('电子质保凭证核验错误:', error);
    res.status(500).json(errorResponse('核验失败', 500));
  }
});

// 奖励金预估（按 reward-calculator / docs/体系/03 + 附录 A；历史见 docs/已归档/全指标底层逻辑梳理.md）
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
    const { quoteItems, quotedForCalc } = await rewardCalculator.resolveRepairItemsAndQuotedAmount(pool, order);
    const [shops] = await pool.execute(
      'SELECT compliance_rate, complaint_rate FROM shops WHERE shop_id = ?',
      [order.shop_id]
    );
    const shop = shops.length > 0 ? shops[0] : {};
    const orderForCalc = {
      quoted_amount: quotedForCalc,
      actual_amount: order.actual_amount,
      complexity_level: null,
      order_tier: null,
      is_insurance_accident: order.is_insurance_accident === 1 || order.is_insurance_accident === '1',
    };
    const result = await rewardCalculator.calculateReward(pool, orderForCalc, vehicleInfo, quoteItems, shop);
    const ruleTotalReward = result.reward_pre.toFixed(2);
    let firstReviewInvalid = false;
    let firstReviewCredited = null;
    try {
      const [frRows] = await pool.execute(
        'SELECT rebate_amount, reward_amount, content_quality FROM reviews WHERE order_id = ? AND type = 1 LIMIT 1',
        [id]
      );
      if (frRows.length > 0) {
        const fr = frRows[0];
        firstReviewInvalid = fr.content_quality === 'invalid';
        const credited = parseFloat(fr.rebate_amount ?? fr.reward_amount ?? 0) || 0;
        firstReviewCredited = credited;
      }
    } catch (_) {}
    res.json(successResponse({
      order_id: id,
      order_tier: result.order_tier,
      complexity_level: result.complexity_level,
      vehicle_price_tier: result.vehicle_price_tier,
      /** 规则下基础预估（未扣有效评价门槛；已评价后仍可用于对照） */
      total_reward: ruleTotalReward,
      rule_reward_pre: ruleTotalReward,
      first_review_invalid: firstReviewInvalid,
      /** 首评实际入账（rebate_amount≈税后到账；无效评价为 0） */
      first_review_credited:
        firstReviewCredited != null ? Number(firstReviewCredited).toFixed(2) : null,
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
      `SELECT o.*, s.name as shop_name, s.logo as shop_logo, s.address as shop_address, s.district as shop_district
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
          ? 'SELECT items, value_added_services, amount, duration FROM quotes WHERE quote_id = ?'
          : 'SELECT items, value_added_services, amount, duration FROM quotes WHERE bidding_id = ? AND shop_id = ?',
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
          duration: q.duration
        };
      }
    }

    if (order.repair_plan) {
      try {
        repairPlan = typeof order.repair_plan === 'string' ? JSON.parse(order.repair_plan) : order.repair_plan;
      } catch (_) {}
    }

    let preQuotePlan = null;
    let finalQuotePlanSnap = null;
    if (order.pre_quote_snapshot) {
      try {
        preQuotePlan =
          typeof order.pre_quote_snapshot === 'string'
            ? JSON.parse(order.pre_quote_snapshot)
            : order.pre_quote_snapshot;
      } catch (_) {}
    }
    if (order.final_quote_snapshot) {
      try {
        finalQuotePlanSnap =
          typeof order.final_quote_snapshot === 'string'
            ? JSON.parse(order.final_quote_snapshot)
            : order.final_quote_snapshot;
      } catch (_) {}
    }
    const dualStageQuote = !!(preQuotePlan && preQuotePlan.items && preQuotePlan.items.length);

    // 奖励金按 reward-calculator / 体系 03 + 附录 A；此处仅作展示用占位
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
    const merchantPartsVerification = completionEvidence?.parts_verification || null;
    const warrantyPhotos = []
      .concat(completionEvidence?.warranty_card_photos || [], completionEvidence?.warranty_photos || [])
      .flat()
      .filter((u) => u && String(u).trim());

    const trust = await antifraud.getUserTrustLevel(pool, req.userId);
    const levelNames = { 0: '风险受限', 1: '基础注册', 2: '普通可信', 3: '活跃可信', 4: '核心标杆' };

    // 用户有效评价数（老用户适配：≥3 条时评价页详细指引默认收起）
    const [validReviewRows] = await pool.execute(
      'SELECT COUNT(*) as c FROM reviews r JOIN orders o ON r.order_id = o.order_id WHERE r.user_id = ? AND r.type = 1',
      [req.userId]
    );
    const validReviewCount = validReviewRows[0]?.c || 0;

    // 系统核验（6项）：告知费用、额外项目、服务商一致、结算金额、工期、质保
    const quotedNum = parseFloat(order.quoted_amount) || 0;
    const actualNum = parseFloat(order.actual_amount) || 0;
    const orderVerification = {
      informed: !!order.quote_id,
      no_extra_project: true,
      shop_match: true,
      settlement_match: quotedNum <= 0 ? true : (Math.abs(actualNum - quotedNum) / quotedNum <= 0.1),
      on_time: true,
      warranty_informed: false
    };
    const legacyWarrantyOk = (p) =>
      p != null && p.warranty != null && String(p.warranty).trim() !== '' && !Number.isNaN(parseInt(p.warranty, 10));
    if (
      legacyWarrantyOk(quotePlan) ||
      legacyWarrantyOk(repairPlan) ||
      legacyWarrantyOk(preQuotePlan) ||
      legacyWarrantyOk(finalQuotePlanSnap) ||
      quoteImportService.planItemsAllHaveWarrantyMonths(quotePlan) ||
      quoteImportService.planItemsAllHaveWarrantyMonths(repairPlan) ||
      quoteImportService.planItemsAllHaveWarrantyMonths(preQuotePlan) ||
      quoteImportService.planItemsAllHaveWarrantyMonths(finalQuotePlanSnap)
    ) {
      orderVerification.warranty_informed = true;
    }
    const durationDays = repairPlan?.duration ?? quotePlan?.duration ?? 3;
    if (order.accepted_at && order.completed_at && durationDays != null) {
      const accepted = new Date(order.accepted_at);
      const completed = new Date(order.completed_at);
      const promisedEnd = new Date(accepted);
      promisedEnd.setDate(promisedEnd.getDate() + Number(durationDays));
      orderVerification.on_time = completed <= new Date(promisedEnd.getTime() + 86400000);
    }
    const allVerified = Object.values(orderVerification).every(Boolean);

    let quoteProposalHistory = [];
    try {
      if (await orderQuoteProposalService.proposalsTableExists(pool)) {
        quoteProposalHistory = await orderQuoteProposalService.listFormatted(pool, id);
      }
    } catch (_) {
      quoteProposalHistory = [];
    }

    const prePlanForPublic =
      quoteProposalPublic.planHasDisplayablePreQuote(preQuotePlan) ? preQuotePlan : quotePlan;
    quoteProposalHistory = quoteProposalPublic.prependPreQuoteProposalToList(
      quoteProposalHistory,
      prePlanForPublic,
      order.accepted_at
    );

    let biddingQuotesTotal = null;
    if (order.bidding_id) {
      try {
        const [bc] = await pool.execute('SELECT COUNT(*) as c FROM quotes WHERE bidding_id = ?', [order.bidding_id]);
        biddingQuotesTotal = bc.length ? parseInt(bc[0].c, 10) : 0;
      } catch (_) {
        biddingQuotesTotal = null;
      }
    }

    const quote_timeline = buildQuoteTimelineForReview({
      order,
      quotePlan,
      repairPlan,
      preQuotePlan,
      finalQuotePlanSnap,
      proposalHistoryFormatted: quoteProposalHistory,
      biddingQuotesTotal,
    });

    let repair_milestone_trace = { count: 0, items: [] };
    try {
      const mrows = await repairMilestoneService.listForOrder(pool, id);
      repair_milestone_trace = {
        count: mrows.length,
        items: mrows.map((r) => {
          const mainArr = Array.isArray(r.photo_urls) ? r.photo_urls : [];
          const partsArr = Array.isArray(r.parts_photo_urls) ? r.parts_photo_urls : [];
          return {
            milestone_id: r.milestone_id,
            milestone_code: r.milestone_code,
            milestone_label: r.milestone_label,
            created_at: r.created_at,
            photo_count: mainArr.length + partsArr.length,
            parts_photo_count: partsArr.length,
            parts_verify_note: r.parts_verify_note != null ? String(r.parts_verify_note) : '',
            /** 评价页「流程透明度」仅展示过程照片，价格变动见「报价透明度」；零配件验真节点在端上归入第4题 */
            photo_urls: mainArr,
            parts_photo_urls: partsArr,
          };
        }),
      };
    } catch (_) {}

    let system_checks_preview = {};
    try {
      const initialChecks = await reviewSystemCheckService.buildInitialSystemChecksForOrder(pool, id);
      system_checks_preview = sanitizeSystemChecksForUserFacing(initialChecks);
    } catch (err) {
      console.warn('[for-review] system_checks_preview:', err.message);
    }

    let lossAssessmentUrls = [];
    if (order.loss_assessment_documents) {
      try {
        const raw =
          typeof order.loss_assessment_documents === 'string'
            ? JSON.parse(order.loss_assessment_documents || '{}')
            : order.loss_assessment_documents;
        if (raw && Array.isArray(raw.urls)) lossAssessmentUrls = raw.urls.filter(Boolean);
      } catch (_) {}
    }

    const evidenceBundle = buildEvidenceSections({
      beforeImages,
      merchantSettlement,
      merchantCompletion,
      merchantMaterials,
      quote_timeline,
      quote_proposal_history: quoteProposalHistory,
      orderVerification,
      order,
      lossAssessmentUrls,
      repairPlan,
      quotePlan,
      warrantyPhotos
    });
    const objective_hints = buildObjectiveHints(order, orderVerification);

    res.json(successResponse({
      order_id: order.order_id,
      bidding_id: order.bidding_id || null,
      is_insurance_accident: isInsuranceOrder(order) ? 1 : 0,
      review_scene: reviewScene(order),
      evidence_sections: evidenceBundle.sections,
      objective_hints,
      needs_verification: trust.needsVerification === true,
      level: trust.level,
      level_name: levelNames[trust.level] || levelNames[0],
      valid_review_count: validReviewCount,
      shop_name: order.shop_name,
      shop_logo: order.shop_logo,
      shop_address: order.shop_address || '',
      shop_district: order.shop_district || '',
      shop_address_line: [order.shop_district, order.shop_address].filter(Boolean).join(' ') || '',
      merchant_parts_verification: merchantPartsVerification,
      quoted_amount: order.quoted_amount,
      accepted_at: order.accepted_at || null,
      before_images: beforeImages,
      repair_items: repairItems,
      rebate_rate: '8%',
      rebate_amount: rebateAmount.toFixed(2),
      merchant_settlement_list: merchantSettlement,
      /** 定损/保险材料图 URL 列表（与 evidence_sections 事故区一致，供评价页报价折叠区展示） */
      loss_assessment_image_urls: lossAssessmentUrls,
      merchant_completion_images: merchantCompletion,
      merchant_material_images: merchantMaterials,
      quote_plan: quotePlan,
      /** 与 quote_plan 相同，语义为「竞价阶段 winning quotes 行」便于前端单独展示 */
      bidding_quote_plan: quotePlan,
      repair_plan: repairPlan,
      pre_quote_plan: preQuotePlan || quotePlan,
      final_quote_plan: finalQuotePlanSnap || repairPlan,
      dual_stage_quote: dualStageQuote,
      order_verification: orderVerification,
      order_verification_all_ok: allVerified,
      quote_proposal_history: quoteProposalHistory,
      quote_timeline,
      /** 维修过程节点留痕（评价页「流程透明度」折叠区） */
      repair_milestone_trace,
      /** 与小程序 utils/quote-nomenclature 对齐，便于端上少硬编码 */
      quote_nomenclature: {
        stage_codes: quoteNomenclature.QUOTE_STAGE_CODES,
        labels: quoteNomenclature.QUOTE_LABELS,
      },
      /** 极简评价 v3 模块1：报价节点 + 外观等（提交前为 pending，无内部结论字段） */
      system_checks_preview,
    }));
  } catch (error) {
    res.status(500).json(errorResponse('获取评价信息失败', 500));
  }
});

// 取消订单（直接撤销或创建撤单申请，按《订单撤单与维修完成流程.md》）
app.post('/api/v1/user/orders/:id/cancel', authenticateToken, async (req, res) => {
  try {
    const result = await orderService.cancelOrder(pool, req.params.id, req.userId);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '已取消交易'));
  } catch (error) {
    res.status(500).json(errorResponse('取消订单失败', 500));
  }
});

// 车主：我已到店（生命周期倒计时推进）
app.post('/api/v1/user/orders/:id/arrived', authenticateToken, async (req, res) => {
  try {
    const result = await orderLifecycleService.ownerMarkArrived(pool, req.params.id, req.userId);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '已记录到店'));
  } catch (e) {
    console.error('owner arrived error:', e);
    res.status(500).json(errorResponse('记录到店失败', 500));
  }
});

// 车主：维修商未处理（最后通牒 24h；到期系统自动取消并触发赔付留痕）
app.post('/api/v1/user/orders/:id/merchant-not-handled', authenticateToken, async (req, res) => {
  try {
    const result = await orderLifecycleService.ownerClaimMerchantNotHandled(pool, req.params.id, req.userId, req.body || {});
    if (!result.success) return res.status(result.statusCode || 400).json(errorResponse(result.error));
    res.json(successResponse(result.data, '已提交催办，将再次提醒维修商尽快处理'));
  } catch (e) {
    console.error('merchant-not-handled error:', e);
    res.status(500).json(errorResponse('提交失败', 500));
  }
});

// 车主：强制结单（上传取车凭证→直接进入待评价）
app.post('/api/v1/user/orders/:id/force-close', authenticateToken, async (req, res) => {
  try {
    const result = await orderLifecycleService.ownerForceCloseOrder(pool, req.params.id, req.userId, req.body || {});
    if (!result.success) return res.status(result.statusCode || 400).json(errorResponse(result.error));
    res.json(successResponse(result.data, '已强制结单，您可进入评价流程'));
  } catch (e) {
    console.error('force-close error:', e);
    res.status(500).json(errorResponse('操作失败', 500));
  }
});

// 车主：拆检费线下支付凭证留痕（图片必填，金额/备注可选）
app.post('/api/v1/user/orders/:id/offline-fee-proof', authenticateToken, async (req, res) => {
  try {
    const { amount, note, image_urls } = req.body || {};
    const urls = Array.isArray(image_urls) ? image_urls.map((u) => String(u || '').trim()).filter(Boolean) : [];
    if (!urls.length) return res.status(400).json(errorResponse('请至少上传 1 张凭证图片'));
    const proofId = 'oofp_' + crypto.randomBytes(12).toString('hex');
    const amt = amount != null && amount !== '' ? parseFloat(amount) : null;
    const noteTrim = note != null ? String(note).trim() : '';
    await pool.execute(
      `INSERT INTO order_offline_fee_proofs
        (proof_id, order_id, uploader_type, uploader_id, proof_kind, amount, note, image_urls)
       VALUES (?, ?, 'user', ?, 'diagnostic_fee_payment', ?, ?, ?)`,
      [proofId, req.params.id, req.userId, Number.isFinite(amt) ? amt : null, noteTrim || null, JSON.stringify(urls)]
    );
    res.json(successResponse({ proof_id: proofId }, '已提交留痕'));
  } catch (e) {
    console.error('offline fee proof error:', e);
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

// 车主确认或拒绝最终报价（锁价）
app.post('/api/v1/user/orders/:id/final-quote/confirm', authenticateToken, async (req, res) => {
  try {
    const approved = req.body && req.body.approved === true;
    const result = await orderService.confirmFinalQuote(pool, req.params.id, req.userId, approved);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    const msg = approved ? '已确认最终报价，价格已锁定' : '已拒绝，服务商可重新提交最终报价';
    res.json(successResponse(result.data, msg));
  } catch (error) {
    res.status(500).json(errorResponse('操作失败', 500));
  }
});

// ===================== 2. 定损相关接口 =====================

// 获取当前用户可用能力列表（Phase1：仅全局开关；后续可扩展 user/shop/tenant entitlement）
app.get('/api/v1/capabilities', authenticateToken, async (req, res) => {
  try {
    const caps = await capabilityService.getEnabledCapabilitiesForSubject(pool, { user_id: req.userId });
    res.json(successResponse({ enabled: caps.enabled, map: caps.map }));
  } catch (error) {
    console.error('获取 capabilities 失败:', error && error.message);
    res.status(500).json(errorResponse('获取能力配置失败', 500));
  }
});

// 能力目录（Catalog v1）：面向端内与第三方发现（公共，但不返回敏感配置）
app.get('/api/v1/public/capabilities/catalog', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const catalogPath = path.join(__dirname, 'capability-catalog.v1.json');
    const raw = fs.readFileSync(catalogPath, 'utf8');
    const json = JSON.parse(raw);
    res.json(successResponse(json));
  } catch (error) {
    console.error('获取 capability catalog 失败:', error && error.message);
    res.status(500).json(errorResponse('获取能力目录失败', 500));
  }
});

// OpenAPI：第三方调用能力发现（需 API Key）
app.get('/api/v1/open/capabilities', authenticateOpenApiKey, async (req, res) => {
  try {
    const caps = await capabilityService.getEnabledCapabilitiesForSubject(pool, {
      api_key_id: req.openApi.api_key_id,
      owner_type: req.openApi.owner_type,
      owner_id: req.openApi.owner_id,
    });
    res.json(successResponse({ enabled: caps.enabled, map: caps.map, api_key_id: req.openApi.api_key_id }));
  } catch (error) {
    console.error('open/capabilities failed:', error && error.message);
    res.status(500).json(errorResponse('获取能力失败', 500));
  }
});

// ===================== 编排接口（v1） =====================

// 场景：生成“分享摘要”闭环（输入 report_id → 输出 share_token）
app.post(
  '/api/v1/orchestrate/damage/report/:id/share',
  authenticateToken,
  requireCapability(CAPABILITIES.DAMAGE_REPORT_SHARE, { message: '报告分享暂未开放' }),
  async (req, res) => {
    try {
      const expiresInSecRaw = req.body && req.body.expires_in_sec;
      const expiresInSec = expiresInSecRaw != null ? parseInt(expiresInSecRaw, 10) : undefined;
      const out = await orchestratorService.runDamageAnalyzeToShareToken({
        pool,
        damageService,
        reportId: req.params.id,
        userId: req.userId,
        expiresInSec,
      });
      if (!out.success) {
        return res.status(out.statusCode || 400).json(errorResponse(out.error));
      }
      res.json(successResponse(out.data));
    } catch (error) {
      console.error('[orchestrate] damage report share:', error && error.message);
      res.status(500).json(errorResponse('编排执行失败', 500));
    }
  }
);

// 获取定损每日剩余次数
app.get(
  '/api/v1/damage/daily-quota',
  authenticateToken,
  requireCapability(CAPABILITIES.DAMAGE_AI_ANALYZE, { message: 'AI 定损暂未开放' }),
  async (req, res) => {
  try {
    const quota = await damageService.getDamageDailyQuota(pool, req.userId);
    res.json(successResponse(quota));
  } catch (error) {
    console.error('获取定损配额失败:', error);
    res.status(500).json(errorResponse('获取配额失败', 500));
  }
  }
);

// AI定损分析
app.post(
  '/api/v1/damage/analyze',
  authenticateToken,
  requireCapability(CAPABILITIES.DAMAGE_AI_ANALYZE, { message: 'AI 定损暂未开放' }),
  async (req, res) => {
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
  }
);

// 创建定损报告（跳过等待：仅收图入库 + 异步分析入队）
app.post(
  '/api/v1/damage/reports/create',
  authenticateToken,
  requireCapability(CAPABILITIES.DAMAGE_AI_ANALYZE, { message: 'AI 定损暂未开放' }),
  async (req, res) => {
  try {
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    const result = await damageService.createReportAndEnqueue(pool, req, baseUrl);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '已提交，后台分析中'));
  } catch (error) {
    console.error('创建定损报告失败:', error);
    res.status(500).json(errorResponse('创建报告失败', 500));
  }
  }
);

// 获取定损报告列表
app.get(
  '/api/v1/damage/reports',
  authenticateToken,
  requireCapability(CAPABILITIES.DAMAGE_REPORT_HISTORY, { message: '定损历史暂未开放' }),
  async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));
    const result = await damageService.listReports(pool, req.userId, page, limit);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取定损报告列表失败:', error);
    res.status(500).json(errorResponse('获取报告列表失败', 500));
  }
  }
);

// 获取定损报告
app.get(
  '/api/v1/damage/report/:id',
  authenticateToken,
  requireCapability(CAPABILITIES.DAMAGE_REPORT_HISTORY, { message: '定损报告暂未开放' }),
  async (req, res) => {
  try {
    const result = await damageService.getReport(pool, req.params.id, req.userId);
    if (!result.success) {
      return res.status(result.statusCode || 404).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取定损报告失败:', req.params.id, error && error.message);
    res.status(500).json(errorResponse('获取报告失败', 500));
  }
  }
);

// （分享/H5/JSSDK 路由已迁入 modules/AccidentAssistant_v1）

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
      `SELECT b.*, dr.analysis_result, dr.status AS analysis_status, dr.analysis_relevance
       FROM biddings b 
       LEFT JOIN damage_reports dr ON b.report_id = dr.report_id 
       WHERE b.bidding_id = ? AND b.user_id = ?`,
      [id, req.userId]
    );

    if (biddings.length === 0) {
      return res.status(404).json(errorResponse('竞价不存在', 404));
    }

    const bidding = biddings[0];

    const [quoteCount] = await pool.execute(
      'SELECT COUNT(*) as count FROM quotes WHERE bidding_id = ?',
      [id]
    );
    const quoteCountVal = quoteCount[0]?.count ?? 0;

    let distRows = [];
    try {
      const [rows] = await pool.execute(
        'SELECT tier FROM bidding_distribution WHERE bidding_id = ?',
        [id]
      );
      distRows = rows || [];
    } catch (distErr) {
      console.warn(
        '[bidding/:id] bidding_distribution 不可用，分发统计已降级为空（本地请执行 migration-20260225-bidding-distribution.sql）:',
        distErr.message
      );
    }
    const tierNum = (r) => Number(r.tier);
    let tier1Count = (distRows || []).filter((r) => tierNum(r) === 1).length;
    let tier2Count = (distRows || []).filter((r) => tierNum(r) === 2).length;
    let tier3Count = (distRows || []).filter((r) => tierNum(r) === 3).length;
    let invited_count = (distRows || []).length;
    // 无 bidding_distribution 行时商户端仍可按距离可见，车主端 invited_count 不能恒为 0（否则误提示「范围内无服务商」）
    if (invited_count === 0 && Number(bidding.status) === 0) {
      try {
        const geo = await biddingService.countShopsGeographicallyEligibleForBidding(pool, id);
        if (geo > 0) {
          invited_count = geo;
          tier1Count = geo;
          tier2Count = 0;
          tier3Count = 0;
        }
      } catch (geoErr) {
        console.warn('[bidding/:id] 地理范围受邀店铺数回退失败:', geoErr.message);
      }
    }
    const tier1EndsAt = bidding.tier1_window_ends_at ? new Date(bidding.tier1_window_ends_at) : null;
    const now = new Date();
    const all_notified = !tier1EndsAt || now >= tier1EndsAt;
    const notified_count = all_notified ? invited_count : tier1Count;

    let vehicleInfoObj = {};
    let insuranceInfoObj = {};
    try {
      vehicleInfoObj = JSON.parse(bidding.vehicle_info || '{}');
    } catch (_) {
      vehicleInfoObj = {};
    }
    try {
      insuranceInfoObj = JSON.parse(bidding.insurance_info || '{}');
    } catch (_) {
      insuranceInfoObj = {};
    }

    res.json(successResponse({
      bidding_id: bidding.bidding_id,
      report_id: bidding.report_id,
      status: bidding.status,
      distribution_status: bidding.distribution_status || null,
      analysis_status: bidding.analysis_status != null ? Number(bidding.analysis_status) : null,
      analysis_relevance: bidding.analysis_relevance || null,
      selected_shop_id: bidding.selected_shop_id || null,
      expire_at: bidding.expire_at,
      tier1_window_ends_at: bidding.tier1_window_ends_at,
      quote_count: quoteCountVal,
      range_km: bidding.range_km,
      invited_count,
      notified_count,
      tier1_count: tier1Count,
      all_notified,
      vehicle_info: vehicleInfoObj,
      insurance_info: insuranceInfoObj,
      analysis_result: (() => {
        let ar = {};
        try {
          ar = JSON.parse(bidding.analysis_result || '{}');
        } catch (_) {}
        const safe = sanitizeAnalysisResultForRead(ar);
        enrichAnalysisResultHumanDisplay(safe);
        return safe;
      })()
    }));
  } catch (error) {
    console.error('获取车主竞价详情错误:', error);
    res.status(500).json(errorResponse(safeErrorMessage(error, '获取竞价详情失败'), 500));
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
      `SELECT q.*, s.name as shop_name, s.logo, s.rating, s.shop_score, s.deviation_rate, s.total_orders, s.created_at as shop_created_at, s.latitude as shop_lat, s.longitude as shop_lng,
              (q.quote_valid_until IS NOT NULL AND q.quote_valid_until <= NOW()) AS quote_past_validity
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
      list = await biddingService.sortQuotesByScoreAsync(pool, id, quotesWithDistance, benchmarkAmount);
    } else if (sort_type === 'price_asc') {
      list = [...quotesWithDistance].sort((a, b) => (parseFloat(a.amount) || 0) - (parseFloat(b.amount) || 0));
    } else if (sort_type === 'rating' || sort_type === 'rating_desc') {
      await shopSortService.ensureShopScores(pool, quotesWithDistance);
      list = [...quotesWithDistance].sort((a, b) => {
        const sa = a.shop_score != null ? parseFloat(a.shop_score) : (a.rating != null ? parseFloat(a.rating) * 20 : 0);
        const sb = b.shop_score != null ? parseFloat(b.shop_score) : (b.rating != null ? parseFloat(b.rating) * 20 : 0);
        return sb - sa;
      });
    } else if (sort_type === 'good_rate' || sort_type === 'bad_rate') {
      list = quotesWithDistance;
    } else if (sort_type === 'distance' && hasLocation) {
      list = [...quotesWithDistance].sort((a, b) => (parseFloat(a.distance) || 999) - (parseFloat(b.distance) || 999));
    } else if (sort_type === 'warranty') {
      list = [...quotesWithDistance].sort((a, b) => {
        let ai;
        let bi;
        try {
          ai = typeof a.items === 'string' ? JSON.parse(a.items || '[]') : (a.items || []);
        } catch (_) {
          ai = [];
        }
        try {
          bi = typeof b.items === 'string' ? JSON.parse(b.items || '[]') : (b.items || []);
        } catch (_) {
          bi = [];
        }
        return quoteImportService.maxWarrantyMonthsFromItems(bi) - quoteImportService.maxWarrantyMonthsFromItems(ai);
      });
    } else {
      list = [...quotesWithDistance].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }

    const shopIds = [...new Set(quotesWithDistance.map(q => q.shop_id).filter(Boolean))];
    let goodRateMap = new Map();
    let badRateMap = new Map();
    let badReviewSummaryMap = new Map();
    if (shopIds.length > 0) {
      try {
        const placeholders = shopIds.map(() => '?').join(',');
        const [rateRows] = await pool.execute(
          `SELECT shop_id, COUNT(*) as total,
            SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) as good_count,
            SUM(CASE WHEN rating <= 2 THEN 1 ELSE 0 END) as bad_count
           FROM reviews WHERE shop_id IN (${placeholders}) AND type = 1 AND status = 1 GROUP BY shop_id`,
          shopIds
        );
        for (const r of rateRows || []) {
          const total = r.total || 0;
          goodRateMap.set(r.shop_id, total > 0 ? Math.round((r.good_count || 0) / total * 100) : null);
          badRateMap.set(r.shop_id, total > 0 ? Math.round((r.bad_count || 0) / total * 100) : null);
        }
        const [badSummaryRows] = await pool.execute(
          `SELECT r.shop_id, r.content FROM reviews r
           INNER JOIN (SELECT shop_id, MAX(created_at) as max_at FROM reviews WHERE shop_id IN (${placeholders}) AND type = 1 AND status = 1 AND rating <= 2 AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) GROUP BY shop_id) t ON r.shop_id = t.shop_id AND r.created_at = t.max_at
           WHERE r.shop_id IN (${placeholders}) AND r.type = 1 AND r.status = 1 AND r.rating <= 2`,
          [...shopIds, ...shopIds]
        );
        for (const r of badSummaryRows || []) {
          const raw = (r.content || '').trim();
          const content = raw.slice(0, 50);
          if (content) badReviewSummaryMap.set(r.shop_id, content + (raw.length > 50 ? '...' : ''));
        }
      } catch (_) {}
    }
    if (sort_type === 'good_rate') {
      list = [...quotesWithDistance].sort((a, b) => (goodRateMap.get(b.shop_id) ?? 0) - (goodRateMap.get(a.shop_id) ?? 0));
    } else if (sort_type === 'bad_rate') {
      list = [...quotesWithDistance].sort((a, b) => (badRateMap.get(a.shop_id) ?? 100) - (badRateMap.get(b.shop_id) ?? 100));
    }

    let vehicleInfoForPreview = {};
    let isInsuranceAccidentPreview = false;
    try {
      const [bidPreview] = await pool.execute(
        'SELECT vehicle_info, insurance_info FROM biddings WHERE bidding_id = ? LIMIT 1',
        [id]
      );
      if (bidPreview.length) {
        try {
          vehicleInfoForPreview =
            typeof bidPreview[0].vehicle_info === 'string'
              ? JSON.parse(bidPreview[0].vehicle_info || '{}')
              : bidPreview[0].vehicle_info || {};
        } catch (_) {
          vehicleInfoForPreview = {};
        }
        try {
          const ins =
            typeof bidPreview[0].insurance_info === 'string'
              ? JSON.parse(bidPreview[0].insurance_info || '{}')
              : bidPreview[0].insurance_info || {};
          if (ins && ins.is_insurance) isInsuranceAccidentPreview = true;
        } catch (_) {}
      }
    } catch (_) {}

    const quoteRewardPreviews = await Promise.all(
      list.map(async (q) => {
        let quoteItems = [];
        try {
          quoteItems = typeof q.items === 'string' ? JSON.parse(q.items || '[]') : q.items || [];
        } catch (_) {
          quoteItems = [];
        }
        const orderForCalc = {
          quoted_amount: q.amount,
          actual_amount: null,
          complexity_level: null,
          order_tier: null,
          is_insurance_accident: isInsuranceAccidentPreview,
        };
        try {
          const result = await rewardCalculator.calculateReward(pool, orderForCalc, vehicleInfoForPreview, quoteItems, {});
          return {
            preview_complexity_level: result.complexity_level,
            preview_reward_pre: result.reward_pre,
            preview_commission_rate: Math.round(result.commission_rate * 10000) / 100,
          };
        } catch (_) {
          return {
            preview_complexity_level: null,
            preview_reward_pre: null,
            preview_commission_rate: null,
          };
        }
      })
    );

    res.json(successResponse({
      reward_preview_disclaimer: '以下为根据当前报价明细的规则预估，选厂或后续方案变更后可能变化',
      list: list.map((q, idx) => {
        const isExpired = !!q.quote_past_validity;
        const pv = quoteRewardPreviews[idx] || {};
        return {
          quote_id: q.quote_id,
          shop_id: q.shop_id,
          shop_name: q.shop_name,
          logo: q.logo,
          rating: q.rating,
          shop_score: q.shop_score,
          deviation_rate: q.deviation_rate,
          total_orders: q.total_orders,
          amount: q.amount,
          items: typeof q.items === 'string' ? JSON.parse(q.items || '[]') : (q.items || []),
          value_added_services: typeof q.value_added_services === 'string' ? JSON.parse(q.value_added_services || '[]') : (q.value_added_services || []),
          duration: q.duration,
          remark: q.remark,
          distance: q.distance != null ? Math.round(q.distance * 10) / 10 : null,
          created_at: q.created_at,
          quote_valid_until: q.quote_valid_until,
          is_expired: isExpired,
          good_rate: goodRateMap.get(q.shop_id),
          recent_bad_review_summary: badReviewSummaryMap.get(q.shop_id),
          preview_complexity_level: pv.preview_complexity_level,
          preview_reward_pre: pv.preview_reward_pre,
          preview_commission_rate: pv.preview_commission_rate,
        };
      }),
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
          `INSERT INTO quotes (quote_id, bidding_id, shop_id, amount, items, value_added_services, duration, warranty, remark, quote_valid_until)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))`,
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

// 官网公开：历史成交参考价（匿名聚合，样本门槛）
app.get('/api/v1/public/historical-fair-price', async (req, res) => {
  try {
    const data = await historicalFairPriceService.lookup(pool, req.query);
    res.json(successResponse(data));
  } catch (error) {
    console.error('historical-fair-price:', error);
    res.status(500).json(errorResponse(safeErrorMessage(error, '查询失败'), 500));
  }
});

// 获取附近维修厂
app.get('/api/v1/shops/nearby', async (req, res) => {
  try {
    const result = await shopService.getNearby(pool, req.query);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取维修厂错误:', error);
    res.status(500).json(errorResponse(safeErrorMessage(error, '获取维修厂列表失败'), 500));
  }
});

// 口碑榜单（价格最透明、师傅最专业）
app.get('/api/v1/shops/rank', async (req, res) => {
  try {
    const result = await shopService.getRank(pool, req.query);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('口碑榜单错误:', error);
    res.status(500).json(errorResponse(safeErrorMessage(error, '获取榜单失败'), 500));
  }
});

// 搜索维修厂（keyword、category、sort、分页）
app.get('/api/v1/shops/search', async (req, res) => {
  try {
    const result = await shopService.search(pool, req.query);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('搜索维修厂错误:', error);
    res.status(500).json(errorResponse(safeErrorMessage(error, '搜索维修厂失败'), 500));
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
app.get('/api/v1/shops/:id/reviews', optionalAuth, async (req, res) => {
  try {
    const query = { ...req.query, currentUserId: req.userId };
    const result = await shopService.getReviews(pool, req.params.id, query);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error || '获取评价失败'));
    }
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取维修厂评价错误:', error);
    res.status(500).json(errorResponse(safeErrorMessage(error, '获取评价失败'), 500));
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
    res.status(500).json(errorResponse(safeErrorMessage(error, '预约提交失败'), 500));
  }
});

// 车主商品直购订单
app.post('/api/v1/user/product-orders', authenticateToken, async (req, res) => {
  try {
    const result = await productOrderService.createOrder(pool, req.userId, req.body);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, '订单已创建'));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '创建订单失败'), 500));
  }
});

app.get('/api/v1/user/product-orders', authenticateToken, async (req, res) => {
  try {
    const data = await productOrderService.listForUser(pool, req.userId, req.query);
    res.json(successResponse(data));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '获取订单列表失败'), 500));
  }
});

app.get('/api/v1/user/product-orders/:id', authenticateToken, async (req, res) => {
  try {
    const row = await productOrderService.getPaidDetailForUser(pool, req.userId, req.params.id);
    if (!row) return res.status(404).json(errorResponse('订单不存在或未支付', 404));
    res.json(successResponse(row));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '获取订单失败'), 500));
  }
});

app.get('/api/v1/user/booking-summary', authenticateToken, async (req, res) => {
  try {
    const data = await userBookingService.bookingSummary(pool, req.userId);
    res.json(successResponse(data));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '查询失败'), 500));
  }
});

app.get('/api/v1/user/booking-options', authenticateToken, async (req, res) => {
  try {
    const data = await userBookingService.bookingOptionsAll(pool, req.userId);
    res.json(successResponse(data));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '查询失败'), 500));
  }
});

app.get('/api/v1/user/shops/:shopId/booking-options', authenticateToken, async (req, res) => {
  try {
    const shopId = (req.params.shopId || '').trim();
    if (!shopId) return res.status(400).json(errorResponse('缺少维修厂', 400));
    const data = await userBookingService.bookingOptionsForShop(pool, req.userId, shopId);
    res.json(successResponse(data));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '查询失败'), 500));
  }
});

app.post('/api/v1/user/product-orders/:id/prepay', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json(errorResponse('请提供微信 code'));
    if (!WX_APPID || !WX_SECRET) return res.status(503).json(errorResponse('未配置微信小程序'));
    const wxRes = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: { appid: WX_APPID, secret: WX_SECRET, js_code: code, grant_type: 'authorization_code' },
    });
    const d = wxRes.data;
    if (d.errcode || !d.openid) return res.status(400).json(errorResponse('微信授权失败'));
    const result = await productOrderService.createPrepay(pool, req.userId, req.params.id, d.openid);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '预支付失败'), 500));
  }
});

app.post('/api/v1/user/orders/:id/repair-prepay', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json(errorResponse('请提供微信 code'));
    if (!WX_APPID || !WX_SECRET) return res.status(503).json(errorResponse('未配置微信小程序'));
    const wxRes = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: { appid: WX_APPID, secret: WX_SECRET, js_code: code, grant_type: 'authorization_code' },
    });
    const d = wxRes.data;
    if (d.errcode || !d.openid) return res.status(400).json(errorResponse('微信授权失败'));
    const result = await repairOrderPaymentService.createRepairOrderPrepay(pool, req.userId, req.params.id, d.openid);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '预支付失败'), 500));
  }
});

app.get('/api/v1/merchant/product-orders', authenticateMerchant, async (req, res) => {
  try {
    const data = await productOrderService.listForMerchant(pool, req.shopId, req.query);
    res.json(successResponse(data));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '获取商品订单失败'), 500));
  }
});

// ===================== 5. 评价相关接口 =====================

// 评价聚合流（全平台评价，按等级+时间排序，支持时间/距离，新鲜度3天不重复）
app.get('/api/v1/reviews/feed', optionalAuth, async (req, res) => {
  try {
    const query = {
      ...req.query,
      currentUserId: req.userId,
      latitude: req.query.latitude,
      longitude: req.query.longitude,
    };
    const result = await reviewFeedService.getReviewFeed(pool, query);
    res.json(successResponse(result.data));
  } catch (error) {
    res.status(500).json(errorResponse(safeErrorMessage(error, '获取评价流失败'), 500));
  }
});

// 记录评价聚合页浏览（新鲜度：3天内不重复展示）
app.post('/api/v1/reviews/:id/viewed', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [exists] = await pool.execute('SELECT 1 FROM reviews WHERE review_id = ?', [id]);
    if (!exists.length) return res.status(404).json(errorResponse('评价不存在', 404));
    const result = await reviewFeedService.recordView(pool, req.userId, id);
    res.json(successResponse(result));
  } catch (err) {
    res.status(500).json(errorResponse(safeErrorMessage(err, '记录失败'), 500));
  }
});

// 提交评价（评价体系：3 模块 1 次提交，支持新格式与旧格式兼容）
app.post('/api/v1/reviews', authenticateToken, async (req, res) => {
  try {
    const result = await reviewService.submitReview(pool, req, { port: PORT });
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, result.message || '评价提交成功'));
  } catch (error) {
    console.error('提交评价错误:', error);
    res.status(500).json(errorResponse(safeErrorMessage(error, '提交评价失败'), 500));
  }
});

// 评价列表行曝光（日去重，表 migration-20260414-review-list-impressions.sql）
app.post('/api/v1/reviews/:id/impression', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [exists] = await pool.execute('SELECT 1 FROM reviews WHERE review_id = ?', [id]);
    if (!exists.length) return res.status(404).json(errorResponse('评价不存在', 404));
    const today = new Date().toISOString().slice(0, 10);
    try {
      await pool.execute(
        `INSERT INTO review_list_impressions (review_id, user_id, impression_date) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE review_id = review_id`,
        [id, req.userId, today]
      );
    } catch (err) {
      if (String(err && err.code) === 'ER_NO_SUCH_TABLE') {
        return res.json(successResponse({ recorded: false, reason: 'table_missing' }));
      }
      throw err;
    }
    res.json(successResponse({ recorded: true }));
  } catch (err) {
    console.error('[reviews/impression]', err);
    res.status(500).json(errorResponse(safeErrorMessage(err, '上报失败'), 500));
  }
});

// 上报有效阅读会话（点赞追加奖金：看到了+有效阅读时长）
app.post('/api/v1/reviews/:id/reading', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { effective_seconds, saw_at } = req.body || {};
    const sec = Math.min(Math.max(0, Math.floor(Number(effective_seconds) || 0)), 180);
    if (sec <= 0) {
      return res.json(successResponse({ added: 0, total: 0 }));
    }
    const [exists] = await pool.execute('SELECT 1 FROM reviews WHERE review_id = ?', [id]);
    if (!exists.length) return res.status(404).json(errorResponse('评价不存在', 404));
    const saw = saw_at ? new Date(saw_at) : new Date();
    const result = await reviewLikeService.reportReadingSession(pool, req.userId, id, sec, saw);
    res.json(successResponse({ added: result.added, total: result.total, capped: !!result.capped }));
  } catch (err) {
    console.error('[reviews/reading]', err);
    res.status(500).json(errorResponse(safeErrorMessage(err, '上报失败'), 500));
  }
});

// 点赞评价（可直接点，后台校验有效阅读≥10秒决定是否纳入奖金）
app.post('/api/v1/reviews/:id/dislike', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await reviewLikeService.dislikeReview(pool, req.userId, id);
    if (!result.success) return res.status(400).json(errorResponse(result.error));
    res.json(successResponse({ dislike_id: result.dislike_id, dislike_count_delta: result.dislike_count_delta }));
  } catch (err) {
    console.error('[reviews/dislike]', err);
    res.status(500).json(errorResponse(safeErrorMessage(err, '操作失败'), 500));
  }
});

app.post('/api/v1/reviews/:id/like', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await reviewLikeService.likeReview(pool, req.userId, id);
    if (!result.success) {
      return res.status(400).json(errorResponse(result.error));
    }
    res.json(successResponse({
      like_id: result.like_id,
      is_valid_for_bonus: result.is_valid_for_bonus,
      message: result.is_valid_for_bonus ? '点赞成功' : '点赞成功（有效阅读不足10秒，不纳入奖金核算）',
    }));
  } catch (err) {
    console.error('[reviews/like]', err);
    res.status(500).json(errorResponse(safeErrorMessage(err, '点赞失败'), 500));
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
    const followup1m = '0';
    const followup3m = '0';

    let engagement = {
      total_effective_read_seconds: 0,
      like_count: parseInt(r.like_count, 10) || 0,
      feed_unique_viewers: 0,
    };
    try {
      const [readRows] = await pool.execute(
        `SELECT COALESCE(SUM(effective_seconds), 0) AS t FROM review_reading_sessions WHERE review_id = ?`,
        [id]
      );
      engagement.total_effective_read_seconds = parseInt(readRows[0]?.t || 0, 10);
    } catch (_) {}
    try {
      const [viewRows] = await pool.execute(
        `SELECT COUNT(*) AS c FROM review_feed_views WHERE review_id = ?`,
        [id]
      );
      engagement.feed_unique_viewers = parseInt(viewRows[0]?.c || 0, 10);
    } catch (_) {}

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
      followup_rebate: followup1m,
      engagement,
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
    const trust = await antifraud.getUserTrustLevel(pool, req.userId);
    if (trust.level === 0) {
      return res.status(403).json(errorResponse('您的账号等级不足，完成实名认证和车辆绑定后可评价', 403));
    }

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
    if (!shouldSkipFollowupTimeCheck()) {
      if (stageVal === '1m' && now < oneMonthAgo) return res.status(400).json(errorResponse('1个月追评尚未到开放时间'));
      if (stageVal === '3m') {
        if (orderTier !== 4) return res.status(400).json(errorResponse('仅四级订单支持3个月追评'));
        if (now < threeMonthsAgo) return res.status(400).json(errorResponse('3个月追评尚未到开放时间'));
      }
    }

    // 追评不再单独发放：主评价已全额发放，追评触发整体重评，若等级升级则差额补发（月度结算）
    const rewardAmount = 0;
    const taxDeducted = 0;
    const userReceives = 0;

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

    res.json(successResponse({
      review_id: followupId,
      reward: { amount: userReceives.toFixed(2), tax_deducted: taxDeducted, stage: stageVal }
    }, '追评提交成功'));

    // 异步：主评价+追评整体重评估，回写主评价 content_quality；人工裁定仅依赖千问未达标链路（见 02 文档）
    const baseUrl = (req.protocol || 'http') + '://' + (req.get?.('host') || `localhost:${PORT}`);
    reviewService
      .recomputeHolisticContentQuality(pool, firstReview.order_id, { baseUrl, port: PORT, triggerFollowupId: followupId })
      .catch(() => {});
  } catch (error) {
    console.error('提交追评错误:', error);
    res.status(500).json(errorResponse('提交追评失败', 500));
  }
});

// 提交返厂评价
app.post('/api/v1/reviews/return', authenticateToken, async (req, res) => {
  try {
    const { order_id, images, content } = req.body;
    const trust = await antifraud.getUserTrustLevel(pool, req.userId);
    if (trust.level === 0) {
      return res.status(403).json(errorResponse('您的账号等级不足，完成实名认证和车辆绑定后可评价', 403));
    }

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

    const orderRewardCapRet = require('./services/order-reward-cap-service');
    if (rebateAmount > 0) {
      const [ordFull] = await pool.execute(
        'SELECT o.order_id, o.quoted_amount, o.actual_amount, o.complexity_level, o.shop_id, o.quote_id, o.is_insurance_accident, o.repair_plan, o.bidding_id FROM orders o WHERE o.order_id = ?',
        [order_id]
      );
      const orderRow = ordFull[0] || order;
      const capped = await orderRewardCapRet.clampPayoutToOrderHardCap(pool, order_id, orderRow, {
        afterTax: rebateAmount,
        taxDeducted: 0,
      });
      rebateAmount = capped.afterTax;
    }
    if (rebateAmount > 0) {
      await pool.execute(
        'UPDATE users SET balance = balance + ?, total_rebate = total_rebate + ? WHERE user_id = ?',
        [rebateAmount, rebateAmount, req.userId]
      );
      const hasSrc = await orderRewardCapRet.hasRewardSourceOrderColumn(pool);
      if (hasSrc) {
        await pool.execute(
          `INSERT INTO transactions (transaction_id, user_id, type, amount, description, related_id, reward_source_order_id, created_at)
           VALUES (?, ?, 'rebate', ?, '返厂评价返点', ?, ?, NOW())`,
          ['TXN' + Date.now(), req.userId, rebateAmount, returnId, order_id]
        );
      } else {
        await pool.execute(
          `INSERT INTO transactions (transaction_id, user_id, type, amount, description, related_id, created_at)
           VALUES (?, ?, 'rebate', ?, '返厂评价返点', ?, NOW())`,
          ['TXN' + Date.now(), req.userId, rebateAmount, returnId]
        );
      }
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

/** 生成可拼进 URL 的相对路径（用 path.relative + 禁止 ..，兼容 Windows 大小写/盘符） */
function safeUploadRelativePath(fileAbsolutePath) {
  const root = path.resolve(uploadsDir);
  const file = path.resolve(fileAbsolutePath);
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('上传文件路径越界');
  }
  return rel.replace(/\\/g, '/');
}

/** 返回给前端的图片访问根（须与小程序当前请求的 API 主机一致，本地联调才不会变成公网 URL） */
function publicBaseUrlForUpload(req) {
  const host = req.get('host') || '';
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim();
  const envForce = /^(1|true|yes)$/i.test(String(process.env.FORCE_UPLOAD_PUBLIC_BASE_URL || '').trim());
  const fromEnv = (process.env.BASE_URL || '').trim().replace(/\/$/, '');

  // 线上若 BASE_URL 与小程序实际请求域名不一致，会导致：
  // 1) 小程序 <image> 域名不在白名单 → 图片无法展示
  // 2) 千问拉图域名不一致/不可达 → 分析结果为空
  // 因此：默认优先使用本次请求 Host（在 nginx 后需带 x-forwarded-proto），除非显式强制用 BASE_URL。
  if (!envForce && host) {
    return `${proto}://${host}`;
  }
  if (fromEnv) return fromEnv;
  return `${proto}://${host || 'localhost:3000'}`;
}

// 图片上传（multipart，需登录）- multer 可选，未安装时返回 503
// 支持常见格式：JPG、PNG、GIF、WebP
const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const MIME_TO_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

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
      let ext = (file.originalname || '').split('.').pop();
      if (!ext || ext.length > 4) ext = MIME_TO_EXT[file.mimetype] || 'jpg';
      cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + '.' + ext);
    }
  });
  const fileFilter = (req, file, cb) => {
    if (!file.mimetype || file.mimetype.startsWith('image/') || ALLOWED_IMAGE_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的图片格式，请使用 JPG、PNG、GIF 或 WebP'));
    }
  };
  uploadMiddleware = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter }).single('image');
} catch (e) {
  console.warn('[upload] multer 未安装，图片上传不可用。请在 api-server 目录执行: npm install multer');
}

app.post('/api/v1/upload/image', authenticateToken, (req, res, next) => {
  if (!uploadMiddleware) {
    return res.status(503).json(errorResponse('图片上传功能暂不可用，请在服务器安装 multer 依赖', 503));
  }
  uploadMiddleware(req, res, (err) => {
    if (err) return res.status(400).json(errorResponse(safeErrorMessage(err, '上传失败')));
    if (!req.file) return res.status(400).json(errorResponse('请选择图片'));
    try {
      const relativePath = safeUploadRelativePath(req.file.path);
      const baseUrl = publicBaseUrlForUpload(req);
      const url = `${baseUrl}/uploads/${relativePath}`;
      console.log(`[upload] ok ${req.reqId || ''} ${url}`);
      res.json(successResponse({ url }, '上传成功'));
    } catch (e) {
      console.error('[upload] 处理失败', req.reqId || '', e && e.message);
      return res.status(500).json(errorResponse(safeErrorMessage(e, '上传处理失败'), 500));
    }
  });
});

// 服务商端图片上传（需 merchant_token）
app.post('/api/v1/merchant/upload/image', authenticateMerchant, (req, res, next) => {
  const rid = req.reqId || '';
  const ct = (req.headers['content-type'] || '').split(';')[0].trim();
  console.log(`[merchant/upload] enter ${rid} shopId=${req.shopId || ''} content-type=${ct || '(none)'}`);
  res.on('finish', () => {
    console.log(`[merchant/upload] finish ${rid} status=${res.statusCode}`);
  });
  if (!uploadMiddleware) {
    return res.status(503).json(errorResponse('图片上传功能暂不可用，请在服务器安装 multer 依赖', 503));
  }
  uploadMiddleware(req, res, (err) => {
    if (err) {
      console.error('[merchant/upload] multer', rid, err && err.message);
      return res.status(400).json(errorResponse(safeErrorMessage(err, '上传失败')));
    }
    if (!req.file) {
      console.warn('[merchant/upload] no file', rid, 'body_keys=', req.body && typeof req.body === 'object' ? Object.keys(req.body) : []);
      return res.status(400).json(errorResponse('请选择图片'));
    }
    try {
      const relativePath = safeUploadRelativePath(req.file.path);
      const baseUrl = publicBaseUrlForUpload(req);
      const url = `${baseUrl}/uploads/${relativePath}`;
      console.log(`[merchant/upload] ok ${rid} ${url}`);
      res.json(successResponse({ url }, '上传成功'));
    } catch (e) {
      console.error('[merchant/upload] 处理失败', rid, e && e.message);
      return res.status(500).json(errorResponse(safeErrorMessage(e, '上传处理失败'), 500));
    }
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
    res.status(500).json(errorResponse(safeErrorMessage(error, '获取服务商列表失败'), 500));
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
app.get('/api/v1/admin/shop-products/pending', authenticateAdmin, async (req, res) => {
  try {
    const result = await shopProductService.listPendingForAdmin(pool, req.query);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取待审核商品错误:', error);
    res.status(500).json(errorResponse('获取待审核商品失败', 500));
  }
});

app.get('/api/v1/admin/shop-income/corp-withdrawals', authenticateAdmin, async (req, res) => {
  try {
    const data = await merchantCorpIncomeWithdrawService.listCorpWithdrawalsForAdmin(pool, req.query);
    res.json(successResponse(data));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '加载失败'), 500));
  }
});

app.post('/api/v1/admin/shop-income/corp-withdrawals/:requestId/complete', authenticateAdmin, async (req, res) => {
  try {
    const r = await merchantCorpIncomeWithdrawService.completeCorpWithdrawByAdmin(
      pool,
      req.params.requestId,
      req.body || {},
      req.adminUserId
    );
    if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
    res.json(successResponse(r.data, '已核销'));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '操作失败'), 500));
  }
});

app.post('/api/v1/admin/shop-income/corp-withdrawals/:requestId/reject', authenticateAdmin, async (req, res) => {
  try {
    const r = await merchantCorpIncomeWithdrawService.rejectCorpWithdrawByAdmin(
      pool,
      req.params.requestId,
      req.body || {},
      req.adminUserId
    );
    if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
    res.json(successResponse(r.data, '已驳回'));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '操作失败'), 500));
  }
});

app.post('/api/v1/admin/shop-products/:productId/audit', authenticateAdmin, async (req, res) => {
  try {
    const result = await shopProductService.audit(pool, req.params.productId, req.body);
    if (!result.success) return res.status(result.statusCode || 400).json(errorResponse(result.error));
    res.json(successResponse(result.data, result.data?.message || '审核完成'));
  } catch (error) {
    console.error('商品审核错误:', error);
    res.status(500).json(errorResponse('商品审核失败', 500));
  }
});

// ===================== 定损AI过滤：人工审核队列 =====================

// 列出待人工审核的定损报告（AI连续失败 3 次后进入）
app.get('/api/v1/admin/damage-analysis/manual-review', authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const [rows] = await pool.execute(
      `SELECT dr.report_id, dr.user_id, dr.images, dr.user_description, dr.analysis_error, dr.analysis_attempts, dr.created_at,
              t.task_id, t.status AS task_status, t.last_error, t.updated_at AS task_updated_at
       FROM damage_reports dr
       LEFT JOIN damage_analysis_tasks t ON t.report_id = dr.report_id
       WHERE dr.status = 4
       ORDER BY dr.created_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    const [cnt] = await pool.execute('SELECT COUNT(*) as c FROM damage_reports WHERE status = 4');
    const list = (rows || []).map((r) => {
      let images = [];
      try { images = typeof r.images === 'string' ? JSON.parse(r.images || '[]') : (r.images || []); } catch (_) {}
      return {
        report_id: r.report_id,
        user_id: r.user_id,
        images,
        user_description: r.user_description || '',
        analysis_attempts: r.analysis_attempts || 0,
        analysis_error: r.analysis_error || r.last_error || '',
        task_id: r.task_id || null,
        task_status: r.task_status || null,
        created_at: r.created_at,
        updated_at: r.task_updated_at || null,
      };
    });
    res.json(successResponse({ list, total: cnt[0]?.c || 0, page, limit }));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '加载失败'), 500));
  }
});

// 人工判定修车相关性（最终决定是否分发）
app.post('/api/v1/admin/damage-analysis/reports/:reportId/decision', authenticateAdmin, async (req, res) => {
  try {
    const reportId = (req.params.reportId || '').trim();
    const relevance = String((req.body || {}).relevance || '').trim().toLowerCase();
    if (!reportId) return res.status(400).json(errorResponse('reportId 无效'));
    if (relevance !== 'relevant' && relevance !== 'irrelevant') {
      return res.status(400).json(errorResponse('relevance 必须为 relevant 或 irrelevant'));
    }

    if (relevance === 'irrelevant') {
      await pool.execute(
        `UPDATE damage_reports
         SET status = 3, analysis_relevance = 'irrelevant', analysis_error = NULL, updated_at = NOW()
         WHERE report_id = ?`,
        [reportId]
      );
      await pool.execute(
        `UPDATE biddings SET distribution_status = 'rejected' WHERE report_id = ? AND status = 0`,
        [reportId]
      );
      await pool.execute(
        `UPDATE damage_analysis_tasks SET status='done', locked_at=NULL, locked_by=NULL, updated_at=NOW()
         WHERE report_id = ? AND status = 'manual_review'`,
        [reportId]
      );
      return res.json(successResponse({ report_id: reportId, relevance }, '已拒绝分发'));
    }

    // relevant：允许分发（即使 analysis_result 为空，复杂度服务也会回退 L2）
    await pool.execute(
      `UPDATE damage_reports
       SET status = 1, analysis_relevance = 'relevant', analysis_error = NULL, updated_at = NOW()
       WHERE report_id = ?`,
      [reportId]
    );
    await pool.execute(
      `UPDATE damage_analysis_tasks SET status='done', locked_at=NULL, locked_by=NULL, updated_at=NOW()
       WHERE report_id = ? AND status = 'manual_review'`,
      [reportId]
    );

    // 触发分发：仅对 pending/manual_review 的竞价执行
    const [bids] = await pool.execute(
      `SELECT bidding_id FROM biddings
       WHERE report_id = ? AND status = 0 AND (distribution_status IS NULL OR distribution_status IN ('pending','manual_review'))`,
      [reportId]
    );
    const biddingIds = (bids || []).map((r) => r.bidding_id).filter(Boolean);
    for (const bid of biddingIds) {
      try {
        await biddingDistribution.runBiddingDistribution(pool, bid);
        await pool.execute('UPDATE biddings SET distribution_status = ? WHERE bidding_id = ?', ['done', bid]);
      } catch (distErr) {
        console.warn('[admin/damage-analysis] distribute failed:', bid, distErr.message);
        await pool.execute('UPDATE biddings SET distribution_status = ? WHERE bidding_id = ?', ['pending', bid]);
      }
    }
    res.json(successResponse({ report_id: reportId, relevance, bidding_ids: biddingIds }, '已通过并触发分发'));
  } catch (e) {
    res.status(500).json(errorResponse(safeErrorMessage(e, '操作失败'), 500));
  }
});

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
    res.status(500).json(errorResponse(safeErrorMessage(error, '获取订单列表失败'), 500));
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
    res.status(500).json(errorResponse(safeErrorMessage(error, '获取订单详情失败'), 500));
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

// 取消交易处置：结案（写入 order_lifecycle_events，供订单详情展示）
app.post('/api/v1/admin/orders/:orderNo/cancel-disposal/close', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.closeCancelDisposal(pool, req);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data, result.message || '已结案'));
  } catch (error) {
    console.error('取消交易处置结案失败:', error);
    res.status(500).json(errorResponse('操作失败', 500));
  }
});

// 竞价分发详情（查看邀请名单、过滤逻辑、梯队划分）
app.get('/api/v1/admin/biddings/:id/distribution', authenticateAdmin, async (req, res) => {
  try {
    const result = await biddingDistribution.getBiddingDistributionDetail(pool, req.params.id);
    if (!result.success) {
      return res.status(404).json(errorResponse(result.error));
    }
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取竞价分发详情失败:', error);
    res.status(500).json(errorResponse(safeErrorMessage(error, '获取失败'), 500));
  }
});

// 统计数据（原 getStatistics）
app.get('/api/v1/admin/statistics', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getStatistics(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取统计数据失败:', error);
    res.status(500).json(errorResponse(safeErrorMessage(error, '获取统计数据失败'), 500));
  }
});

// 结算数据（原 getSettlements）
app.get('/api/v1/admin/settlements', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getSettlements(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取结算数据失败:', error);
    res.status(500).json(errorResponse(safeErrorMessage(error, '获取结算数据失败'), 500));
  }
});

// 投诉列表（原 getComplaints）- 无对应表时返回空
app.get('/api/v1/admin/complaints', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getComplaints(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    res.status(500).json(errorResponse(safeErrorMessage(error, '获取投诉列表失败'), 500));
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

// 人工确认配件不合规（05 文档，投诉/追评复核时调用）
app.post('/api/v1/admin/orders/:orderId/parts-non-compliant', authenticateAdmin, async (req, res) => {
  try {
    const systemViolation = require('./services/system-violation-service');
    const orderId = req.params.orderId;
    const [rows] = await pool.execute(
      'SELECT shop_id FROM orders WHERE order_id = ? AND status = 3',
      [orderId]
    );
    if (!rows.length) {
      return res.status(404).json(errorResponse('订单不存在或未完成', 404));
    }
    await systemViolation.recordPartsNonCompliant(pool, rows[0].shop_id, orderId);
    res.json(successResponse(null, '已记录配件不合规'));
  } catch (error) {
    res.status(500).json(errorResponse(safeErrorMessage(error, '记录失败'), 500));
  }
});

// 系统配置查询（原 queryData system_config）
app.get('/api/v1/admin/config', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getConfig(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    res.status(500).json(errorResponse(safeErrorMessage(error, '获取配置失败'), 500));
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
    res.status(500).json(errorResponse(safeErrorMessage(error, '保存配置失败'), 500));
  }
});

// 规则配置批量保存（RuleConfig 专用）
app.post('/api/v1/admin/config/batch', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.batchConfig(pool, req);
    res.json(successResponse(null, result.message));
  } catch (error) {
    res.status(500).json(errorResponse(safeErrorMessage(error, '保存配置失败'), 500));
  }
});

// 定时任务：补发第二、第三梯队竞价消息（可由系统 cron 或云定时任务调用）
// 方式1：admin 登录后调用；方式2：X-Cron-Secret 与 CRON_SECRET 匹配
app.post('/api/v1/admin/cron/send-delayed-bidding-messages', async (req, res) => {
  let authorized = false;
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret === process.env.CRON_SECRET) authorized = true;
  if (!authorized && req.headers['authorization']) {
    try {
      const token = req.headers['authorization'].replace('Bearer ', '');
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded?.role === 'admin') authorized = true;
    } catch (_) {}
  }
  if (!authorized) {
    return res.status(401).json(errorResponse('需要管理员登录或有效的 X-Cron-Secret'));
  }
  try {
    const sentCount = await biddingDistribution.sendAllDelayedBiddingMessages(pool);
    res.json(successResponse({ sentCount }, `已补发 ${sentCount} 条消息`));
  } catch (error) {
    console.error('[cron] send-delayed-bidding-messages error:', error);
    res.status(500).json(errorResponse('补发失败', 500));
  }
});

// 定时任务：处理逾期未申诉的商户申诉请求 → 写入 shop_violations
app.post('/api/v1/admin/cron/process-overdue-evidence', async (req, res) => {
  let authorized = false;
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret === process.env.CRON_SECRET) authorized = true;
  if (!authorized && req.headers['authorization']) {
    try {
      const token = req.headers['authorization'].replace('Bearer ', '');
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded?.role === 'admin') authorized = true;
    } catch (_) {}
  }
  if (!authorized) {
    return res.status(401).json(errorResponse('需要管理员登录或有效的 X-Cron-Secret'));
  }
  try {
    const { processed } = await merchantEvidenceService.processOverdueEvidenceRequests(pool);
    res.json(successResponse({ processed }, `已处理 ${processed} 条逾期申诉`));
  } catch (error) {
    console.error('[cron] process-overdue-evidence error:', error);
    res.status(500).json(errorResponse('处理失败', 500));
  }
});

// 定时任务：处理待 AI 初审的申诉（status=1，补漏）
app.post('/api/v1/admin/cron/process-pending-appeals', async (req, res) => {
  let authorized = false;
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret === process.env.CRON_SECRET) authorized = true;
  if (!authorized && req.headers['authorization']) {
    try {
      const token = req.headers['authorization'].replace('Bearer ', '');
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded?.role === 'admin') authorized = true;
    } catch (_) {}
  }
  if (!authorized) {
    return res.status(401).json(errorResponse('需要管理员登录或有效的 X-Cron-Secret'));
  }
  try {
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    const { processed } = await merchantEvidenceService.processPendingAppealReviews(pool, baseUrl);
    res.json(successResponse({ processed }, `已处理 ${processed} 条待初审申诉`));
  } catch (error) {
    console.error('[cron] process-pending-appeals error:', error);
    res.status(500).json(errorResponse('处理失败', 500));
  }
});

// 定时任务：月度奖励结算（每月10日，结算上月：评价升级差额、常规点赞追加）
app.post('/api/v1/admin/cron/settle-monthly-rewards', async (req, res) => {
  let authorized = false;
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret === process.env.CRON_SECRET) authorized = true;
  if (!authorized && req.headers['authorization']) {
    try {
      const token = req.headers['authorization'].replace('Bearer ', '');
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded?.role === 'admin') authorized = true;
    } catch (_) {}
  }
  if (!authorized) {
    return res.status(401).json(errorResponse('需要管理员登录或有效的 X-Cron-Secret'));
  }
  try {
    const { month } = req.query || {};
    let settleMonth = month;
    if (!settleMonth) {
      const d = new Date();
      const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      settleMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
    }
    const settlementService = require('./services/settlement-service');
    const result = await settlementService.settleMonth(pool, settleMonth);
    res.json(successResponse({
      month: settleMonth,
      upgradeDiff: result.upgradeDiff,
      likeBonus: result.likeBonus,
      conversionBonus: result.conversionBonus,
      postVerifyBonus: result.postVerifyBonus,
      errors: result.errors,
    }, '月度结算完成'));
  } catch (error) {
    console.error('[cron] settle-monthly-rewards error:', error);
    res.status(500).json(errorResponse('月度结算失败', 500));
  }
});

// 商户申诉人工复核（status=4 待人工复核）
app.get('/api/v1/admin/appeal-reviews', authenticateAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const result = await merchantEvidenceService.listAppealReviewsForAdmin(pool, { page, limit });
    res.json(successResponse(result));
  } catch (error) {
    console.error('获取待复核申诉列表失败:', error);
    res.status(500).json(errorResponse('获取失败', 500));
  }
});
app.post('/api/v1/admin/appeal-reviews/:requestId/resolve', authenticateAdmin, async (req, res) => {
  try {
    const { requestId } = req.params;
    const { approved } = req.body;
    if (typeof approved !== 'boolean') {
      return res.status(400).json(errorResponse('请提供 approved: true/false'));
    }
    const result = await merchantEvidenceService.resolveAppealReview(
      pool, requestId, approved, req.adminUserId || 'admin'
    );
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(null, result.message));
  } catch (error) {
    console.error('人工复核申诉失败:', error);
    res.status(500).json(errorResponse('复核失败', 500));
  }
});

// 维修完成材料：AI 未自动通过 → manual_review，后台人工通过/驳回
app.get('/api/v1/admin/material-audit-tasks', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.listMaterialAuditManualTasks(pool);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取待人工材料审核列表失败:', error);
    res.status(500).json(errorResponse('获取失败', 500));
  }
});
app.post('/api/v1/admin/material-audit-tasks/:taskId/resolve', authenticateAdmin, async (req, res) => {
  try {
    const { taskId } = req.params;
    const result = await adminService.resolveMaterialAuditTask(pool, taskId, req.body || {});
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(null, result.message));
  } catch (error) {
    console.error('材料人工审核处理失败:', error);
    res.status(500).json(errorResponse('处理失败', 500));
  }
});

// 评价 vs 过程 AI 极端冲突：待人工队列
app.get('/api/v1/admin/review-evidence-anomaly-tasks', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.listReviewEvidenceAnomalyTasks(pool);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取评价证据异常单失败:', error);
    res.status(500).json(errorResponse('获取失败', 500));
  }
});
app.post('/api/v1/admin/review-evidence-anomaly-tasks/:taskId/resolve', authenticateAdmin, async (req, res) => {
  try {
    const { taskId } = req.params;
    const result = await adminService.resolveReviewEvidenceAnomalyTask(
      pool,
      taskId,
      req.body || {},
      req.adminUserId || 'admin'
    );
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(null, result.message));
  } catch (error) {
    console.error('评价证据异常单结案失败:', error);
    res.status(500).json(errorResponse('处理失败', 500));
  }
});

// ===================== A10 奖励金规则配置 =====================
// 统一配置接口：读写 reward_rules 表（唯一数据源）
app.get('/api/v1/admin/reward-rules/config', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.getRewardRulesConfig(pool, req);
    res.json(successResponse(result.data));
  } catch (error) {
    console.error('获取奖励金规则配置失败:', error);
    res.status(500).json(errorResponse(error.message || '获取配置失败', 500));
  }
});

app.post('/api/v1/admin/reward-rules/config', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.saveRewardRulesConfig(pool, req);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(null, result.message));
  } catch (error) {
    console.error('保存奖励金规则配置失败:', error);
    res.status(500).json(errorResponse(error.message || '保存失败', 500));
  }
});

app.put('/api/v1/admin/commission-rules', authenticateAdmin, async (req, res) => {
  try {
    const result = await adminService.saveCommissionRulesConfig(pool, req);
    if (!result.success) {
      return res.status(result.statusCode || 400).json(errorResponse(result.error));
    }
    res.json(successResponse(null, result.message));
  } catch (error) {
    console.error('保存佣金规则配置失败:', error);
    res.status(500).json(errorResponse(error.message || '保存失败', 500));
  }
});

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
      res.status(500).json(errorResponse(safeErrorMessage(err, '操作失败'), 500));
    }
  });

  // 将指定店铺加入竞价分发（仅用于 E2E 测试，使新注册服务商可报价）
  app.post('/api/v1/dev/biddings/:id/add-shop', async (req, res) => {
    try {
      const biddingId = req.params.id;
      const { shop_id } = req.body || {};
      if (!shop_id) return res.status(400).json(errorResponse('请提供 shop_id'));
      const [bidding] = await pool.execute('SELECT bidding_id, tier1_window_ends_at FROM biddings WHERE bidding_id = ? AND status = 0', [biddingId]);
      if (bidding.length === 0) return res.status(404).json(errorResponse('竞价不存在或已结束'));
      const [shop] = await pool.execute('SELECT shop_id FROM shops WHERE shop_id = ? AND status = 1', [shop_id]);
      if (shop.length === 0) return res.status(404).json(errorResponse('店铺不存在或未启用'));
      const [existing] = await pool.execute('SELECT 1 FROM bidding_distribution WHERE bidding_id = ? AND shop_id = ?', [biddingId, shop_id]);
      if (existing.length > 0) {
        await pool.execute('UPDATE biddings SET tier1_window_ends_at = NULL WHERE bidding_id = ?', [biddingId]);
        return res.json(successResponse({ added: false, window_expired: true }, '店铺已在邀请名单，优先报价窗口已结束'));
      }
      await pool.execute(
        'INSERT INTO bidding_distribution (bidding_id, shop_id, tier, match_score) VALUES (?, ?, 1, 80)',
        [biddingId, shop_id]
      );
      await pool.execute('UPDATE biddings SET tier1_window_ends_at = NULL WHERE bidding_id = ?', [biddingId]);
      res.json(successResponse({ added: true, shop_id }, '已加入邀请名单'));
    } catch (err) {
      console.error('dev/biddings/add-shop:', err);
      res.status(500).json(errorResponse(safeErrorMessage(err, '操作失败'), 500));
    }
  });

  // 创建定损报告（绕过次数限制，仅用于 E2E 测试）
  app.post('/api/v1/dev/ensure-damage-report', async (req, res) => {
    try {
      const { user_id = 'USER001' } = req.body || {};
      const [users] = await pool.execute('SELECT user_id FROM users WHERE user_id = ?', [user_id]);
      if (users.length === 0) return res.status(404).json(errorResponse(`用户 ${user_id} 不存在`));
      const reportId = 'RPT' + Date.now();
      const mockResult = damageService.getMockAnalysisResult(reportId, { plate_number: '京A12345', brand: '大众', model: '帕萨特' });
      await pool.execute(
        `INSERT INTO damage_reports (report_id, user_id, vehicle_info, images, analysis_result, analysis_relevance, analysis_attempts, analysis_error, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'relevant', 1, NULL, 1, NOW())`,
        [reportId, user_id, JSON.stringify({}), JSON.stringify(['https://example.com/test.jpg']), JSON.stringify(mockResult)]
      );
      res.json(successResponse({ report_id: reportId }, '定损报告已创建'));
    } catch (err) {
      console.error('dev/ensure-damage-report:', err);
      res.status(500).json(errorResponse(safeErrorMessage(err, '操作失败'), 500));
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
      let rebateAmount = quoteAmount * 0.08;
      const orderRewardCapSim = require('./services/order-reward-cap-service');
      const [ordSim] = await pool.execute(
        'SELECT o.order_id, o.quoted_amount, o.actual_amount, o.complexity_level, o.shop_id, o.quote_id, o.is_insurance_accident, o.repair_plan, o.bidding_id FROM orders o WHERE o.order_id = ?',
        [orderId]
      );
      const ordSimRow = ordSim[0];
      if (ordSimRow && rebateAmount > 0) {
        const capped = await orderRewardCapSim.clampPayoutToOrderHardCap(pool, orderId, ordSimRow, {
          afterTax: rebateAmount,
          taxDeducted: 0,
        });
        rebateAmount = capped.afterTax;
      }
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
      const hasSrcSim = await orderRewardCapSim.hasRewardSourceOrderColumn(pool);
      if (hasSrcSim) {
        await pool.execute(
          `INSERT INTO transactions (transaction_id, user_id, type, amount, description, related_id, reward_source_order_id, created_at)
           VALUES (?, ?, 'rebate', ?, '评价返点', ?, ?, NOW())`,
          ['TXN' + Date.now(), user_id, rebateAmount, reviewId, orderId]
        );
      } else {
        await pool.execute(
          `INSERT INTO transactions (transaction_id, user_id, type, amount, description, related_id, created_at)
           VALUES (?, ?, 'rebate', ?, '评价返点', ?, NOW())`,
          ['TXN' + Date.now(), user_id, rebateAmount, reviewId]
        );
      }
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
      res.status(500).json(errorResponse(safeErrorMessage(err, '模拟失败'), 500));
    }
  });

  // 强制完成订单（绕过材料 AI 审核，仅用于 E2E 测试）
  app.post('/api/v1/dev/orders/:id/force-complete', async (req, res) => {
    try {
      const orderId = req.params.id;
      const { completion_evidence } = req.body || {};
      const [orders] = await pool.execute('SELECT order_id, shop_id, status FROM orders WHERE order_id = ?', [orderId]);
      if (orders.length === 0) return res.status(404).json(errorResponse('订单不存在'));
      if (parseInt(orders[0].status, 10) !== 1) return res.status(400).json(errorResponse('订单状态不是维修中，无法完成'));
      const evidence = completion_evidence && typeof completion_evidence === 'object'
        ? JSON.stringify(completion_evidence)
        : JSON.stringify({
            repair_photos: ['https://example.com/repair.jpg'],
            settlement_photos: ['https://example.com/settlement.jpg'],
            material_photos: ['https://example.com/material.jpg'],
          });
      await pool.execute(
        'UPDATE orders SET status = 2, completion_evidence = ?, updated_at = NOW() WHERE order_id = ?',
        [evidence, orderId]
      );
      try {
        await pool.execute(
          "UPDATE material_audit_tasks SET status = 'passed', completed_at = NOW() WHERE order_id = ? AND status IN ('pending','manual_review')",
          [orderId]
        );
      } catch (_) {}
      res.json(successResponse({ order_id: orderId }, '已强制完成'));
    } catch (err) {
      console.error('dev/force-complete:', err);
      res.status(500).json(errorResponse(safeErrorMessage(err, '操作失败'), 500));
    }
  });
}

// ===================== 8. 定时任务接口 =====================

// 关闭过期竞价（已废弃：竞价 2h 过期后不再自动关闭，已报价仍有效，用户可随时接受；仅报价有效期到期后报价才失效）
app.post('/api/v1/cron/closeExpiredBidding', async (req, res) => {
  try {
    res.json(successResponse({ closed_count: 0 }, '竞价过期后不再自动关闭，已报价仍可被用户接受'));
  } catch (error) {
    res.status(500).json(errorResponse('操作失败', 500));
  }
});

// ===================== 错误处理 =====================

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json(errorResponse('服务器内部错误', 500));
});

// 非生产：佣金钱包测试加款（仅本地联调）
if (!isProd) {
  app.post('/api/v1/dev/commission-wallet-credit', async (req, res) => {
    try {
      const { shop_id, amount } = req.body || {};
      const r = await commissionWalletService.devCreditWallet(pool, shop_id, amount);
      if (!r.success) return res.status(r.statusCode || 403).json(errorResponse(r.error));
      res.json(successResponse(r.data));
    } catch (e) {
      res.status(500).json(errorResponse(safeErrorMessage(e, '失败'), 500));
    }
  });
}

// 404处理
app.use((req, res) => {
  res.status(404).json(errorResponse('接口不存在', 404));
});

// ===================== 启动服务 =====================

app.listen(PORT, '0.0.0.0', async () => {
  console.log('🚀 辙见 API 服务器已启动');
  console.log(`📡 监听端口: ${PORT}`);
  console.log(`🔗 健康检查: http://localhost:${PORT}/health`);
  if (!isProd && shouldSkipFollowupTimeCheck()) {
    console.log('ℹ️ 非生产：追评 1 个月/3 个月时间窗校验已关闭（SKIP_FOLLOWUP_TIME_CHECK=0 可恢复）');
  }
  await testDBConnection();
  setInterval(() => {
    commissionWalletService.scanLowBalanceWallets(pool).catch((e) => console.warn('[commission-scan]', e.message));
  }, 24 * 3600 * 1000);
});

module.exports = app;
