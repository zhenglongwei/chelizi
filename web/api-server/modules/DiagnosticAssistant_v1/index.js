const fs = require('fs');
const path = require('path');
const manifest = require('./manifest.json');
const diagnosticAssistant = require('../../services/diagnostic-assistant-service');

const PUBLIC_WINDOW_MS = 60 * 1000;
const PUBLIC_MAX_REQUESTS = 30;
const publicTrafficCounter = new Map();

function registerRoutes(app, ctx) {
  const {
    pool,
    authenticateOpenApiKey,
    capabilityService,
    CAPABILITIES,
    damageService,
    WX_APPID,
    successResponse,
    errorResponse,
  } = ctx;

  function getClientIp(req) {
    const xff = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
    return xff || req.ip || req.socket && req.socket.remoteAddress || 'unknown';
  }

  function allowPublicTraffic(req) {
    const ip = getClientIp(req);
    const now = Date.now();
    const item = publicTrafficCounter.get(ip);
    if (!item || now - item.startAt > PUBLIC_WINDOW_MS) {
      publicTrafficCounter.set(ip, { startAt: now, count: 1 });
      return true;
    }
    if (item.count >= PUBLIC_MAX_REQUESTS) return false;
    item.count += 1;
    return true;
  }

  async function ensureOpenApiCapability(req, res, capKey) {
    try {
      const caps = await capabilityService.getEnabledCapabilitiesForSubject(pool, {
        api_key_id: req.openApi && req.openApi.api_key_id,
        owner_type: req.openApi && req.openApi.owner_type,
        owner_id: req.openApi && req.openApi.owner_id,
      });
      if (!caps || !caps.map || caps.map[capKey] !== true) {
        res.status(403).json(errorResponse('该能力未开通', 403));
        return false;
      }
      return true;
    } catch (_) {
      res.status(500).json(errorResponse('能力校验失败', 500));
      return false;
    }
  }

  app.post('/api/v1/open/diagnosis/image-analyze', authenticateOpenApiKey, async (req, res) => {
    if (!(await ensureOpenApiCapability(req, res, CAPABILITIES.DIAGNOSIS_IMAGE_ANALYZE))) return;
    try {
      const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
      const payload = req.body || {};
      const userId = String(req.openApi && req.openApi.owner_id ? req.openApi.owner_id : '').trim() || 'openapi';
      const result = await damageService.analyzeDamage(
        pool,
        { body: { ...payload, user_id: userId }, userId },
        baseUrl
      );
      if (!result.success) {
        return res.status(result.statusCode || 400).json(errorResponse(result.error || '分析失败', result.statusCode || 400));
      }
      const analysisResult = result.data && result.data.analysis_result ? result.data.analysis_result : {};
      const out = diagnosticAssistant.fromDamageAnalysis(analysisResult);
      res.json(successResponse(out));
    } catch (e) {
      res.status(500).json(errorResponse('图片诊断失败', 500));
    }
  });

  app.post('/api/v1/open/diagnosis/dtc-interpret', authenticateOpenApiKey, async (req, res) => {
    if (!(await ensureOpenApiCapability(req, res, CAPABILITIES.DIAGNOSIS_DTC_INTERPRET))) return;
    try {
      const out = diagnosticAssistant.interpretDtc(req.body || {});
      res.json(successResponse(out));
    } catch (e) {
      res.status(500).json(errorResponse('故障码诊断失败', 500));
    }
  });

  app.post('/api/v1/open/diagnosis/symptom-analyze', authenticateOpenApiKey, async (req, res) => {
    if (!(await ensureOpenApiCapability(req, res, CAPABILITIES.DIAGNOSIS_SYMPTOM_ANALYZE))) return;
    try {
      const out = diagnosticAssistant.analyzeSymptom(req.body || {});
      res.json(successResponse(out));
    } catch (e) {
      res.status(500).json(errorResponse('症状诊断失败', 500));
    }
  });

  app.post('/api/v1/open/parts/auth/query-by-code', authenticateOpenApiKey, async (req, res) => {
    if (!(await ensureOpenApiCapability(req, res, CAPABILITIES.PARTS_AUTH_QUERY_BY_CODE))) return;
    try {
      const out = await diagnosticAssistant.buildPartsAuthResultWithOfficialCheck({
        ...(req.body || {}),
        part_code: req.body && req.body.part_code,
      });
      res.json(successResponse(out));
    } catch (e) {
      res.status(500).json(errorResponse('编号验真失败', 500));
    }
  });

  app.post('/api/v1/open/parts/auth/query-by-image', authenticateOpenApiKey, async (req, res) => {
    if (!(await ensureOpenApiCapability(req, res, CAPABILITIES.PARTS_AUTH_QUERY_BY_IMAGE))) return;
    try {
      const out = await diagnosticAssistant.buildPartsAuthResultWithOfficialCheck({
        ...(req.body || {}),
        image_urls: req.body && req.body.image_urls,
      });
      res.json(successResponse(out));
    } catch (e) {
      res.status(500).json(errorResponse('图片验真失败', 500));
    }
  });

  app.post('/api/v1/open/parts/auth/fitment-check-by-vin', authenticateOpenApiKey, async (req, res) => {
    if (!(await ensureOpenApiCapability(req, res, CAPABILITIES.PARTS_FITMENT_CHECK_BY_VIN))) return;
    try {
      const out = await diagnosticAssistant.buildPartsAuthResultWithOfficialCheck({
        ...(req.body || {}),
        vin: req.body && req.body.vin,
      });
      res.json(successResponse(out));
    } catch (e) {
      res.status(500).json(errorResponse('VIN适配验真失败', 500));
    }
  });

  app.post('/api/v1/open/parts/auth/risk-scoring', authenticateOpenApiKey, async (req, res) => {
    if (!(await ensureOpenApiCapability(req, res, CAPABILITIES.PARTS_AUTH_RISK_SCORING))) return;
    try {
      const out = diagnosticAssistant.scorePartsAuthRisk(req.body || {});
      res.json(successResponse(out));
    } catch (e) {
      res.status(500).json(errorResponse('验真风险评分失败', 500));
    }
  });

  app.post('/api/v1/open/parts/auth/signing-payload', authenticateOpenApiKey, async (req, res) => {
    if (!(await ensureOpenApiCapability(req, res, CAPABILITIES.PARTS_AUTH_SIGNING_PAYLOAD))) return;
    try {
      const out = diagnosticAssistant.buildCallbackSigningPayload(req.body || {});
      res.json(successResponse(out));
    } catch (e) {
      res.status(500).json(errorResponse('生成签名载荷失败', 500));
    }
  });

  // 公共H5：图片诊断（无需 OpenAPI Key，用于官网/公众号车主入口）
  app.post('/api/v1/public/diagnosis/image-analyze', async (req, res) => {
    if (!allowPublicTraffic(req)) return res.status(429).json(errorResponse('请求过于频繁，请稍后重试', 429));
    try {
      const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
      const payload = req.body || {};
      const userId = `h5_public_${Date.now()}`;
      const result = await damageService.analyzeDamage(
        pool,
        { body: { ...payload, user_id: userId }, userId },
        baseUrl
      );
      if (!result.success) {
        return res.status(result.statusCode || 400).json(errorResponse(result.error || '分析失败', result.statusCode || 400));
      }
      const analysisResult = result.data && result.data.analysis_result ? result.data.analysis_result : {};
      const out = diagnosticAssistant.fromDamageAnalysis(analysisResult);
      res.json(successResponse(out));
    } catch (_) {
      res.status(500).json(errorResponse('图片诊断失败', 500));
    }
  });

  // 公共H5：故障码诊断（无需 OpenAPI Key）
  app.post('/api/v1/public/diagnosis/dtc-interpret', async (req, res) => {
    if (!allowPublicTraffic(req)) return res.status(429).json(errorResponse('请求过于频繁，请稍后重试', 429));
    try {
      const out = diagnosticAssistant.interpretDtc(req.body || {});
      res.json(successResponse(out));
    } catch (_) {
      res.status(500).json(errorResponse('故障码诊断失败', 500));
    }
  });

  // 公共H5：症状诊断（无需 OpenAPI Key）
  app.post('/api/v1/public/diagnosis/symptom-analyze', async (req, res) => {
    if (!allowPublicTraffic(req)) return res.status(429).json(errorResponse('请求过于频繁，请稍后重试', 429));
    try {
      const out = diagnosticAssistant.analyzeSymptom(req.body || {});
      res.json(successResponse(out));
    } catch (_) {
      res.status(500).json(errorResponse('症状诊断失败', 500));
    }
  });

  // 公共H5：配件验真（编号）
  app.post('/api/v1/public/parts/auth/query-by-code', async (req, res) => {
    if (!allowPublicTraffic(req)) return res.status(429).json(errorResponse('请求过于频繁，请稍后重试', 429));
    try {
      const out = await diagnosticAssistant.buildPartsAuthResultWithOfficialCheck({
        ...(req.body || {}),
        part_code: req.body && req.body.part_code,
      });
      res.json(successResponse(out));
    } catch (_) {
      res.status(500).json(errorResponse('编号验真失败', 500));
    }
  });

  // 公共H5：配件验真（图片）
  app.post('/api/v1/public/parts/auth/query-by-image', async (req, res) => {
    if (!allowPublicTraffic(req)) return res.status(429).json(errorResponse('请求过于频繁，请稍后重试', 429));
    try {
      const out = await diagnosticAssistant.buildPartsAuthResultWithOfficialCheck({
        ...(req.body || {}),
        image_urls: req.body && req.body.image_urls,
      });
      res.json(successResponse(out));
    } catch (_) {
      res.status(500).json(errorResponse('图片验真失败', 500));
    }
  });

  // 公共H5：验真风险复算（人工核验回填后）
  app.post('/api/v1/public/parts/auth/risk-scoring', async (req, res) => {
    if (!allowPublicTraffic(req)) return res.status(429).json(errorResponse('请求过于频繁，请稍后重试', 429));
    try {
      const out = diagnosticAssistant.scorePartsAuthRisk(req.body || {});
      res.json(successResponse(out));
    } catch (_) {
      res.status(500).json(errorResponse('验真风险评分失败', 500));
    }
  });

  // 公共H5：生成人工核验复核记录
  app.post('/api/v1/public/parts/auth/manual-check-record', async (req, res) => {
    if (!allowPublicTraffic(req)) return res.status(429).json(errorResponse('请求过于频繁，请稍后重试', 429));
    try {
      const out = diagnosticAssistant.buildManualCheckRecord(req.body || {});
      console.info('[parts-manual-check-record]', JSON.stringify({
        record_id: out.record_id,
        brand: out.brand,
        part_code: out.part_code,
        result_code: out.result_code,
      }));
      res.json(successResponse(out));
    } catch (_) {
      res.status(500).json(errorResponse('生成复核记录失败', 500));
    }
  });

  // 独立H5：配件验真入口（可在官网/公众号网页使用）
  app.get('/h5/parts-auth', async (req, res) => {
    try {
      const tplPath = path.join(__dirname, '..', '..', 'public-h5', 'parts-auth.html');
      const tpl = fs.readFileSync(tplPath, 'utf8');
      const appId = process.env.WX_APPID || WX_APPID || '';
      const originalId = String(process.env.WX_ORIGINAL_ID || '').trim();
      const html = tpl
        .replace(/__WEAPP_APPID__/g, String(appId))
        .replace(/__WEAPP_ORIGINAL_ID__/g, originalId || 'gh_xxx');
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(html);
    } catch (_) {
      res.status(500).type('text').send('Server error');
    }
  });

  // 独立H5：AI 诊断助手入口
  app.get('/h5/diagnosis', async (req, res) => {
    try {
      const tplPath = path.join(__dirname, '..', '..', 'public-h5', 'diagnosis-assistant.html');
      const tpl = fs.readFileSync(tplPath, 'utf8');
      const appId = process.env.WX_APPID || WX_APPID || '';
      const originalId = String(process.env.WX_ORIGINAL_ID || '').trim();
      const html = tpl
        .replace(/__WEAPP_APPID__/g, String(appId))
        .replace(/__WEAPP_ORIGINAL_ID__/g, originalId || 'gh_xxx')
        .replace(/__PAGE_TITLE__/g, 'AI诊断助手 - 故障码/症状快速诊断')
        .replace(/__PAGE_H1__/g, 'AI诊断助手');
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(html);
    } catch (_) {
      res.status(500).type('text').send('Server error');
    }
  });

  // SEO/GEO：故障码落地页（稳定路径）
  app.get('/h5/diagnosis/dtc', async (req, res) => {
    try {
      const tplPath = path.join(__dirname, '..', '..', 'public-h5', 'diagnosis-assistant.html');
      const tpl = fs.readFileSync(tplPath, 'utf8');
      const appId = process.env.WX_APPID || WX_APPID || '';
      const originalId = String(process.env.WX_ORIGINAL_ID || '').trim();
      const html = tpl
        .replace(/__WEAPP_APPID__/g, String(appId))
        .replace(/__WEAPP_ORIGINAL_ID__/g, originalId || 'gh_xxx')
        .replace(/__PAGE_TITLE__/g, '故障码诊断 - DTC 含义/风险/下一步 | AI诊断助手')
        .replace(/__PAGE_H1__/g, '故障码诊断（DTC）');
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(html);
    } catch (_) {
      res.status(500).type('text').send('Server error');
    }
  });

  // SEO/GEO：症状描述落地页（稳定路径）
  app.get('/h5/diagnosis/symptom', async (req, res) => {
    try {
      const tplPath = path.join(__dirname, '..', '..', 'public-h5', 'diagnosis-assistant.html');
      const tpl = fs.readFileSync(tplPath, 'utf8');
      const appId = process.env.WX_APPID || WX_APPID || '';
      const originalId = String(process.env.WX_ORIGINAL_ID || '').trim();
      const html = tpl
        .replace(/__WEAPP_APPID__/g, String(appId))
        .replace(/__WEAPP_ORIGINAL_ID__/g, originalId || 'gh_xxx')
        .replace(/__PAGE_TITLE__/g, '症状诊断 - 一句话描述故障 | AI诊断助手')
        .replace(/__PAGE_H1__/g, '症状诊断');
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(html);
    } catch (_) {
      res.status(500).type('text').send('Server error');
    }
  });

  // 独立H5：工具导航入口（官网/公众号可直接挂载）
  app.get('/h5/tools', async (req, res) => {
    try {
      const tplPath = path.join(__dirname, '..', '..', 'public-h5', 'tools-hub.html');
      const tpl = fs.readFileSync(tplPath, 'utf8');
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(tpl);
    } catch (_) {
      res.status(500).type('text').send('Server error');
    }
  });

  // 公共埋点：H5工具页行为追踪（最小可用，先落服务端日志）
  app.post('/api/v1/public/h5/track', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const source = String(body.source || '').trim();
      const action = String(body.action || '').trim();
      const tool = String(body.tool || '').trim();
      const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
      const ua = String((req.headers && req.headers['user-agent']) || '');
      const referer = String((req.headers && req.headers.referer) || '');
      console.info('[h5-track]', JSON.stringify({ source, action, tool, extra, ua, referer }));
      res.json(successResponse({ ok: true }));
    } catch (_) {
      res.status(500).json(errorResponse('埋点失败', 500));
    }
  });
}

module.exports = {
  manifest,
  registerRoutes,
};

