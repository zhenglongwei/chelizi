const manifest = require('./manifest.json');
const repairAlbumService = require('../../services/repair-album-service');
const shopPriceMenuService = require('../../services/shop-price-menu-service');
const shopAppointmentLeadService = require('../../services/shop-appointment-lead-service');

function registerRoutes(app, ctx) {
  const {
    pool,
    authenticateMerchant,
    successResponse,
    errorResponse,
  } = ctx;

  if (!authenticateMerchant) {
    console.warn('[RepairAlbumGeo_v1] authenticateMerchant missing; skip merchant routes');
  }

  // ---------- 商家：维修相册 ----------
  if (authenticateMerchant) {
    app.post('/api/v1/merchant/repair-albums', authenticateMerchant, async (req, res) => {
      try {
        const r = await repairAlbumService.createAlbum(pool, req.shopId, req.body || {});
        if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
        res.json(successResponse(r.data));
      } catch (e) {
        console.error(e);
        res.status(500).json(errorResponse('创建失败', 500));
      }
    });

    app.get('/api/v1/merchant/repair-albums', authenticateMerchant, async (req, res) => {
      try {
        const r = await repairAlbumService.listAlbums(pool, req.shopId, req.query);
        res.json(successResponse(r.data));
      } catch (e) {
        res.status(500).json(errorResponse('查询失败', 500));
      }
    });

    app.get('/api/v1/merchant/repair-albums/:albumId', authenticateMerchant, async (req, res) => {
      try {
        const r = await repairAlbumService.getAlbumDetail(pool, req.shopId, req.params.albumId);
        if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
        res.json(successResponse(r.data));
      } catch (e) {
        res.status(500).json(errorResponse('查询失败', 500));
      }
    });

    app.patch('/api/v1/merchant/repair-albums/:albumId', authenticateMerchant, async (req, res) => {
      try {
        const r = await repairAlbumService.patchAlbum(pool, req.shopId, req.params.albumId, req.body || {});
        if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
        res.json(successResponse(r.data));
      } catch (e) {
        res.status(500).json(errorResponse('更新失败', 500));
      }
    });

    app.put('/api/v1/merchant/repair-albums/:albumId/nodes/:nodeCode', authenticateMerchant, async (req, res) => {
      try {
        const note = (req.body && req.body.note) || '';
        const r = await repairAlbumService.updateNodeNote(pool, req.shopId, req.params.albumId, req.params.nodeCode, note);
        if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
        res.json(successResponse(r.data));
      } catch (e) {
        res.status(500).json(errorResponse('更新失败', 500));
      }
    });

    app.post('/api/v1/merchant/repair-albums/:albumId/media', authenticateMerchant, async (req, res) => {
      try {
        const r = await repairAlbumService.addMedia(pool, req.shopId, req.params.albumId, req.body || {});
        if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
        res.json(successResponse(r.data));
      } catch (e) {
        res.status(500).json(errorResponse('添加失败', 500));
      }
    });

    app.delete('/api/v1/merchant/repair-albums/:albumId/media/:mediaId', authenticateMerchant, async (req, res) => {
      try {
        const r = await repairAlbumService.deleteMedia(pool, req.shopId, req.params.albumId, req.params.mediaId);
        if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
        res.json(successResponse(r.data));
      } catch (e) {
        res.status(500).json(errorResponse('删除失败', 500));
      }
    });

    app.post('/api/v1/merchant/repair-albums/:albumId/submit-publish', authenticateMerchant, async (req, res) => {
      try {
        const r = await repairAlbumService.submitPublish(pool, req.shopId, req.params.albumId, req.body || {});
        if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
        res.json(successResponse(r.data));
      } catch (e) {
        res.status(500).json(errorResponse('提交失败', 500));
      }
    });

    app.post('/api/v1/merchant/repair-albums/:albumId/approve-publication', authenticateMerchant, async (req, res) => {
      try {
        const r = await repairAlbumService.approvePublication(pool, req.shopId, req.params.albumId, {
          reviewer: 'merchant:' + req.merchantId,
        });
        if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
        res.json(successResponse(r.data));
      } catch (e) {
        res.status(500).json(errorResponse('发布失败', 500));
      }
    });

    // ---------- 商家：价格菜单 ----------
    app.get('/api/v1/merchant/shop/price-menu', authenticateMerchant, async (req, res) => {
      try {
        const r = await shopPriceMenuService.listMenu(pool, req.shopId);
        res.json(successResponse(r.data));
      } catch (e) {
        res.status(500).json(errorResponse('查询失败', 500));
      }
    });

    app.post('/api/v1/merchant/shop/price-menu', authenticateMerchant, async (req, res) => {
      try {
        const r = await shopPriceMenuService.addRow(pool, req.shopId, req.body || {});
        if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
        res.json(successResponse(r.data));
      } catch (e) {
        res.status(500).json(errorResponse('添加失败', 500));
      }
    });

    app.delete('/api/v1/merchant/shop/price-menu/:menuRowId', authenticateMerchant, async (req, res) => {
      try {
        const r = await shopPriceMenuService.deleteRow(pool, req.shopId, req.params.menuRowId);
        if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
        res.json(successResponse(r.data));
      } catch (e) {
        res.status(500).json(errorResponse('删除失败', 500));
      }
    });

    // ---------- 商家：预约线索 ----------
    app.get('/api/v1/merchant/appointment-leads', authenticateMerchant, async (req, res) => {
      try {
        const r = await shopAppointmentLeadService.listLeads(pool, req.shopId);
        res.json(successResponse(r.data));
      } catch (e) {
        res.status(500).json(errorResponse('查询失败', 500));
      }
    });

    app.patch('/api/v1/merchant/appointment-leads/:leadId', authenticateMerchant, async (req, res) => {
      try {
        const r = await shopAppointmentLeadService.updateLeadStatus(pool, req.shopId, req.params.leadId, req.body || {});
        if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
        res.json(successResponse(r.data));
      } catch (e) {
        res.status(500).json(errorResponse('更新失败', 500));
      }
    });
  }

  // 车主/公开：预约（可按 shop_id 投递，无需登录；防刷由网关/频限后续补）
  app.post('/api/v1/public/shops/:shopId/appointment-leads', async (req, res) => {
    try {
      const shopId = String(req.params.shopId || '').trim();
      if (!shopId) return res.status(400).json(errorResponse('shopId 无效'));
      const r = await shopAppointmentLeadService.createLead(pool, shopId, { ...(req.body || {}), source: 'h5_or_public' });
      if (!r.success) return res.status(r.statusCode || 400).json(errorResponse(r.error));
      res.json(successResponse(r.data));
    } catch (e) {
      res.status(500).json(errorResponse('提交失败', 500));
    }
  });

  // ---------- 公网只读（H5 / AI）----------
  app.get('/api/v1/public/cases/:slug', async (req, res) => {
    try {
      const r = await repairAlbumService.getPublicCaseBySlug(pool, req.params.slug);
      if (!r.success) return res.status(r.statusCode || 404).json(errorResponse(r.error));
      res.json(successResponse(r.data));
    } catch (e) {
      res.status(500).json(errorResponse('查询失败', 500));
    }
  });

  app.get('/api/v1/public/shops/:shopId/summary', async (req, res) => {
    try {
      const r = await repairAlbumService.getPublicShopSummary(pool, req.params.shopId);
      if (!r.success) return res.status(r.statusCode || 404).json(errorResponse(r.error));
      res.json(successResponse(r.data));
    } catch (e) {
      res.status(500).json(errorResponse('查询失败', 500));
    }
  });

  app.get('/api/v1/public/shops/:shopId/price-menu', async (req, res) => {
    try {
      const shopId = req.params.shopId;
      const r = await shopPriceMenuService.listMenu(pool, shopId);
      if (!r.success) return res.status(400).json(errorResponse('失败'));
      const list = (r.data && r.data.list) || [];
      const active = list.filter((x) => x.is_active === 1 || x.is_active === true);
      res.json(successResponse({ list: active, table_ready: r.data.table_ready }));
    } catch (e) {
      res.status(500).json(errorResponse('查询失败', 500));
    }
  });
}

module.exports = {
  manifest,
  registerRoutes,
};
