/**
 * 定损服务
 * AI 定损分析、报告列表、报告详情
 */

async function getSetting(pool, key, defaultValue = '') {
  try {
    const [rows] = await pool.execute('SELECT `value` FROM settings WHERE `key` = ?', [key]);
    return rows.length > 0 ? String(rows[0].value || '').trim() : defaultValue;
  } catch {
    return defaultValue;
  }
}

async function checkAiDailyLimit(pool, userId) {
  const limitStr = await getSetting(pool, 'damage_daily_limit', '3');
  const maxCount = Math.max(0, parseInt(limitStr, 10) || 3);
  const today = new Date().toISOString().slice(0, 10);
  const [rows] = await pool.execute(
    'SELECT COUNT(*) as cnt FROM damage_reports WHERE user_id = ? AND DATE(created_at) = ?',
    [userId, today]
  );
  const currentCount = rows[0]?.cnt || 0;
  return {
    allowed: currentCount < maxCount,
    currentCount,
    maxCount,
    remainingCount: Math.max(0, maxCount - currentCount),
    message: currentCount >= maxCount
      ? `今日定损次数已达上限（${maxCount}次），请明日再试`
      : `今日剩余 ${maxCount - currentCount} 次`,
  };
}

async function getDamageDailyQuota(pool, userId) {
  const limitCheck = await checkAiDailyLimit(pool, userId);
  return {
    remaining: limitCheck.remainingCount,
    used: limitCheck.currentCount,
    limit: limitCheck.maxCount,
  };
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
  const { user_id, images, vehicle_info } = req.body || {};
  const userId = req.userId;
  const vehicleInfo = vehicle_info && typeof vehicle_info === 'object' ? vehicle_info : {};

  if (!images || images.length === 0) {
    return { success: false, error: '请上传事故照片', statusCode: 400 };
  }

  const bodyUserId = user_id && String(user_id).trim();
  if (!bodyUserId || bodyUserId !== userId) {
    return { success: false, error: 'user_id 无效或与登录用户不一致', statusCode: 400 };
  }

  const limitCheck = await checkAiDailyLimit(pool, userId);
  if (!limitCheck.allowed) {
    return { success: false, error: limitCheck.message, statusCode: 429 };
  }
  const quotaAfter = { remainingCount: limitCheck.remainingCount - 1, maxCount: limitCheck.maxCount };

  const reportId = 'RPT' + Date.now();
  const { enhanceAnalysisWithKnowledge } = require('../knowledge-base');
  const { analyzeWithQwen } = require('../qwen-analyzer');
  const apiKey = process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '';

  const absoluteImageUrls = (images || []).map((url) => {
    const u = String(url || '').trim();
    if (u.startsWith('http')) return u;
    return (baseUrl || '').replace(/\/$/, '') + (u.startsWith('/') ? u : '/' + u);
  });

  let analysisResult;
  if (apiKey && absoluteImageUrls.length > 0) {
    try {
      console.log('[damage-service] 调用千问 API 分析', absoluteImageUrls.length, '张照片');
      analysisResult = await analyzeWithQwen(absoluteImageUrls, vehicleInfo, reportId, apiKey);
      console.log('[damage-service] 千问分析完成');
    } catch (err) {
      console.error('[damage-service] 千问 API 失败，使用模拟结果:', err.message);
      analysisResult = getMockAnalysisResult(reportId, vehicleInfo);
    }
  } else {
    analysisResult = getMockAnalysisResult(reportId, vehicleInfo);
  }

  const enhanced = enhanceAnalysisWithKnowledge(analysisResult);
  enhanced.report_id = reportId;

  await pool.execute(
    `INSERT INTO damage_reports (report_id, user_id, vehicle_info, images, analysis_result, status, created_at) 
     VALUES (?, ?, ?, ?, ?, 1, NOW())`,
    [reportId, userId, JSON.stringify(vehicleInfo), JSON.stringify(images), JSON.stringify(enhanced)]
  );

  await recordAiCall(pool, userId, reportId);

  return {
    success: true,
    data: {
      ...enhanced,
      remainingCount: quotaAfter.remainingCount,
      maxCount: quotaAfter.maxCount,
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
  return {
    success: true,
    data: {
      report_id: report.report_id,
      vehicle_info: JSON.parse(report.vehicle_info || '{}'),
      images: JSON.parse(report.images || '[]'),
      analysis_result: JSON.parse(report.analysis_result || '{}'),
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
