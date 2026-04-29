const manifest = require('./manifest.json');

function registerRoutes(app, ctx) {
  const {
    pool,
    authenticateOpenApiKey,
    capabilityService,
    CAPABILITIES,
    qwenAnalyzer,
    repairMilestoneService,
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
    } catch (_) {
      res.status(500).json(errorResponse('能力校验失败', 500));
      return false;
    }
  }

  app.post('/api/v1/open/quote/ocr-import/by-image', authenticateOpenApiKey, async (req, res) => {
    if (!(await ensureOpenApiCapability(req, res, CAPABILITIES.QUOTE_OCR_IMPORT))) return;
    try {
      const imageUrl = req.body && req.body.image_url ? String(req.body.image_url).trim() : '';
      if (!imageUrl) return res.status(400).json(errorResponse('缺少 image_url', 400));
      const apiKey = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.ALIYUN_AI_KEY;
      if (!apiKey) {
        return res.status(503).json(errorResponse('未配置千问 API Key，无法使用报价单识别', 503));
      }
      const out = await qwenAnalyzer.analyzeRepairQuoteSheetWithQwen(imageUrl, apiKey);
      res.json(successResponse(out));
    } catch (e) {
      res.status(400).json(errorResponse((e && e.message) || '识别失败', 400));
    }
  });

  app.post('/api/v1/open/repair/timeline/public', authenticateOpenApiKey, async (req, res) => {
    if (!(await ensureOpenApiCapability(req, res, CAPABILITIES.REPAIR_TIMELINE_PUBLIC))) return;
    try {
      const orderId = req.body && req.body.order_id ? String(req.body.order_id).trim() : '';
      if (!orderId) return res.status(400).json(errorResponse('缺少 order_id', 400));
      const [rows] = await pool.execute('SELECT order_id, shop_id, status FROM orders WHERE order_id = ?', [orderId]);
      if (!rows.length) return res.status(404).json(errorResponse('订单不存在', 404));

      const order = rows[0];
      const ownerId = String((req.openApi && req.openApi.owner_id) || '').trim();
      if (ownerId && String(order.shop_id) !== ownerId) {
        return res.status(403).json(errorResponse('无权访问该订单进度', 403));
      }

      const milestones = await repairMilestoneService.listForOrder(pool, orderId);
      res.json(successResponse({
        order_id: orderId,
        order_status: Number(order.status),
        shop_id: String(order.shop_id || ''),
        milestones,
        count: milestones.length,
      }));
    } catch (_) {
      res.status(500).json(errorResponse('获取维修进度失败', 500));
    }
  });
}

module.exports = {
  manifest,
  registerRoutes,
};
