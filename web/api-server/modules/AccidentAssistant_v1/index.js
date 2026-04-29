const fs = require('fs');
const path = require('path');

const manifest = require('./manifest.json');
const accidentAssistant = require('../../services/accident-assistant-service');

function escapeTokenForHtml(token) {
  return String(token || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/</g, '')
    .replace(/>/g, '');
}

function registerRoutes(app, ctx) {
  const {
    pool,
    authenticateToken,
    authenticateOpenApiKey,
    requireCapability,
    capabilityService,
    CAPABILITIES,
    damageService,
    wechatJssdkService,
    WX_APPID,
    WX_SECRET,
    successResponse,
    errorResponse,
  } = ctx;

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
    } catch (e) {
      res.status(500).json(errorResponse('能力校验失败', 500));
      return false;
    }
  }

  // 生成定损报告分享 token（车主本人）
  app.post(
    '/api/v1/damage/report/:id/share-token',
    authenticateToken,
    requireCapability(CAPABILITIES.DAMAGE_REPORT_SHARE, { message: '报告分享暂未开放' }),
    async (req, res) => {
      try {
        const expiresInSecRaw = req.body && req.body.expires_in_sec;
        const expiresInSec = expiresInSecRaw != null ? parseInt(expiresInSecRaw, 10) : undefined;
        const result = await damageService.createShareTokenForOwner(pool, req.params.id, req.userId, expiresInSec);
        if (!result.success) {
          return res.status(result.statusCode || 400).json(errorResponse(result.error));
        }
        res.json(successResponse(result.data));
      } catch (error) {
        console.error('生成分享 token 失败:', error && error.message);
        res.status(500).json(errorResponse('生成分享失败', 500));
      }
    }
  );

  // 公共：通过分享 token 获取定损报告摘要（无须登录）
  app.get('/api/v1/public/damage/report/share/:token', async (req, res) => {
    try {
      const enabled = await capabilityService.ensureCapability(pool, CAPABILITIES.DAMAGE_REPORT_SHARE);
      if (!enabled) {
        return res.status(403).json(errorResponse('报告分享暂未开放', 403));
      }
      const result = await damageService.getSharedReportByToken(pool, req.params.token);
      if (!result.success) {
        return res.status(result.statusCode || 400).json(errorResponse(result.error));
      }
      res.json(successResponse(result.data));
    } catch (error) {
      console.error('获取分享报告失败:', error && error.message);
      res.status(500).json(errorResponse('获取分享报告失败', 500));
    }
  });

  // Lead：外部引流 token 获取报告摘要（无须登录）
  app.get('/api/v1/public/lead/damage/report/:token', async (req, res) => {
    try {
      const enabled = await capabilityService.ensureCapability(pool, CAPABILITIES.DAMAGE_REPORT_SHARE);
      if (!enabled) return res.status(403).json(errorResponse('报告分享暂未开放', 403));
      const result = await damageService.getLeadReportByToken(pool, req.params.token);
      if (!result.success) return res.status(result.statusCode || 400).json(errorResponse(result.error));
      res.json(successResponse(result.data));
    } catch (e) {
      res.status(500).json(errorResponse('获取失败', 500));
    }
  });

  // Lead：车主登录后认领（首次使用）并将报告归属到本人
  app.post('/api/v1/damage/report/claim-by-token', authenticateToken, async (req, res) => {
    try {
      const token = req.body && req.body.token ? String(req.body.token).trim() : '';
      const result = await damageService.claimLeadReportToken(pool, token, req.userId);
      if (!result.success) return res.status(result.statusCode || 400).json(errorResponse(result.error));
      res.json(successResponse(result.data));
    } catch (e) {
      res.status(500).json(errorResponse('认领失败', 500));
    }
  });

  // OpenAPI：外部引流创建（异步分析 + 生成 lead token）
  app.post('/api/v1/open/lead/damage-reports/create', authenticateOpenApiKey, async (req, res) => {
    // lead 创建属于“定损能力”范畴，需开通 damage.ai_analyze
    if (!(await ensureOpenApiCapability(req, res, CAPABILITIES.DAMAGE_AI_ANALYZE))) return;
    try {
      const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
      // 复用 createReportAndEnqueue：它依赖 req.userId，这里用 openApi.owner_id 作为“匿名线索主体ID”（不会用于小程序转化归属）
      const created = await damageService.createReportAndEnqueue(
        pool,
        { body: req.body || {}, userId: String(req.openApi.owner_id || '').trim() || 'lead' },
        baseUrl
      );
      if (!created.success) return res.status(created.statusCode || 400).json(errorResponse(created.error));
      const reportId = created.data.report_id;
      const tokenRes = await damageService.createLeadTokenForReport(pool, reportId, 7 * 24 * 3600);
      if (!tokenRes.success) return res.status(tokenRes.statusCode || 500).json(errorResponse(tokenRes.error, tokenRes.statusCode || 500));
      const token = tokenRes.data.token;
      const landingUrl = (process.env.BASE_URL || '').trim()
        ? String(process.env.BASE_URL).replace(/\/+$/, '') + '/r/' + encodeURIComponent(token)
        : '/r/' + encodeURIComponent(token);
      res.json(successResponse({ report_id: reportId, token, landing_url: landingUrl }));
    } catch (e) {
      res.status(500).json(errorResponse('创建失败', 500));
    }
  });

  // H5 分享落地页：/r/:token （同域直接调用 /api/v1/public/... 获取摘要）
  app.get('/r/:token', async (req, res) => {
    try {
      const token = String(req.params.token || '').trim();
      if (!token) return res.status(404).type('text').send('Not Found');
      const tplPath = path.join(__dirname, '..', '..', 'public-h5', 'report-share.html');
      const tpl = fs.readFileSync(tplPath, 'utf8');
      const safeToken = escapeTokenForHtml(token);
      const appId = process.env.WX_APPID || WX_APPID || '';
      const originalId = String(process.env.WX_ORIGINAL_ID || '').trim();
      const html = tpl
        .replace(/__TOKEN__/g, safeToken)
        .replace(/__WEAPP_APPID__/g, appId)
        .replace(/__WEAPP_ORIGINAL_ID__/g, originalId || 'gh_xxx');
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(html);
    } catch (e) {
      console.error('[h5] /r token:', e && e.message);
      res.status(500).type('text').send('Server error');
    }
  });

  // 微信 JSSDK 配置（公共，用于 H5 落地页开放标签，如 wx-open-launch-weapp）
  app.get('/api/v1/public/wechat/jssdk-config', async (req, res) => {
    try {
      const appId = process.env.WX_APPID || WX_APPID;
      const secret = process.env.WX_SECRET || WX_SECRET;
      if (!appId || !secret) {
        return res.status(503).json(errorResponse('未配置 WX_APPID/WX_SECRET', 503));
      }
      const url = String(req.query.url || '').trim();
      if (!url) return res.status(400).json(errorResponse('缺少 url', 400));
      const cfg = await wechatJssdkService.buildJssdkConfig(appId, secret, url);
      res.json(successResponse(cfg));
    } catch (e) {
      console.error('[wechat-jssdk-config]', e && e.message);
      res.status(500).json(errorResponse('生成签名失败', 500));
    }
  });

  // ============== OpenAPI：事故报告增强能力（P1） ==============
  app.post('/api/v1/open/accident/evidence-checklist', authenticateOpenApiKey, async (req, res) => {
    if (!(await ensureOpenApiCapability(req, res, CAPABILITIES.ACCIDENT_EVIDENCE_CHECKLIST))) return;
    try {
      const ar = (req.body && req.body.analysis_result) || {};
      const out = accidentAssistant.buildEvidenceChecklistFromAnalysis(ar, req.body || {});
      res.json(successResponse(out));
    } catch (e) {
      res.status(500).json(errorResponse('生成补拍清单失败', 500));
    }
  });

  app.post('/api/v1/open/accident/claim-guide', authenticateOpenApiKey, async (req, res) => {
    if (!(await ensureOpenApiCapability(req, res, CAPABILITIES.ACCIDENT_CLAIM_GUIDE))) return;
    try {
      const out = accidentAssistant.buildClaimGuide(req.body || {});
      res.json(successResponse(out));
    } catch (e) {
      res.status(500).json(errorResponse('生成理赔指引失败', 500));
    }
  });

  app.post('/api/v1/open/accident/price-estimate', authenticateOpenApiKey, async (req, res) => {
    if (!(await ensureOpenApiCapability(req, res, CAPABILITIES.ACCIDENT_PRICE_ESTIMATE))) return;
    try {
      const ar = (req.body && req.body.analysis_result) || {};
      const out = accidentAssistant.estimatePriceFromAnalysis(ar, req.body || {});
      res.json(successResponse(out));
    } catch (e) {
      res.status(500).json(errorResponse('生成价格估算失败', 500));
    }
  });
}

module.exports = {
  manifest,
  registerRoutes,
};

