// 主评价页 - 05-评价页（3 模块 1 次提交）
const { getToken, getOrderForReview, getRewardPreview, submitReview, uploadImage } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');
const ui = require('../../../utils/ui');

// 选填星级：仅保留主观可评价维度。报价透明度、完工时效由平台客观计算；售后响应在追评时评价
const RATING_KEYS = [
  { key: 'service', label: '服务态度', dbKey: 'service' },
  { key: 'environment', label: '维修环境', dbKey: 'quality' }
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
    orderVerification: null,
    orderVerificationAllOk: false,
    planCompare: null,
    // 用户必答 3 道
    answers: { q1_progress_synced: null, q2_parts_shown: null, q3_fault_resolved: null },
    // 模块2 维修过程（三级/四级必填材料）
    module2: { materials: [], materialUrls: [], materialDisplayList: [] },
    // 模块3 完工验收（必填）
    module3: {
      settlement_list_image: '',
      settlement_list_url: '',
      completion_images: [],
      completion_urls: [],
      completionDisplayList: [],
      fault_evidence_images: [],
      faultEvidenceDisplayList: [],
      content: '',
      ratings: { service: 5, environment: 5 }
    },
    isAnonymous: false,
    submitting: false,
    submitted: false,
    isInvalidReview: false,
    rewardAmount: '0.00',
    reviewId: '',
    progressText: '0/4',
    canSubmit: false,
    planCompare: null,
    ratingItems: [
      { key: 'service', label: '服务态度', value: 5 },
      { key: 'environment', label: '维修环境', value: 5 }
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
      const ratings = { service: 5, environment: 5 };
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
        orderVerification: info.order_verification || null,
        orderVerificationAllOk: !!info.order_verification_all_ok,
        loading: false
      });
      this.updateProgress();
    } catch (e) {
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },

  updateProgress() {
    const { answers, module3 } = this.data;
    const answersDone = answers.q1_progress_synced != null && answers.q2_parts_shown != null && answers.q3_fault_resolved != null;
    const contentLen = (module3.content || '').trim().length;
    const contentOk = contentLen >= 5;
    let done = 0;
    if (answersDone) done++;
    if (contentOk) done++;
    const hint = done >= 2 ? '完成' : '完成 3 道题 + 至少 1 句描述可获奖励';
    this.setData({
      progressText: hint,
      canSubmit: true
    });
  },

  onQ1(e) { const v = e.detail.value === 'true'; this.setData({ 'answers.q1_progress_synced': v }, () => this.updateProgress()); },
  onQ2(e) { const v = e.detail.value === 'true'; this.setData({ 'answers.q2_parts_shown': v }, () => this.updateProgress()); },
  onQ3(e) { const v = e.detail.value === 'true'; this.setData({ 'answers.q3_fault_resolved': v }, () => this.updateProgress()); },
  onM3Content(e) { this.setData({ 'module3.content': (e.detail.value || '').trim() }, () => this.updateProgress()); },

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

  onM3ChooseFaultEvidence() {
    const { module3 } = this.data;
    const remain = 5 - (module3.faultEvidenceDisplayList?.length || 0);
    if (remain <= 0) { ui.showWarning('最多 5 张'); return; }
    wx.chooseMedia({
      count: Math.min(remain, 5),
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const newPaths = (res.tempFiles || []).map(f => f.tempFilePath);
        const fault_evidence_images = [...(module3.fault_evidence_images || []), ...newPaths];
        const faultEvidenceDisplayList = [...(module3.faultEvidenceDisplayList || []), ...newPaths.map((p) => ({ url: p }))];
        this.setData({ 'module3.fault_evidence_images': fault_evidence_images, 'module3.faultEvidenceDisplayList': faultEvidenceDisplayList }, () => this.updateProgress());
      }
    });
  },
  onM3DelFaultEvidence(e) {
    const idx = e.currentTarget.dataset.index;
    const module3 = { ...this.data.module3 };
    module3.fault_evidence_images.splice(idx, 1);
    module3.faultEvidenceDisplayList.splice(idx, 1);
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

  async onSubmit(forceSubmit = false) {
    const { orderId, orderTier, answers, module2, module3, isAnonymous, rewardPreview } = this.data;
    if (this.data.submitting) return;

    this.setData({ submitting: true });
    try {
      let settlementUrl = module3.settlement_list_url || '';
      if (module3.settlement_list_image && !settlementUrl) {
        settlementUrl = await uploadImage(module3.settlement_list_image);
        this.setData({ 'module3.settlement_list_url': settlementUrl });
      }

      let completionUrls = [...(module3.completion_urls || [])];
      for (let i = 0; i < (module3.completion_images?.length || 0); i++) {
        completionUrls.push(await uploadImage(module3.completion_images[i]));
      }

      let faultEvidenceUrls = [];
      for (let i = 0; i < (module3.fault_evidence_images?.length || 0); i++) {
        faultEvidenceUrls.push(await uploadImage(module3.fault_evidence_images[i]));
      }

      let materialUrls = [...(module2.materialUrls || [])];
      for (let i = 0; i < (module2.materials?.length || 0); i++) {
        materialUrls.push(await uploadImage(module2.materials[i]));
      }

      const ratings = module3.ratings || {};
      const ratingsForApi = {
        quality: ratings.environment ?? 5,
        service: ratings.service ?? 5
      };

      const res = await submitReview({
        order_id: orderId,
        force_submit: forceSubmit,
        module2: orderTier >= 3 ? { materials: materialUrls } : undefined,
        module3: {
          settlement_list_image: settlementUrl,
          completion_images: completionUrls,
          fault_evidence_images: faultEvidenceUrls,
          q1_progress_synced: answers.q1_progress_synced,
          q2_parts_shown: answers.q2_parts_shown,
          q3_fault_resolved: answers.q3_fault_resolved,
          content: module3.content,
          ratings: ratingsForApi
        },
        is_anonymous: isAnonymous
      });

      const amt = (res.reward && res.reward.amount) ?? 0;
      const isInvalid = !!res.is_invalid;
      this.setData({
        submitting: false,
        submitted: true,
        rewardAmount: formatMoney(amt),
        reviewId: res.review_id || '',
        isInvalidReview: isInvalid
      });
    } catch (e) {
      this.setData({ submitting: false });
      const errMsg = e.message || '提交失败';
      if (!forceSubmit && e.statusCode === 400) {
        const reward = (rewardPreview && rewardPreview.total_reward) || '—';
        wx.showModal({
          title: '您的评价可改进',
          content: `${errMsg}\n\n改进后可获得约 ¥${reward} 奖励金。\n\n优质评价若帮助其他车主，还可获得持续点赞奖励。`,
          confirmText: '去改进',
          cancelText: '仍要提交',
          success: (res) => {
            if (res.cancel) this.onSubmit(true);
          }
        });
      } else {
        ui.showError(errMsg);
      }
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
