/**
 * 定损服务
 * AI 定损分析、报告列表、报告详情
 */

const crypto = require('crypto');
const { sanitizeAnalysisResultForRead } = require('../utils/analysis-result-sanitize');
const { enrichAnalysisResultHumanDisplay } = require('../utils/human-display');
const { buildDamageReportDisplayVM } = require('../utils/report-display-vm');
const openapiAuth = require('./openapi-auth-service');

/** 当前不限制每日定损次数；失败不落库，不扣次 */
const UNLIMITED_QUOTA = { remaining: 999999, used: 0, limit: 999999 };

/** MySQL `JSON` 列经 mysql2 读出常为 object；若再 JSON.parse(对象) 会抛错导致接口 500 */
function jsonColumn(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

async function getDamageDailyQuota() {
  return { ...UNLIMITED_QUOTA };
}

function makeTaskId(prefix) {
  return String(prefix || 'T').toUpperCase() + Date.now() + Math.floor(Math.random() * 1000);
}

/** 与 damage_analysis_tasks.queue_priority 一致：数值越大 worker 越优先拉取 */
const DAMAGE_TASK_PRIORITY_INTERACTIVE = 100;
const DAMAGE_TASK_PRIORITY_BACKGROUND = 10;

/**
 * 从创建请求体解析队列优先级（仅允许白名单，防滥用抬权）
 * - 预报价页：`queue_priority: 10` 或 `analysis_queue: "background"`
 * - 独立 AI 报告、OpenAPI、缺省：100
 */
function parseDamageTaskQueuePriority(body) {
  const b = body && typeof body === 'object' ? body : {};
  const tag = String(b.analysis_queue || b.analysisQueue || '').trim().toLowerCase();
  if (tag === 'background' || tag === 'low' || tag === 'prequote') {
    return DAMAGE_TASK_PRIORITY_BACKGROUND;
  }
  const n = parseInt(b.queue_priority ?? b.analysis_queue_priority, 10);
  if (n === DAMAGE_TASK_PRIORITY_BACKGROUND) return DAMAGE_TASK_PRIORITY_BACKGROUND;
  return DAMAGE_TASK_PRIORITY_INTERACTIVE;
}

/**
 * 创建定损报告（pending）并入队异步 AI 分析任务
 */
async function createReportAndEnqueue(pool, req, baseUrl) {
  const { images, vehicle_info, user_description } = req.body || {};
  const queuePriority = parseDamageTaskQueuePriority(req.body);
  const userId = req.userId;
  const vehicleInfo = vehicle_info && typeof vehicle_info === 'object' ? vehicle_info : {};

  const userDescTrim = typeof user_description === 'string' ? user_description.trim() : '';
  const rawArr = Array.isArray(images) ? images : [];
  const cleaned = rawArr.map((u) => String(u || '').trim()).filter(Boolean);
  const hasText = userDescTrim.length >= 4;
  if (cleaned.length < 1 && !hasText) {
    return {
      success: false,
      error: '请至少上传 1 张照片，或填写至少 4 个字的描述（事故外观、故障码、异响等均可）',
      statusCode: 400,
    };
  }
  if (cleaned.length >= 1) {
    const hasFakeHttpTmp = cleaned.some((u) => /^https?:\/\/tmp\//i.test(u) || /^https?:\/\/usr\//i.test(u));
    if (hasFakeHttpTmp) {
      return {
        success: false,
        error: '图片地址无效：检测到小程序本地临时路径（如 http://tmp/），请重新选择照片后再提交（须先上传到服务器成功）',
        statusCode: 400,
      };
    }
  }

  const reportId = 'RPT' + Date.now();
  const taskId = makeTaskId('DAT');

  await pool.execute(
    `INSERT INTO damage_reports (report_id, user_id, vehicle_info, images, user_description, analysis_result, analysis_relevance, analysis_attempts, analysis_error, status, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'unknown', 0, NULL, 0, NOW())`,
    [reportId, userId, JSON.stringify(vehicleInfo), JSON.stringify(cleaned), userDescTrim || null]
  );

  await pool.execute(
    `INSERT INTO damage_analysis_tasks (task_id, report_id, status, queue_priority, attempts, last_error, locked_at, locked_by, created_at)
     VALUES (?, ?, 'queued', ?, 0, NULL, NULL, NULL, NOW())`,
    [taskId, reportId, queuePriority]
  );

  return { success: true, data: { report_id: reportId } };
}

async function recordAiCall(pool, userId, reportId) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await pool.execute(
      'INSERT INTO ai_call_log (user_id, report_id, call_date) VALUES (?, ?, ?)',
      [userId, reportId, today]
    );
  } catch (err) {
    console.error('[damage-service] 记录 AI 调用失败:', err.message);
  }
}

/**
 * 与小程序 `npm run sync:config` 同源：web/.env 的 ZHEJIAN_MINIPROGRAM（server 已加载该 .env）
 * - local：本地调试，定损不调用千问，输出固定结果
 * - cloud：云端，走千问（须公网可拉取的图片 URL）
 */
function normalizeMiniprogramMode() {
  const v = String(process.env.ZHEJIAN_MINIPROGRAM || 'cloud').trim().toLowerCase();
  return v === 'local' ? 'local' : 'cloud';
}

/**
 * 千问多模态从公网拉图；本机/内网 URL 会失败。仅在为 local 且强制真千问时用于预检。
 */
function hostnameLooksNonPublicForQwen(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true;
  if (h.endsWith('.local')) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

function anyImageUrlNotPubliclyFetchableByQwen(urls) {
  for (const raw of urls || []) {
    const u = String(raw || '').trim();
    if (!u) return true;
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
      if (hostnameLooksNonPublicForQwen(parsed.hostname)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * 是否走固定模拟定损（不调用千问）。
 * 主开关：ZHEJIAN_MINIPROGRAM=local；可选 MOCK_AI_DAMAGE_ANALYSIS=1 在 cloud 下也强制模拟。
 */
function shouldUseMockDamageAnalysis() {
  if (/^(1|true|yes)$/i.test(String(process.env.MOCK_AI_DAMAGE_ANALYSIS || '').trim())) {
    return true;
  }
  return normalizeMiniprogramMode() === 'local';
}

function getMockAnalysisResult(reportId, vehicleInfo) {
  const v = vehicleInfo && typeof vehicleInfo === 'object' ? vehicleInfo : {};
  const vid = '车辆1';
  const plate = String(v.plate_number || v.plateNumber || '').trim();
  const brand = String(v.brand || v.brand_name || '').trim() || '本地测试车';
  const model = String(v.model || v.model_name || '').trim() || '模拟车型';
  const color = String(v.color || '').trim();

  const repairSuggestions = [
    {
      vehicle_id: vid,
      damage_part: '前保险杠',
      repair_method: '修',
      item: `${vid}-前保险杠`,
      process_note: '钣金整形后喷漆（本地模拟数据）',
      price_range: [1400, 2100],
    },
  ];
  const damages = [
    {
      part: '前保险杠',
      type: '凹陷',
      severity: '中等',
      area: '约15×20cm',
      material: '钢质',
      vehicleId: vid,
    },
  ];

  return {
    report_id: reportId,
    vehicle_info: [
      {
        vehicleId: vid,
        plate_number: plate,
        brand,
        model,
        color,
        damagedParts: ['前保险杠'],
        damageTypes: ['凹陷'],
        overallSeverity: '中等',
        damageSummary:
          '【本地模拟定损】前保险杠可见凹陷变形，建议钣金修复后喷漆。web/.env 中 ZHEJIAN_MINIPROGRAM=cloud 且配置 Key 时走千问。',
        damage_level: '二级',
        total_estimate: [1400, 2100],
        human_display: {
          obvious_damage: ['前保险杠局部凹陷变形'],
          possible_damage: [],
          repair_advice: ['钣金整形修复', '表面喷漆'],
        },
      },
    ],
    damages,
    repair_suggestions: repairSuggestions,
    total_estimate: [1400, 2100],
    confidence_score: 0.72,
    _analysis_source: 'mock_local',
  };
}

/**
 * AI 定损分析
 */
async function analyzeDamage(pool, req, baseUrl) {
  const { user_id, images, vehicle_info, user_description } = req.body || {};
  const userId = req.userId;
  const vehicleInfo = vehicle_info && typeof vehicle_info === 'object' ? vehicle_info : {};

  const userDescTrimEarly = typeof user_description === 'string' ? user_description.trim() : '';
  const imgList = Array.isArray(images) ? images : [];
  if (imgList.length < 1 && userDescTrimEarly.length < 4) {
    return {
      success: false,
      error: '请至少上传 1 张照片，或填写至少 4 个字的描述',
      statusCode: 400,
    };
  }

  const bodyUserId = user_id && String(user_id).trim();
  if (!bodyUserId || bodyUserId !== userId) {
    return { success: false, error: 'user_id 无效或与登录用户不一致', statusCode: 400 };
  }

  const reportId = 'RPT' + Date.now();
  const { enhanceAnalysisWithKnowledge } = require('../knowledge-base');
  const { analyzeWithQwen } = require('../qwen-analyzer');
  const { applySupplementaryRiskFallback } = require('../utils/supplementary-risk-fallback');

  // 与上传接口一致：BASE_URL + /uploads/ + 日期目录/文件名，勿用 new URL 改写（避免与「公网直链」不一致触发千问 400）
  const absoluteImageUrls = (images || [])
    .map((url) => {
      const u = String(url || '').trim();
      if (!u) return '';
      if (/^https?:\/\//i.test(u)) return u;
      return (baseUrl || '').replace(/\/$/, '') + (u.startsWith('/') ? u : '/' + u);
    })
    .filter(Boolean);

  const hasFakeHttpTmp = absoluteImageUrls.some((u) => /^https?:\/\/tmp\//i.test(u) || /^https?:\/\/usr\//i.test(u));
  if (hasFakeHttpTmp) {
    return {
      success: false,
      error: '图片地址无效：检测到小程序本地临时路径（如 http://tmp/），请重新选择照片后再分析（须先上传到服务器成功）',
      statusCode: 400,
    };
  }

  const forceRealQwen = /^(1|true|yes)$/i.test(String(process.env.FORCE_REAL_QWEN_DAMAGE || '').trim());
  let useMock = shouldUseMockDamageAnalysis();
  if (
    forceRealQwen &&
    absoluteImageUrls.length > 0 &&
    anyImageUrlNotPubliclyFetchableByQwen(absoluteImageUrls)
  ) {
    return {
      success: false,
      error:
        '已开启 FORCE_REAL_QWEN_DAMAGE，但当前图片 URL 为本机或内网地址，千问无法下载。请改为公网 HTTPS 图片直链；本地调试可去掉该变量并保持 ZHEJIAN_MINIPROGRAM=local。',
      statusCode: 400,
    };
  }
  if (forceRealQwen) {
    useMock = false;
  }

  const apiKey = (process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '').trim();

  if (!useMock && !apiKey) {
    return {
      success: false,
      error: '未配置千问 API Key（请设置 ALIYUN_AI_KEY 或 DASHSCOPE_API_KEY）',
      statusCode: 503,
    };
  }

  const userDescTrim = typeof user_description === 'string' ? user_description.trim() : '';
  let analysisResult;
  if (useMock) {
    console.log(
      `[damage-service] 固定模拟定损（未调用千问）。ZHEJIAN_MINIPROGRAM=${normalizeMiniprogramMode()}；cloud 下可设 MOCK_AI_DAMAGE_ANALYSIS=1 强制模拟；local 下要强行走千问须公网图 URL + FORCE_REAL_QWEN_DAMAGE=1 + Key。`
    );
    analysisResult = getMockAnalysisResult(reportId, vehicleInfo);
  } else {
    try {
      if (absoluteImageUrls[0]) {
        console.log(
          '[damage-service] 调用千问 API 分析',
          absoluteImageUrls.length,
          '张，示例 URL:',
          absoluteImageUrls[0].slice(0, 120)
        );
      }
      analysisResult = await analyzeWithQwen(absoluteImageUrls, vehicleInfo, reportId, apiKey, userDescTrim || undefined);
      console.log('[damage-service] 千问分析完成');
    } catch (err) {
      console.error('[damage-service] 千问 API 失败:', err.message);
      const msg = err && err.message ? String(err.message) : 'AI 定损分析失败';
      return {
        success: false,
        error: msg.length > 200 ? msg.slice(0, 200) + '…' : msg,
        statusCode: 502,
      };
    }
  }

  const afterRiskFallback = applySupplementaryRiskFallback(analysisResult, userDescTrim, vehicleInfo);
  const enhanced = enhanceAnalysisWithKnowledge(afterRiskFallback);
  enhanced.report_id = reportId;
  const toStore = sanitizeAnalysisResultForRead(enhanced);
  enrichAnalysisResultHumanDisplay(toStore);
  if (toStore && typeof toStore === 'object' && '_analysis_source' in toStore) {
    delete toStore._analysis_source;
  }

  const repairRelated = typeof enhanced.repair_related === 'boolean' ? enhanced.repair_related : true;
  const relevance = repairRelated ? 'relevant' : 'irrelevant';
  const nextStatus = repairRelated ? 1 : 3;
  const rejectReason =
    !repairRelated
      ? (typeof enhanced.repair_related_reason === 'string' && enhanced.repair_related_reason.trim()
        ? enhanced.repair_related_reason.trim().slice(0, 200)
        : '与车辆维修场景无关')
      : null;
  if (!repairRelated && toStore && typeof toStore === 'object') {
    toStore.repair_related = false;
    if (rejectReason) toStore.repair_related_reason = rejectReason;
  }

  await pool.execute(
    `INSERT INTO damage_reports (report_id, user_id, vehicle_info, images, user_description, analysis_result, analysis_relevance, analysis_attempts, analysis_error, status, created_at) 
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, NOW())`,
    [
      reportId,
      userId,
      JSON.stringify(vehicleInfo),
      JSON.stringify(Array.isArray(images) ? images : []),
      userDescTrim || null,
      JSON.stringify(toStore),
      relevance,
      nextStatus,
    ]
  );

  await recordAiCall(pool, userId, reportId);

  if (!repairRelated) {
    return { success: false, error: `内容与修车场景不符：${rejectReason || '请调整后重试'}`, statusCode: 400 };
  }

  return {
    success: true,
    data: {
      ...toStore,
      remainingCount: UNLIMITED_QUOTA.remaining,
      maxCount: UNLIMITED_QUOTA.limit,
    },
  };
}

/**
 * 获取定损报告列表
 */
async function listReports(pool, userId, page = 1, limit = 10) {
  const offset = (page - 1) * limit;
  const [reports] = await pool.execute(
    `SELECT report_id, vehicle_info, images, analysis_result, analysis_relevance, status, created_at 
     FROM damage_reports 
     WHERE user_id = ? 
     ORDER BY created_at DESC 
     LIMIT ? OFFSET ?`,
    [userId, limit, offset]
  );
  const [countRes] = await pool.execute(
    'SELECT COUNT(*) as total FROM damage_reports WHERE user_id = ?',
    [userId]
  );

  const list = reports.map((r) => {
    const ar = jsonColumn(r.analysis_result, {});
    const vi = jsonColumn(r.vehicle_info, {});
    let damageLevel = ar.damage_level || '';
    const damages = ar.damages || [];
    const totalEst = ar.total_estimate || [0, 0];
    if (damageLevel === '三级' && (!damages.length || (totalEst[0] === 0 && totalEst[1] === 0))) {
      damageLevel = '无伤';
    }
    return {
      report_id: r.report_id,
      vehicle_info: vi,
      images: jsonColumn(r.images, []),
      damage_level: damageLevel,
      total_estimate: totalEst,
      status: r.status,
      created_at: r.created_at,
    };
  });

  return { success: true, data: { list, total: countRes[0].total, page, limit } };
}

/**
 * 获取定损报告详情
 */
async function getReport(pool, reportId, userId) {
  const [reports] = await pool.execute(
    'SELECT * FROM damage_reports WHERE report_id = ? AND user_id = ?',
    [reportId, userId]
  );
  if (reports.length === 0) {
    return { success: false, error: '报告不存在', statusCode: 404 };
  }
  const report = reports[0];
  const analysisParsed = jsonColumn(report.analysis_result, {});
  const analysisSafe = sanitizeAnalysisResultForRead(analysisParsed);
  enrichAnalysisResultHumanDisplay(analysisSafe);
  const vehicleInfoMeta = jsonColumn(report.vehicle_info, {});
  const focusVehicleId = vehicleInfoMeta && typeof vehicleInfoMeta === 'object'
    ? String(vehicleInfoMeta.analysis_focus_vehicle_id || '').trim()
    : '';
  const display_vm = buildDamageReportDisplayVM({
    mode: 'miniapp',
    analysis_result: analysisSafe,
    analysis_focus_vehicle_id: focusVehicleId,
  });
  return {
    success: true,
    data: {
      report_id: report.report_id,
      vehicle_info: vehicleInfoMeta,
      images: jsonColumn(report.images, []),
      analysis_result: analysisSafe,
      display_vm,
      status: report.status,
      created_at: report.created_at,
    },
  };
}

// ===================== 分享（公共摘要页） =====================

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function hmacSha256Base64Url(str, secret) {
  const mac = crypto.createHmac('sha256', secret);
  mac.update(String(str || ''));
  return base64UrlEncode(mac.digest());
}

function getShareSecret() {
  return String(process.env.REPORT_SHARE_SECRET || process.env.JWT_SECRET || 'zhejian-share-secret');
}

/**
 * token 结构：reportId.expUnix.sig
 * - expUnix: 秒级到期时间
 * - sig: HMAC_SHA256(reportId.expUnix, secret)
 */
function createDamageReportShareToken(reportId, expiresInSec = 7 * 24 * 3600) {
  const rid = String(reportId || '').trim();
  if (!rid) throw new Error('report_id 无效');
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, parseInt(expiresInSec, 10) || 0);
  const payload = `${rid}.${exp}`;
  const sig = hmacSha256Base64Url(payload, getShareSecret());
  return `${payload}.${sig}`;
}

function verifyDamageReportShareToken(token) {
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 3) return { ok: false, error: 'token 格式无效' };
  const [rid, expRaw, sig] = parts;
  const exp = parseInt(expRaw, 10);
  if (!rid || !exp || !sig) return { ok: false, error: 'token 格式无效' };
  if (Math.floor(Date.now() / 1000) > exp) return { ok: false, error: '分享已过期' };
  const payload = `${rid}.${exp}`;
  const expected = hmacSha256Base64Url(payload, getShareSecret());
  if (expected !== sig) return { ok: false, error: 'token 校验失败' };
  return { ok: true, reportId: rid, exp };
}

async function createShareTokenForOwner(pool, reportId, userId, expiresInSec) {
  const [rows] = await pool.execute(
    'SELECT report_id FROM damage_reports WHERE report_id = ? AND user_id = ? LIMIT 1',
    [reportId, userId]
  );
  if (!rows.length) {
    return { success: false, error: '报告不存在', statusCode: 404 };
  }
  const token = createDamageReportShareToken(reportId, expiresInSec);
  return { success: true, data: { token, expires_in_sec: expiresInSec || 7 * 24 * 3600 } };
}

async function getSharedReportByToken(pool, token) {
  const v = verifyDamageReportShareToken(token);
  if (!v.ok) {
    return { success: false, error: v.error, statusCode: 400 };
  }
  const [reports] = await pool.execute(
    'SELECT report_id, vehicle_info, analysis_result, status, created_at FROM damage_reports WHERE report_id = ? LIMIT 1',
    [v.reportId]
  );
  if (!reports.length) {
    return { success: false, error: '报告不存在', statusCode: 404 };
  }
  const r = reports[0];
  const analysisParsed = jsonColumn(r.analysis_result, {});
  const analysisSafe = sanitizeAnalysisResultForRead(analysisParsed);
  enrichAnalysisResultHumanDisplay(analysisSafe);
  const vehicleInfoMeta = jsonColumn(r.vehicle_info, {});
  const focusVehicleId = vehicleInfoMeta && typeof vehicleInfoMeta === 'object'
    ? String(vehicleInfoMeta.analysis_focus_vehicle_id || '').trim()
    : '';
  const display_vm = buildDamageReportDisplayVM({
    mode: 'share',
    analysis_result: analysisSafe,
    analysis_focus_vehicle_id: focusVehicleId,
  });
  return {
    success: true,
    data: {
      report_id: r.report_id,
      vehicle_info: vehicleInfoMeta,
      analysis_result: analysisSafe,
      display_vm,
      created_at: r.created_at,
      share_expires_at_unix: v.exp,
    },
  };
}

function makeLeadTokenId(prefix = 'LDT') {
  return String(prefix) + Date.now() + Math.floor(Math.random() * 1000);
}

async function createLeadTokenForReport(pool, reportId, expiresInSec) {
  const tokenId = makeLeadTokenId('LDT');
  const expAt = expiresInSec && expiresInSec > 0
    ? new Date(Date.now() + expiresInSec * 1000)
    : null;
  const rawToken = tokenId + '.' + crypto.randomBytes(18).toString('hex');
  const tokenHash = openapiAuth.sha256Hex(rawToken);

  const hasTable = await openapiAuth.tableExists(pool, 'lead_report_tokens');
  if (!hasTable) {
    return { success: false, error: 'lead_report_tokens 表未迁移', statusCode: 503 };
  }
  await pool.execute(
    `INSERT INTO lead_report_tokens (token_id, token_hash, report_id, status, expires_at, created_at)
     VALUES (?, ?, ?, 1, ?, NOW())`,
    [tokenId, tokenHash, reportId, expAt]
  );
  return { success: true, data: { token: rawToken, token_id: tokenId, expires_in_sec: expiresInSec || 0 } };
}

async function getLeadReportByToken(pool, rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return { success: false, error: 'token 无效', statusCode: 400 };
  const hasTable = await openapiAuth.tableExists(pool, 'lead_report_tokens');
  if (!hasTable) return { success: false, error: '功能暂不可用', statusCode: 503 };
  const tokenHash = openapiAuth.sha256Hex(token);
  const [rows] = await pool.execute(
    `SELECT report_id, status, claimed_user_id, expires_at
     FROM lead_report_tokens WHERE token_hash = ? LIMIT 1`,
    [tokenHash]
  );
  if (!rows.length) return { success: false, error: 'token 不存在', statusCode: 404 };
  const t = rows[0];
  if (t.expires_at && new Date(t.expires_at).getTime() > 0 && Date.now() > new Date(t.expires_at).getTime()) {
    return { success: false, error: 'token 已过期', statusCode: 410 };
  }

  const [reports] = await pool.execute(
    'SELECT report_id, vehicle_info, analysis_result, status, created_at FROM damage_reports WHERE report_id = ? LIMIT 1',
    [t.report_id]
  );
  if (!reports.length) return { success: false, error: '报告不存在', statusCode: 404 };
  const r = reports[0];
  const analysisParsed = jsonColumn(r.analysis_result, {});
  const analysisSafe = sanitizeAnalysisResultForRead(analysisParsed);
  enrichAnalysisResultHumanDisplay(analysisSafe);
  const vehicleInfoMeta = jsonColumn(r.vehicle_info, {});
  const focusVehicleId = vehicleInfoMeta && typeof vehicleInfoMeta === 'object'
    ? String(vehicleInfoMeta.analysis_focus_vehicle_id || '').trim()
    : '';
  const display_vm = buildDamageReportDisplayVM({
    mode: 'share',
    analysis_result: analysisSafe,
    analysis_focus_vehicle_id: focusVehicleId,
  });
  return {
    success: true,
    data: {
      report_id: r.report_id,
      vehicle_info: vehicleInfoMeta,
      analysis_result: analysisSafe,
      display_vm,
      status: r.status,
      created_at: r.created_at,
      lead: {
        token_claimed: String(t.status) === '2' || !!t.claimed_user_id,
        claimed_user_id: t.claimed_user_id || null,
      }
    }
  };
}

async function claimLeadReportToken(pool, rawToken, userId) {
  const token = String(rawToken || '').trim();
  if (!token) return { success: false, error: 'token 无效', statusCode: 400 };
  const hasTable = await openapiAuth.tableExists(pool, 'lead_report_tokens');
  if (!hasTable) return { success: false, error: '功能暂不可用', statusCode: 503 };
  const tokenHash = openapiAuth.sha256Hex(token);

  // 先查，若已被其他用户认领则拒绝；若被自己认领则幂等返回
  const [rows] = await pool.execute(
    `SELECT report_id, status, claimed_user_id, expires_at
     FROM lead_report_tokens WHERE token_hash = ? LIMIT 1`,
    [tokenHash]
  );
  if (!rows.length) return { success: false, error: 'token 不存在', statusCode: 404 };
  const t = rows[0];
  if (t.expires_at && new Date(t.expires_at).getTime() > 0 && Date.now() > new Date(t.expires_at).getTime()) {
    return { success: false, error: 'token 已过期', statusCode: 410 };
  }
  const claimedBy = String(t.claimed_user_id || '').trim();
  if (claimedBy && claimedBy !== userId) {
    return { success: false, error: '该报告已被他人使用，请重新上传照片分析', statusCode: 403 };
  }
  if (claimedBy === userId) {
    return { success: true, data: { report_id: t.report_id, claimed: true } };
  }

  // 原子认领：仅当未认领时更新
  const [upd] = await pool.execute(
    `UPDATE lead_report_tokens
     SET status = 2, claimed_user_id = ?, claimed_at = NOW(), updated_at = NOW()
     WHERE token_hash = ? AND (claimed_user_id IS NULL OR claimed_user_id = '')`,
    [userId, tokenHash]
  );
  if (!upd.affectedRows) {
    return { success: false, error: '该报告已被他人使用，请重新上传照片分析', statusCode: 403 };
  }

  // 认领后，把报告归属到当前 user（转化永远发生在小程序）
  await pool.execute(
    `UPDATE damage_reports SET user_id = ?, updated_at = NOW()
     WHERE report_id = ?`,
    [userId, t.report_id]
  );

  return { success: true, data: { report_id: t.report_id, claimed: true } };
}

module.exports = {
  analyzeDamage,
  createReportAndEnqueue,
  listReports,
  getReport,
  getMockAnalysisResult,
  shouldUseMockDamageAnalysis,
  normalizeMiniprogramMode,
  anyImageUrlNotPubliclyFetchableByQwen,
  getDamageDailyQuota,
  createShareTokenForOwner,
  getSharedReportByToken,
  createDamageReportShareToken,
  verifyDamageReportShareToken,
  createLeadTokenForReport,
  getLeadReportByToken,
  claimLeadReportToken,
};
