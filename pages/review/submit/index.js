// 主评价页 · 极简 v3（review_form_version=3）：五项星级 + 折叠留痕 + 选填与素材 + 分项公开授权
const { getToken, getOrderForReview, getRewardPreview, submitReview, uploadImage } = require('../../../utils/api');
const { getNavBarHeight, getSystemInfo } = require('../../../utils/util');
const ui = require('../../../utils/ui');
const { formatMethodsSummary } = require('../../../utils/parts-verification-labels');
const { buildQuoteDisplayNodes } = require('../../../utils/review-v3-public-display');

const STORAGE_REVIEW_DRAFT = 'review_draft_v3_';

/** 多节点且各节点金额一致（用于低星时提示是否线下加价） */
function computeQuotePriceStable(quoteFlowNodes) {
  const nodes = Array.isArray(quoteFlowNodes) ? quoteFlowNodes : [];
  if (nodes.length < 2) return false;
  const amounts = nodes.map((n) => {
    if (n.amount == null || n.amount === '') return null;
    const x = Number(n.amount);
    return Number.isNaN(x) ? null : x;
  });
  if (amounts.some((a) => a == null)) return false;
  const base = amounts[0];
  return amounts.every((a) => Math.abs(a - base) < 0.005);
}
const MAX_V3_TEXT = 200;

function buildAiPreviewFingerprint(orderId, sc, quoteFlowNodes) {
  try {
    const pd = sc.parts_delivery || {};
    const qn = (quoteFlowNodes || []).map((n) => `${n.display_round_label || ''}:${n.amount}`).join('|');
    return JSON.stringify({
      oid: orderId,
      pd: { st: pd.status },
      qn,
    });
  } catch (_) {
    return '';
  }
}

function formatMoney(v) {
  if (v == null || v === '' || isNaN(v)) return '0.00';
  return Number(v).toFixed(2);
}

const MAX_OWNER_EXTRA_IMAGES = 12;

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
    reviewScene: 'general',
    systemChecksPreview: {},
    appearanceAiConclusion: '',
    partsAiConclusion: '',
    /** 分项公开：仅约束店端/订单侧素材；前端不校验图片是否存在 */
    review_public_media: {
      exterior_before_after: false,
      parts_contrast: false,
      settlement_docs: false,
    },
    v3: {
      process_transparency_star: 0,
      quote_transparency_star: 0,
      parts_traceability_star: 0,
      repair_effect_star: 0,
      service_experience_star: 0,
      parts_authenticity_check: '',
      owner_verify_result: '',
    },
    expandProcess: false,
    expandQuote: false,
    expandParts: false,
    /** 各报价节点金额一致，低星时提示线下加价补充说明 */
    quotePriceStable: false,
    repairMilestoneTrace: { count: 0, items: [] },
    /** 第4题单独展示：milestone_code = parts_verify_process */
    partsVerifyMilestoneItems: [],
    quoteEvidenceImages: [],
    /** 维修前：竞价/定损上报（damage_reports，与 for-review before_images 一致） */
    beforeEvidenceImages: [],
    /** 维修后：服务商提交完工凭证（completion_evidence.repair_photos） */
    repairEvidenceImages: [],
    partsEvidenceImages: [],
    objectiveHintsList: [],
    aiPreviewFingerprint: '',
    quoteFlowNodes: [],
    /** 报价折叠区展示用（短标签 + 同价合并） */
    quoteDisplayNodes: [],
    merchantVerifyLine: '',
    submitTagRow: [],
    module3: {
      content: '',
    },
    ownerExtraImages: [],
    isAnonymous: false,
    submitting: false,
    submitted: false,
    isInvalidReview: false,
    pendingHumanAudit: false,
    invalidReason: '',
    improvementHints: [],
    rewardAmount: '0.00',
    reviewId: '',
    progressText: '',
    canSubmit: false,
    contentLength: 0,
    validReviewCount: 0,
  },

  onLoad(options) {
    const navH = getNavBarHeight();
    const sys = getSystemInfo();
    this.setData({
      pageRootStyle: 'padding-top: ' + navH + 'px',
      scrollStyle: 'height: ' + (sys.windowHeight - navH - 120) + 'px',
    });
    const orderId = (options.order_id || options.id || '').trim();
    if (!orderId) {
      this.setData({ loading: false, error: '缺少订单ID' });
      return;
    }
    if (!getToken()) {
      wx.navigateTo({
        url: '/pages/auth/login/index?redirect=' + encodeURIComponent('/pages/review/submit/index?order_id=' + orderId),
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
        getRewardPreview(orderId).catch(() => null),
      ]);
      const reviewScene =
        info.review_scene ||
        (info.is_insurance_accident === 1 || info.is_insurance_accident === '1' ? 'accident' : 'general');
      const sc = info.system_checks_preview || {};
      const qfn = (sc.quote_flow && Array.isArray(sc.quote_flow.nodes) && sc.quote_flow.nodes) || [];
      const hints = (Array.isArray(info.objective_hints) ? info.objective_hints : []).filter((h) => h && h.code !== 'settlement_mismatch');
      const quoteDisplayNodes = buildQuoteDisplayNodes(qfn);
      const fp = buildAiPreviewFingerprint(orderId, sc, qfn);
      const mvv = info.merchant_parts_verification;
      let merchantVerifyLine = '';
      if (mvv && mvv.not_provided) {
        merchantVerifyLine = '服务商未填写验真方式说明。';
      } else if (mvv && Array.isArray(mvv.methods) && mvv.methods.length) {
        merchantVerifyLine = '店方验真方式：' + formatMethodsSummary(mvv.methods);
        if (mvv.note) merchantVerifyLine += '（' + String(mvv.note).slice(0, 80) + '）';
      } else {
        merchantVerifyLine = '暂无店方验真方式记录，请向商户确认。';
      }

      const quoteEvidenceImages = [];
      const seenQuoteImg = new Set();
      const pushQuoteImg = (u) => {
        const s = String(u || '').trim();
        if (s && !seenQuoteImg.has(s)) {
          seenQuoteImg.add(s);
          quoteEvidenceImages.push(s);
        }
      };
      pushQuoteImg(info.merchant_settlement_list);
      const lossUrls = info.loss_assessment_image_urls;
      if (Array.isArray(lossUrls)) lossUrls.forEach(pushQuoteImg);
      const beforeEvidenceImages = [].concat(info.before_images || []).slice(0, 8);
      const repairEvidenceImages = [].concat(info.merchant_completion_images || []).slice(0, 8);
      const partsEvidenceImages = [].concat(info.merchant_material_images || []).slice(0, 8);

      const amount = parseFloat(info.quoted_amount || info.actual_amount || 0);
      let orderTier = rewardPreview?.order_tier || info.order_tier;
      if (!orderTier) {
        if (amount < 1000) orderTier = 1;
        else if (amount < 5000) orderTier = 2;
        else if (amount < 20000) orderTier = 3;
        else orderTier = 4;
      }

      let restored = '';
      try {
        const draft = wx.getStorageSync(STORAGE_REVIEW_DRAFT + orderId);
        if (draft && typeof draft === 'string') restored = draft;
      } catch (_) {}

      const module3 = { ...this.data.module3, content: restored || this.data.module3.content || '' };

      const rmtRaw = info.repair_milestone_trace && typeof info.repair_milestone_trace === 'object'
        ? info.repair_milestone_trace
        : { count: 0, items: [] };
      const rmtItems = (rmtRaw.items || []).map((it) => {
        const photo_urls = Array.isArray(it.photo_urls) ? it.photo_urls : [];
        const parts_photo_urls = Array.isArray(it.parts_photo_urls) ? it.parts_photo_urls : [];
        const all_milestone_photos = photo_urls.concat(parts_photo_urls);
        const n = all_milestone_photos.length;
        return {
          ...it,
          photo_urls,
          parts_photo_urls,
          all_milestone_photos,
          photo_count: n,
          parts_photo_count: parts_photo_urls.length,
        };
      });
      const PARTS_VERIFY = 'parts_verify_process';
      const processItems = rmtItems.filter((it) => (it.milestone_code || '') !== PARTS_VERIFY);
      const partsVerifyMilestoneItems = rmtItems.filter((it) => (it.milestone_code || '') === PARTS_VERIFY);
      const rmt = { count: processItems.length, items: processItems };

      const validReviewCount = Math.max(0, parseInt(info.valid_review_count, 10) || 0);

      this.setData({
        info,
        rewardPreview,
        orderTier,
        validReviewCount,
        reviewScene,
        systemChecksPreview: sc,
        quoteFlowNodes: qfn,
        quoteDisplayNodes,
        quotePriceStable: computeQuotePriceStable(qfn),
        objectiveHintsList: hints,
        aiPreviewFingerprint: fp,
        merchantVerifyLine,
        quoteEvidenceImages,
        beforeEvidenceImages,
        repairEvidenceImages,
        partsEvidenceImages,
        repairMilestoneTrace: rmt,
        partsVerifyMilestoneItems,
        module3,
        contentLength: (module3.content || '').length,
        loading: false,
      });
      this.updateProgress();
    } catch (e) {
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },

  rebuildSubmitTags() {
    const v3 = this.data.v3 || {};
    const tags = [];
    const proc = parseInt(v3.process_transparency_star, 10);
    const qt = parseInt(v3.quote_transparency_star, 10);
    const pt = parseInt(v3.parts_traceability_star, 10);
    const re = parseInt(v3.repair_effect_star, 10);
    const sv = parseInt(v3.service_experience_star, 10);
    tags.push({
      kind: 'user',
      text: !Number.isNaN(qt) && qt >= 1 ? '报价 ' + qt + '★' : '报价 ?★',
      sub: '车主',
    });
    tags.push({
      kind: 'user',
      text: !Number.isNaN(re) && re >= 1 ? '修复 ' + re + '★' : '修复 ?★',
      sub: '车主',
    });
    tags.push({
      kind: 'user',
      text: !Number.isNaN(proc) && proc >= 1 ? '流程 ' + proc + '★' : '流程 ?★',
      sub: '车主',
    });
    tags.push({
      kind: 'user',
      text: !Number.isNaN(pt) && pt >= 1 ? '配件 ' + pt + '★' : '配件 ?★',
      sub: '车主',
    });
    tags.push({
      kind: 'user',
      text: !Number.isNaN(sv) && sv >= 1 ? '服务 ' + sv + '★' : '服务 ?★',
      sub: '车主',
    });
    this.setData({ submitTagRow: tags });
  },

  onToggleExpand(e) {
    const key = e.currentTarget.dataset.key;
    if (key === 'process') this.setData({ expandProcess: !this.data.expandProcess });
    else if (key === 'quote') this.setData({ expandQuote: !this.data.expandQuote });
    else if (key === 'parts') this.setData({ expandParts: !this.data.expandParts });
  },

  updateProgress() {
    const { v3, module3 } = this.data;
    const proc = parseInt(v3.process_transparency_star, 10);
    const qt = parseInt(v3.quote_transparency_star, 10);
    const pt = parseInt(v3.parts_traceability_star, 10);
    const re = parseInt(v3.repair_effect_star, 10);
    const sv = parseInt(v3.service_experience_star, 10);
    const starsOk =
      !Number.isNaN(proc) &&
      proc >= 1 &&
      proc <= 5 &&
      !Number.isNaN(qt) &&
      qt >= 1 &&
      qt <= 5 &&
      !Number.isNaN(pt) &&
      pt >= 1 &&
      pt <= 5 &&
      !Number.isNaN(re) &&
      re >= 1 &&
      re <= 5 &&
      !Number.isNaN(sv) &&
      sv >= 1 &&
      sv <= 5;
    const ok = starsOk;
    const textLen = (module3.content || '').trim().length;
    if (textLen > MAX_V3_TEXT) {
      this.setData({ progressText: `补充说明请减至 ${MAX_V3_TEXT} 字以内`, canSubmit: false }, () => this.rebuildSubmitTags());
      return;
    }
    let progressText = '可提交';
    if (!starsOk) {
      progressText =
        '请完成五项星级（报价、修复、流程、配件、服务）';
    }
    this.setData(
      {
        canSubmit: ok,
        progressText: ok ? '可提交' : progressText,
      },
      () => this.rebuildSubmitTags()
    );
  },

  onV3FiveStarTap(e) {
    const field = e.currentTarget.dataset.field;
    const s = parseInt(e.currentTarget.dataset.s, 10);
    if (!field || Number.isNaN(s)) return;
    this.setData({ [`v3.${field}`]: s }, () => {
      this.updateProgress();
      if (field === 'quote_transparency_star' && this.data.quotePriceStable && s >= 1 && s <= 2) {
        wx.showModal({
          title: '补充说明',
          content:
            '本单各报价节点金额一致。若您仍认为不合理，请说明是否存在线下加价等情况，可在本页最下方「补充说明与图片」中填写。',
          showCancel: false,
          confirmText: '知道了',
        });
      }
    });
  },

  onPreviewMilestonePhoto(e) {
    const mii = parseInt(e.currentTarget.dataset.milestone, 10);
    const url = (e.currentTarget.dataset.url || '').trim();
    const fromPartsVerify = (e.currentTarget.dataset.from || '') === 'partsverify';
    const items = fromPartsVerify
      ? this.data.partsVerifyMilestoneItems || []
      : (this.data.repairMilestoneTrace && this.data.repairMilestoneTrace.items) || [];
    const mi = items[mii];
    if (!mi) return;
    const merged = Array.isArray(mi.all_milestone_photos) ? mi.all_milestone_photos : null;
    const main = Array.isArray(mi.photo_urls) ? mi.photo_urls : [];
    const parts = Array.isArray(mi.parts_photo_urls) ? mi.parts_photo_urls : [];
    const urls = (merged && merged.length ? merged : [...main, ...parts]).filter(Boolean);
    if (urls.length) wx.previewImage({ urls, current: url || urls[0] });
  },

  onOwnerVerifyTap() {
    wx.showActionSheet({
      itemList: ['已验真，与承诺一致', '已验真，与承诺不一致', '尚未验真'],
      success: (res) => {
        const i = res.tapIndex;
        let ovr = 'skipped';
        if (i === 0) ovr = 'verified_match';
        else if (i === 1) ovr = 'verified_mismatch';
        else ovr = 'skipped';
        this.setData({ 'v3.owner_verify_result': ovr });
      },
    });
  },

  onM3Content(e) {
    const content = e.detail.value || '';
    const slice = content.length > MAX_V3_TEXT ? content.slice(0, MAX_V3_TEXT) : content;
    const { orderId } = this.data;
    this.setData({ 'module3.content': slice, contentLength: slice.length }, () => this.updateProgress());
    try {
      wx.setStorageSync(STORAGE_REVIEW_DRAFT + orderId, slice);
    } catch (_) {}
  },

  onPublicMediaToggle(e) {
    const key = e.currentTarget.dataset.key;
    const allowed = { exterior_before_after: 1, parts_contrast: 1, settlement_docs: 1 };
    if (!key || !allowed[key]) return;
    const cur = !!this.data.review_public_media[key];
    this.setData({ [`review_public_media.${key}`]: !cur });
  },

  onChooseOwnerExtra() {
    const list = this.data.ownerExtraImages || [];
    const remain = MAX_OWNER_EXTRA_IMAGES - list.length;
    if (remain <= 0) {
      ui.showWarning(`最多 ${MAX_OWNER_EXTRA_IMAGES} 张`);
      return;
    }
    wx.chooseMedia({
      count: Math.min(remain, 9),
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const newPaths = (res.tempFiles || []).map((f) => f.tempFilePath);
        this.setData({ ownerExtraImages: [...list, ...newPaths] });
      },
    });
  },

  onOwnerExtraDel(e) {
    const idx = parseInt(e.currentTarget.dataset.index, 10);
    const ownerExtraImages = [...(this.data.ownerExtraImages || [])];
    if (!Number.isNaN(idx) && idx >= 0 && idx < ownerExtraImages.length) {
      ownerExtraImages.splice(idx, 1);
      this.setData({ ownerExtraImages });
    }
  },

  onPreviewOwnerExtraImages(e) {
    const current = e.currentTarget.dataset.current || '';
    const urls = this.data.ownerExtraImages || [];
    if (urls.length) wx.previewImage({ urls, current: current || urls[0] });
  },

  onAnonymousChange(e) {
    this.setData({ isAnonymous: !!e.detail.value });
  },

  async onSubmit(forceSubmit = false) {
    const { orderId, v3, module3, isAnonymous, rewardPreview, ownerExtraImages, review_public_media } = this.data;
    if (this.data.submitting) return;
    if (!this.data.canSubmit) {
      ui.showWarning(this.data.progressText || '请完善必填项');
      return;
    }

    this.setData({ submitting: true });
    try {
      const paths = ownerExtraImages || [];
      const completionUrls = [];
      for (let i = 0; i < paths.length; i++) {
        completionUrls.push(await uploadImage(paths[i]));
      }
      const settlementUrl = completionUrls.length ? completionUrls[0] : '';

      const rpm = { ...review_public_media };

      const owner_always_public_urls = completionUrls.map((u) => String(u || '').trim()).filter(Boolean);

      const module3Payload = {
        process_transparency_star: v3.process_transparency_star,
        quote_transparency_star: v3.quote_transparency_star,
        parts_traceability_star: v3.parts_traceability_star,
        repair_effect_star: v3.repair_effect_star,
        service_experience_star: v3.service_experience_star,
        owner_verify_result: v3.owner_verify_result || undefined,
        content: (module3.content || '').trim(),
        settlement_list_image: settlementUrl || undefined,
        completion_images: completionUrls,
        fault_evidence_images: [],
        owner_always_public_urls,
        review_public_media: rpm,
        ai_preview_fingerprint: String(this.data.aiPreviewFingerprint || '').slice(0, 2000),
      };

      const res = await submitReview({
        order_id: orderId,
        review_form_version: 3,
        force_submit: forceSubmit,
        module3: module3Payload,
        is_anonymous: isAnonymous,
      });

      const amt = (res.reward && res.reward.amount) ?? 0;
      const isInvalid = !!res.is_invalid;
      const hints = Array.isArray(res.improvement_hints) ? res.improvement_hints : [];
      try {
        wx.removeStorageSync(STORAGE_REVIEW_DRAFT + orderId);
      } catch (_) {}
      this.setData({
        submitting: false,
        submitted: true,
        rewardAmount: formatMoney(amt),
        reviewId: res.review_id || '',
        isInvalidReview: isInvalid,
        pendingHumanAudit: !!res.pending_human_audit,
        invalidReason: (res.invalid_reason && String(res.invalid_reason)) || '',
        improvementHints: hints,
      });
    } catch (e) {
      this.setData({ submitting: false });
      const errMsg = e.message || '提交失败';
      if (!forceSubmit && e.statusCode === 400) {
        const reward = (rewardPreview && rewardPreview.total_reward) || '—';
        wx.showModal({
          title: '提示',
          content: `${errMsg}\n\n请按提示修改后重试（若涉及照片/表述与订单留档是否一致，请核对后再提交）。\n\n改进后基础奖励预估值约 ¥${reward}。若认为系统判断有误，可试「提交人工复核」。`,
          confirmText: '去修改',
          cancelText: '提交人工复核',
          success: (r) => {
            if (r.cancel) this.onSubmit(true);
          },
        });
      } else {
        ui.showError(errMsg);
      }
    }
  },

  onBack() {
    wx.navigateBack();
  },

  onToOrder() {
    wx.navigateTo({ url: '/pages/order/detail/index?id=' + this.data.orderId });
  },

  onToFollowup() {
    const { reviewId } = this.data;
    if (reviewId) wx.navigateTo({ url: '/pages/review/followup/index?review_id=' + reviewId });
  },

  onToUser() {
    wx.switchTab({ url: '/pages/user/index/index' });
  },
});
