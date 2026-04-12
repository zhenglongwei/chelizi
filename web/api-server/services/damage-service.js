/**
 * 定损服务
 * AI 定损分析、报告列表、报告详情
 */

const { sanitizeAnalysisResultForRead } = require('../utils/analysis-result-sanitize');
const { enrichAnalysisResultHumanDisplay } = require('../utils/human-display');

/** 当前不限制每日定损次数；失败不落库，不扣次 */
const UNLIMITED_QUOTA = { remaining: 999999, used: 0, limit: 999999 };

async function getDamageDailyQuota() {
  return { ...UNLIMITED_QUOTA };
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
        damageSummary: '前保险杠钣金修复、喷漆',
        damage_level: '二级',
        total_estimate: [1400, 2100],
      },
    ],
    damages: [
      { part: '前保险杠', type: '凹陷', severity: '中等', area: '15x20cm', material: '钢质', vehicleId: '车辆1' },
    ],
    repair_suggestions: [
      { item: '车辆1-钣金修复', price_range: [800, 1200] },
      { item: '车辆1-喷漆', price_range: [600, 900] },
    ],
    total_estimate: [1400, 2100],
    confidence_score: 0.88,
  };
}

/**
 * AI 定损分析
 */
async function analyzeDamage(pool, req, baseUrl) {
  const { user_id, images, vehicle_info, user_description } = req.body || {};
  const userId = req.userId;
  const vehicleInfo = vehicle_info && typeof vehicle_info === 'object' ? vehicle_info : {};

  if (!images || images.length < 1) {
    return { success: false, error: '请至少上传 1 张事故照片', statusCode: 400 };
  }

  const bodyUserId = user_id && String(user_id).trim();
  if (!bodyUserId || bodyUserId !== userId) {
    return { success: false, error: 'user_id 无效或与登录用户不一致', statusCode: 400 };
  }

  const reportId = 'RPT' + Date.now();
  const { enhanceAnalysisWithKnowledge } = require('../knowledge-base');
  const { analyzeWithQwen } = require('../qwen-analyzer');
  const { applySupplementaryRiskFallback } = require('../utils/supplementary-risk-fallback');
  const apiKey = (process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '').trim();

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

  if (!apiKey) {
    return {
      success: false,
      error: '未配置千问 API Key（请设置 ALIYUN_AI_KEY 或 DASHSCOPE_API_KEY）',
      statusCode: 503,
    };
  }

  const userDescTrim = typeof user_description === 'string' ? user_description.trim() : '';
  let analysisResult;
  try {
    if (absoluteImageUrls[0]) {
      console.log('[damage-service] 调用千问 API 分析', absoluteImageUrls.length, '张，示例 URL:', absoluteImageUrls[0].slice(0, 120));
    }
    analysisResult = await analyzeWithQwen(absoluteImageUrls, vehicleInfo, reportId, apiKey, userDescTrim || undefined);
    console.log('[damage-service] 千问分析完成');
  } catch (err) {
    console.error('[damage-service] 千问 API 失败:', err.message);
    const msg = (err && err.message) ? String(err.message) : 'AI 定损分析失败';
    return {
      success: false,
      error: msg.length > 200 ? msg.slice(0, 200) + '…' : msg,
      statusCode: 502,
    };
  }

  const afterRiskFallback = applySupplementaryRiskFallback(analysisResult, userDescTrim, vehicleInfo);
  const enhanced = enhanceAnalysisWithKnowledge(afterRiskFallback);
  enhanced.report_id = reportId;
  const toStore = sanitizeAnalysisResultForRead(enhanced);
  enrichAnalysisResultHumanDisplay(toStore);

  await pool.execute(
    `INSERT INTO damage_reports (report_id, user_id, vehicle_info, images, user_description, analysis_result, status, created_at) 
     VALUES (?, ?, ?, ?, ?, ?, 1, NOW())`,
    [reportId, userId, JSON.stringify(vehicleInfo), JSON.stringify(images), userDescTrim || null, JSON.stringify(toStore)]
  );

  await recordAiCall(pool, userId, reportId);

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
    `SELECT report_id, vehicle_info, images, analysis_result, status, created_at 
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
    const ar = JSON.parse(r.analysis_result || '{}');
    const vi = JSON.parse(r.vehicle_info || '{}');
    let damageLevel = ar.damage_level || '';
    const damages = ar.damages || [];
    const totalEst = ar.total_estimate || [0, 0];
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
  let analysisParsed = {};
  try {
    analysisParsed = JSON.parse(report.analysis_result || '{}');
  } catch (_) {}
  const analysisSafe = sanitizeAnalysisResultForRead(analysisParsed);
  enrichAnalysisResultHumanDisplay(analysisSafe);
  return {
    success: true,
    data: {
      report_id: report.report_id,
      vehicle_info: JSON.parse(report.vehicle_info || '{}'),
      images: JSON.parse(report.images || '[]'),
      analysis_result: analysisSafe,
      status: report.status,
      created_at: report.created_at,
    },
  };
}

module.exports = {
  analyzeDamage,
  listReports,
  getReport,
  getMockAnalysisResult,
  getDamageDailyQuota,
};
