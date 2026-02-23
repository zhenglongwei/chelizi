// 主评价页 - 05-评价页（3 模块 1 次提交）
const { getToken, getOrderForReview, getRewardPreview, submitReview, uploadImage } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');
const ui = require('../../../utils/ui');

const RATING_KEYS = [
  { key: 'price_transparency', label: '报价透明度', dbKey: 'price' },
  { key: 'service', label: '服务态度', dbKey: 'service' },
  { key: 'timeliness', label: '完工时效', dbKey: 'speed' },
  { key: 'environment', label: '维修环境', dbKey: 'quality' },
  { key: 'after_sales', label: '售后响应', dbKey: 'parts' }
];

function formatMoney(v) {
  if (v == null || v === '' || isNaN(v)) return '0.00';
  return Number(v).toFixed(2);
}

/** 比较 quote 与 repair_plan，生成方案对比数据（供模块2展示） */
function buildPlanCompare(quotePlan, repairPlan) {
  if (!quotePlan || !repairPlan) return null;
  const fmt = (it) => `${it.damage_part || it.name || it.item || '项目'}：${it.repair_type || '维修'}${it.parts_type ? ' · ' + it.parts_type : ''}`;
  const qItems = (quotePlan.items || []).map(fmt);
  const rItems = (repairPlan.items || []).map(fmt);
  const itemsSame = JSON.stringify(qItems) === JSON.stringify(rItems);
  const amountDiff = (quotePlan.amount != null && repairPlan.amount != null && Number(quotePlan.amount) !== Number(repairPlan.amount));
  const durationDiff = (quotePlan.duration != null && repairPlan.duration != null && Number(quotePlan.duration) !== Number(repairPlan.duration));
  const warrantyDiff = (quotePlan.warranty != null && repairPlan.warranty != null && Number(quotePlan.warranty) !== Number(repairPlan.warranty));
  const qVa = (quotePlan.value_added_services || []).map((v) => (typeof v === 'string' ? v : v.name || v));
  const rVa = (repairPlan.value_added_services || []).map((v) => (typeof v === 'string' ? v : v.name || v));
  const valueAddedDiff = JSON.stringify(qVa) !== JSON.stringify(rVa);

  const hasDiff = !itemsSame || amountDiff || durationDiff || warrantyDiff || valueAddedDiff;
  if (!hasDiff) return null;

  return {
    hasDiff: true,
    originalItems: qItems,
    finalItems: rItems,
    amountDiff,
    durationDiff,
    warrantyDiff,
    valueAddedDiff,
    originalAmount: quotePlan.amount,
    originalDuration: quotePlan.duration,
    originalWarranty: quotePlan.warranty,
    originalValueAdded: qVa,
    finalAmount: repairPlan.amount,
    finalDuration: repairPlan.duration,
    finalWarranty: repairPlan.warranty,
    finalValueAdded: rVa
  };
}

Page({
  data: {
    orderId: '',
    orderTier: 1,
    info: {},
    rewardPreview: null,
    loading: true,
    error: '',
    scrollStyle: 'height: 600px',
    pageRootStyle: 'padding-top: 88px',
    // 模块1 报价服务（选填）
    module1: { q1_settlement_match: null, q2_informed: null, content: '' },
    // 模块2 维修过程（三级/四级必填）
    module2: { materials: [], materialUrls: [], q1_project_match: null, q2_parts_match: null, q3_progress_synced: null },
    // 模块3 完工验收（必填）
    module3: {
      settlement_list_image: '',
      settlement_list_url: '',
      completion_images: [],
      completion_urls: [],
      q1_shop_match: null,
      q2_settlement_match: null,
      q3_fault_resolved: null,
      q4_warranty_informed: null,
      content: '',
      ratings: { price_transparency: 5, service: 5, timeliness: 5, environment: 5, after_sales: 5 }
    },
    isAnonymous: false,
    submitting: false,
    submitted: false,
    rewardAmount: '0.00',
    reviewId: '',
    progressText: '0/4',
    canSubmit: false,
    planCompare: null,
    ratingItems: [
      { key: 'price_transparency', label: '报价透明度', value: 5 },
      { key: 'service', label: '服务态度', value: 5 },
      { key: 'timeliness', label: '完工时效', value: 5 },
      { key: 'environment', label: '维修环境', value: 5 },
      { key: 'after_sales', label: '售后响应', value: 5 }
    ]
  },

  onLoad(options) {
    const navH = getNavBarHeight();
    const sys = wx.getSystemInfoSync();
    this.setData({
      pageRootStyle: 'padding-top: ' + navH + 'px',
      scrollStyle: 'height: ' + (sys.windowHeight - navH - 120) + 'px'
    });
    const orderId = (options.order_id || options.id || '').trim();
    if (!orderId) {
      this.setData({ loading: false, error: '缺少订单ID' });
      return;
    }
    if (!getToken()) {
      wx.navigateTo({
        url: '/pages/auth/login/index?redirect=' + encodeURIComponent('/pages/review/submit/index?order_id=' + orderId)
      });
      return;
    }
    this.setData({ orderId });
    this.loadInfo();
  },

  async loadInfo() {
    const { orderId } = this.data;
    try {
      const [info, rewardPreview] = await Promise.all([
        getOrderForReview(orderId),
        getRewardPreview(orderId).catch(() => null)
      ]);
      const amount = parseFloat(info.quoted_amount || info.actual_amount || 0);
      let orderTier = rewardPreview?.order_tier || info.order_tier;
      if (!orderTier) {
        if (amount < 1000) orderTier = 1;
        else if (amount < 5000) orderTier = 2;
        else if (amount < 20000) orderTier = 3;
        else orderTier = 4;
      }
      const ratings = { price_transparency: 5, service: 5, timeliness: 5, environment: 5, after_sales: 5 };
      const ratingItems = RATING_KEYS.map((k) => ({ ...k, value: ratings[k.key] ?? 5 }));

      const merchantMaterials = info.merchant_material_images || [];
      const merchantCompletion = info.merchant_completion_images || [];
      const merchantSettlement = info.merchant_settlement_list || [];
      const module2 = {
        ...this.data.module2,
        materialUrls: merchantMaterials,
        materialUrlsFromMerchant: merchantMaterials.length,
        materials: [],
        materialDisplayList: (merchantMaterials || []).map((u) => ({ url: u, fromMerchant: true })),
      };
      const module3 = {
        ...this.data.module3,
        completion_urls: merchantCompletion,
        completionUrlsFromMerchant: merchantCompletion.length,
        completion_images: [],
        completionDisplayList: (merchantCompletion || []).map((u) => ({ url: u, fromMerchant: true })),
        settlement_list_url: merchantSettlement[0] || '',
        settlementFromMerchant: !!merchantSettlement[0],
      };

      const planCompare = buildPlanCompare(info.quote_plan, info.repair_plan);

      this.setData({
        info,
        rewardPreview,
        orderTier,
        ratingItems,
        module2,
        module3,
        planCompare,
        loading: false
      });
      this.updateProgress();
    } catch (e) {
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },

  updateProgress() {
    const { orderTier, module2, module3 } = this.data;
    const m2Required = orderTier >= 3;
    let done = 0;
    const total = m2Required ? 4 : 3;
    if (module3.settlement_list_url || module3.settlement_list_image) done++;
    const completionCount = (module3.completionDisplayList || []).length;
    if (completionCount >= 2) done++;
    if (module3.q1_shop_match != null && module3.q2_settlement_match != null && module3.q3_fault_resolved != null && module3.q4_warranty_informed != null) done++;
    if (m2Required) {
      const minMats = orderTier === 4 ? 5 : 1;
      const matCount = module2.materialDisplayList?.length || 0;
      const m2Done = matCount >= minMats && module2.q1_project_match != null && module2.q2_parts_match != null && module2.q3_progress_synced != null;
      if (m2Done) done++;
    }
    const canSubmit = done >= total;
    this.setData({
      progressText: done + '/' + total,
      canSubmit
    });
  },

  onM1Q1(e) { const v = e.detail.value === 'true'; this.setData({ 'module1.q1_settlement_match': v }); },
  onM1Q2(e) { const v = e.detail.value === 'true'; this.setData({ 'module1.q2_informed': v }); },
  onM1Content(e) { this.setData({ 'module1.content': (e.detail.value || '').trim() }); },

  onM2Q1(e) { const v = e.detail.value === 'true'; this.setData({ 'module2.q1_project_match': v }, () => this.updateProgress()); },
  onM2Q2(e) { const v = e.detail.value === 'true'; this.setData({ 'module2.q2_parts_match': v }, () => this.updateProgress()); },
  onM2Q3(e) { const v = e.detail.value === 'true'; this.setData({ 'module2.q3_progress_synced': v }, () => this.updateProgress()); },

  onM3Q1(e) { const v = e.detail.value === 'true'; this.setData({ 'module3.q1_shop_match': v }, () => this.updateProgress()); },
  onM3Q2(e) { const v = e.detail.value === 'true'; this.setData({ 'module3.q2_settlement_match': v }, () => this.updateProgress()); },
  onM3Q3(e) { const v = e.detail.value === 'true'; this.setData({ 'module3.q3_fault_resolved': v }, () => this.updateProgress()); },
  onM3Q4(e) { const v = e.detail.value === 'true'; this.setData({ 'module3.q4_warranty_informed': v }, () => this.updateProgress()); },
  onM3Content(e) { this.setData({ 'module3.content': (e.detail.value || '').trim() }); },

  onAnonymousChange(e) { this.setData({ isAnonymous: !!e.detail.value }); },

  onM2ChooseMaterial() {
    const { module2 } = this.data;
    const fromMerchant = module2.materialUrlsFromMerchant || 0;
    const max = this.data.orderTier === 4 ? 10 : 5;
    const remain = max - (module2.materialDisplayList?.length || 0);
    if (remain <= 0) { ui.showWarning('已达上传上限'); return; }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const newPaths = (res.tempFiles || []).map(f => f.tempFilePath);
        const materials = [...(module2.materials || []), ...newPaths];
        const materialDisplayList = [
          ...(module2.materialUrls || []).map((u) => ({ url: u, fromMerchant: true })),
          ...materials.map((p) => ({ url: p, fromMerchant: false }))
        ];
        this.setData({ 'module2.materials': materials, 'module2.materialDisplayList': materialDisplayList }, () => this.updateProgress());
      }
    });
  },

  onM2DelMaterial(e) {
    const idx = e.currentTarget.dataset.index;
    const fromMerchant = this.data.module2.materialUrlsFromMerchant || 0;
    if (idx < fromMerchant) {
      ui.showWarning('服务商上传的凭证不可删除');
      return;
    }
    const module2 = { ...this.data.module2 };
    module2.materials.splice(idx - fromMerchant, 1);
    module2.materialDisplayList.splice(idx, 1);
    this.setData({ module2 }, () => this.updateProgress());
  },

  onM3ChooseSettlement() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const path = res.tempFiles?.[0]?.tempFilePath;
        if (path) this.setData({ 'module3.settlement_list_image': path }, () => this.updateProgress());
      }
    });
  },

  onM3ChooseCompletion() {
    const { module3 } = this.data;
    const remain = 8 - (module3.completionDisplayList?.length || 0);
    if (remain <= 0) { ui.showWarning('最多 8 张'); return; }
    wx.chooseMedia({
      count: Math.min(remain, 6),
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const newPaths = (res.tempFiles || []).map(f => f.tempFilePath);
        const completion_images = [...(module3.completion_images || []), ...newPaths];
        const completionDisplayList = [
          ...(module3.completion_urls || []).map((u) => ({ url: u, fromMerchant: true })),
          ...completion_images.map((p) => ({ url: p, fromMerchant: false }))
        ];
        this.setData({ 'module3.completion_images': completion_images, 'module3.completionDisplayList': completionDisplayList }, () => this.updateProgress());
      }
    });
  },

  onM3DelCompletion(e) {
    const idx = e.currentTarget.dataset.index;
    const fromMerchant = this.data.module3.completionUrlsFromMerchant || 0;
    if (idx < fromMerchant) {
      ui.showWarning('服务商上传的凭证不可删除');
      return;
    }
    const module3 = { ...this.data.module3 };
    module3.completion_images.splice(idx - fromMerchant, 1);
    module3.completionDisplayList.splice(idx, 1);
    this.setData({ module3 }, () => this.updateProgress());
  },

  onM3DelSettlement() {
    if (this.data.module3.settlementFromMerchant) {
      ui.showWarning('服务商上传的结算单不可删除');
      return;
    }
    this.setData({ 'module3.settlement_list_image': '', 'module3.settlement_list_url': '' }, () => this.updateProgress());
  },

  onRatingTap(e) {
    const { key, value } = e.currentTarget.dataset;
    const v = parseInt(value, 10) || 5;
    const ratings = { ...this.data.module3.ratings, [key]: v };
    const ratingItems = RATING_KEYS.map((k) => ({ ...k, value: ratings[k.key] ?? 5 }));
    this.setData({ 'module3.ratings': ratings, ratingItems });
  },

  async onSubmit() {
    const { orderId, orderTier, module1, module2, module3, isAnonymous, canSubmit } = this.data;
    if (!canSubmit) {
      ui.showWarning('请完成必填项');
      return;
    }
    if (this.data.submitting) return;

    this.setData({ submitting: true });
    try {
      let settlementUrl = module3.settlement_list_url;
      if (module3.settlement_list_image && !settlementUrl) {
        settlementUrl = await uploadImage(module3.settlement_list_image);
        this.setData({ 'module3.settlement_list_url': settlementUrl });
      }

      let completionUrls = [...(module3.completion_urls || [])];
      for (let i = 0; i < (module3.completion_images?.length || 0); i++) {
        completionUrls.push(await uploadImage(module3.completion_images[i]));
      }
      if (completionUrls.length < 2) {
        ui.showWarning('请上传至少 2 张完工实拍图');
        this.setData({ submitting: false });
        return;
      }

      let materialUrls = [...(module2.materialUrls || [])];
      if (orderTier >= 3) {
        for (let i = 0; i < (module2.materials?.length || 0); i++) {
          materialUrls.push(await uploadImage(module2.materials[i]));
        }
        const minMaterials = orderTier === 4 ? 5 : 1;
        if (materialUrls.length < minMaterials) {
          ui.showWarning(orderTier === 4 ? '四级订单请上传至少 5 张维修过程材料' : '三级订单请上传至少 1 张维修过程材料');
          this.setData({ submitting: false });
          return;
        }
      }

      const ratings = module3.ratings || {};
      const ratingsForApi = {
        quality: ratings.environment ?? 5,
        price: ratings.price_transparency ?? 5,
        service: ratings.service ?? 5,
        speed: ratings.timeliness ?? 5,
        parts: ratings.after_sales ?? 5
      };

      const res = await submitReview({
        order_id: orderId,
        module1: {
          q1_settlement_match: module1.q1_settlement_match,
          q2_informed: module1.q2_informed,
          content: module1.content || undefined
        },
        module2: orderTier >= 3 ? {
          materials: materialUrls,
          q1_project_match: module2.q1_project_match,
          q2_parts_match: module2.q2_parts_match,
          q3_progress_synced: module2.q3_progress_synced
        } : undefined,
        module3: {
          settlement_list_image: settlementUrl,
          completion_images: completionUrls,
          q1_shop_match: module3.q1_shop_match,
          q2_settlement_match: module3.q2_settlement_match,
          q3_fault_resolved: module3.q3_fault_resolved,
          q4_warranty_informed: module3.q4_warranty_informed,
          content: module3.content,
          ratings: ratingsForApi
        },
        is_anonymous: isAnonymous
      });

      const amt = (res.reward && res.reward.amount) ?? 0;
      this.setData({
        submitting: false,
        submitted: true,
        rewardAmount: formatMoney(amt),
        reviewId: res.review_id || ''
      });
    } catch (e) {
      this.setData({ submitting: false });
      ui.showError(e.message || '提交失败');
    }
  },

  onBack() { wx.navigateBack(); },

  onToOrder() { wx.navigateTo({ url: '/pages/order/detail/index?id=' + this.data.orderId }); },
  onToFollowup() {
    const { reviewId } = this.data;
    if (reviewId) wx.navigateTo({ url: '/pages/review/followup/index?review_id=' + reviewId });
  },
  onToUser() { wx.switchTab({ url: '/pages/user/index/index' }); }
});
