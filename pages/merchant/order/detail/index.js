// 服务商订单详情 - M07
const { getLogger } = require('../../../../utils/logger');
const ui = require('../../../../utils/ui');
const {
  getMerchantToken,
  getMerchantOrder,
  acceptOrder,
} = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');
const { requestMerchantSubscribe } = require('../../../../utils/subscribe');
const { computeRepairPhaseProgress } = require('../../../../utils/repair-phase-progress');
const { buildOwnerValueAddedDisplay } = require('../../../../utils/value-added-services');

const logger = getLogger('MerchantOrderDetail');

const STATUS_MAP = { 0: '待接单', 1: '维修中', 2: '待确认', 3: '已完成', 4: '已取消' };

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    orderId: '',
    order: null,
    accepting: false,
    durationCountdownText: '',
    durationCountdownExpired: false,
    lifecycleCountdownTitle: '',
    lifecycleCountdownText: '',
    lifecycleCountdownExpired: false,
    lifecycleCountdownVisible: false,
    showRepairPhase: false,
    showMilestoneFlowHint: false,
    materialAuditLockedHint: false,
    repairPhaseBeforeDone: false,
    repairPhaseDuringDone: false,
    repairPhaseAfterDone: false,
    damageReportImages: [],
    planValueAddedDisplay: null,
    selfHelpRequests: [],
    waitingPartsExtensions: [],
  },

  _durationTimer: null,
  _lifecycleTimer: null,

  onLoad(options) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    const id = (options.id || '').trim();
    if (!id) {
      ui.showError('订单ID无效');
      return;
    }
    this.setData({ orderId: id });
    if (!getMerchantToken()) {
      wx.redirectTo({ url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/order/detail/index?id=' + id) });
      return;
    }
    this._merchantOrderFirstShow = true;
    this.loadOrder();
  },

  onShow() {
    if (!this.data.orderId || !getMerchantToken()) return;
    if (this._merchantOrderFirstShow) {
      this._merchantOrderFirstShow = false;
      return;
    }
    this.loadOrder();
  },

  async loadOrder() {
    try {
      const res = await getMerchantOrder(this.data.orderId);
      const tier = res.order_tier || 2;
      const crDisplay = res.commission_rate != null ? (res.commission_rate + '%') : (tier === 1 ? '4%-8%' : tier === 2 ? '8%-12%' : tier === 3 ? '10%-14%' : '12%-16%');
      const rp = res.repair_plan;
      const quote = res.quote || {};
      const planItems = (rp && rp.items && rp.items.length) ? rp.items : (quote.items || []);
      const planValueAdded = (rp && rp.value_added_services && rp.value_added_services.length) ? rp.value_added_services : (quote.value_added_services || []);
      const planValueAddedDisplay = buildOwnerValueAddedDisplay(planValueAdded);
      const materialAuditPendingAi = res.status === 1 && res.material_audit_status === 'pending';
      const materialAuditManualReview = res.status === 1 && res.material_audit_status === 'manual_review';
      const materialAuditBusyHint = materialAuditPendingAi || materialAuditManualReview;
      const materialAuditRejected = res.status === 1 && res.material_audit_status === 'rejected';
      const hasPreQuote = !!res.pre_quote_snapshot;
      const fqsRaw = res.final_quote_status != null ? parseInt(res.final_quote_status, 10) : 0;
      const fqs = Number.isNaN(fqsRaw) ? 0 : fqsRaw;
      const canEditPlan =
        res.status === 1 &&
        (res.repair_plan_status === 0 || res.repair_plan_status === undefined) &&
        !hasPreQuote;
      const canSubmitFinalQuote = res.status === 1 && hasPreQuote && fqs !== 1;
      const finalQuotePending = hasPreQuote && fqs === 1;
      const finalQuoteLocked = hasPreQuote && fqs === 2;
      const planPendingConfirm = res.status === 1 && res.repair_plan_status === 1;
      const completeDisabled = planPendingConfirm || finalQuotePending;
      let statusText = STATUS_MAP[res.status] || '未知';
      if (materialAuditRejected) statusText = '材料质检未通过（可继续维修/沟通）';
      let completeBtnText = '维修完成';
      if (planPendingConfirm) completeBtnText = '请等待车主确认维修方案';
      else if (finalQuotePending) completeBtnText = '请等待车主确认报价';
      const damageReportImages = (Array.isArray(res.images) ? res.images : [])
        .map((u) => (typeof u === 'string' ? u.trim() : ''))
        .filter((u) => u.length > 0);
      this.setData({
        order: {
          ...res,
          status_text: statusText,
          commission_rate: crDisplay,
          displayAmount: (rp && rp.amount != null) ? rp.amount : res.quoted_amount,
          displayDuration: rp && rp.duration
        },
        planItems,
        planValueAddedDisplay,
        canEditPlan,
        canSubmitFinalQuote,
        finalQuotePending,
        finalQuoteLocked,
        completeDisabled,
        completeBtnText,
        planPendingConfirm,
        materialAuditing: materialAuditBusyHint,
        materialAuditPendingAi,
        materialAuditManualReview,
        materialAuditRejected,
        materialAuditRejectReason: res.material_audit_reject_reason || '',
        showRepairPhase: res.status === 1,
        showMilestoneFlowHint: res.status === 1,
        materialAuditLockedHint: false,
        damageReportImages,
        selfHelpRequests: Array.isArray(res.self_help_requests) ? res.self_help_requests : [],
        waitingPartsExtensions: Array.isArray(res.waiting_parts_extensions) ? res.waiting_parts_extensions : [],
      });
      this._syncRepairPhaseProgress();
      this._startDurationTimer();
      this._startLifecycleTimer();
      if (res.repair_plan_status === 1) requestMerchantSubscribe('order_new');
    } catch (err) {
      logger.error('加载订单详情失败', err);
      ui.showError(err.message || '加载失败');
    }
  },

  _syncRepairPhaseProgress() {
    const order = this.data.order;
    if (!order || order.status !== 1) {
      this.setData({
        repairPhaseBeforeDone: false,
        repairPhaseDuringDone: false,
        repairPhaseAfterDone: false,
      });
      return;
    }
    const p = computeRepairPhaseProgress({
      orderStatus: order.status,
      repair_milestones: order.repair_milestones || [],
      repairPhotoUrls: [],
      settlementPhotoUrls: [],
      materialPhotoUrls: [],
    });
    this.setData({
      repairPhaseBeforeDone: p.beforeDone,
      repairPhaseDuringDone: p.duringDone,
      repairPhaseAfterDone: p.afterDone,
    });
  },

  _startDurationTimer() {
    if (this._durationTimer) {
      clearInterval(this._durationTimer);
      this._durationTimer = null;
    }
    const order = this.data.order;
    if (!order || order.status > 1 || !order.duration_deadline) return;
    const update = () => {
      const deadline = new Date(order.duration_deadline);
      deadline.setHours(23, 59, 59, 999);
      const now = Date.now();
      if (now >= deadline.getTime()) {
        this.setData({ durationCountdownText: '', durationCountdownExpired: true });
        if (this._durationTimer) {
          clearInterval(this._durationTimer);
          this._durationTimer = null;
        }
        return;
      }
      const ms = deadline.getTime() - now;
      const d = Math.floor(ms / 86400000);
      const h = Math.floor((ms % 86400000) / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      let text = '';
      if (d > 0) text = d + '天' + (h > 0 ? h + '小时' : '');
      else if (h > 0) text = h + '小时' + m + '分';
      else text = m + '分钟';
      this.setData({ durationCountdownText: text || '不足1分钟', durationCountdownExpired: false });
    };
    update();
    this._durationTimer = setInterval(update, 60000);
  },

  _pickLifecycleCountdownMeta(order) {
    if (!order) return { visible: false, title: '', deadlineIso: null };
    if (!order.lifecycle_deadline_at) return { visible: false, title: '', deadlineIso: null };
    if (order.status === 4) return { visible: false, title: '', deadlineIso: null };
    const sub = (order.lifecycle_sub || '').trim();
    if (sub === 'merchant_not_handled_claimed') {
      return { visible: true, title: '最后通牒倒计时', deadlineIso: order.lifecycle_deadline_at };
    }
    return { visible: true, title: '当前节点倒计时', deadlineIso: order.lifecycle_deadline_at };
  },

  _startLifecycleTimer() {
    if (this._lifecycleTimer) {
      clearInterval(this._lifecycleTimer);
      this._lifecycleTimer = null;
    }
    const order = this.data.order;
    const meta = this._pickLifecycleCountdownMeta(order);
    if (!meta.visible || !meta.deadlineIso) {
      this.setData({
        lifecycleCountdownVisible: false,
        lifecycleCountdownTitle: '',
        lifecycleCountdownText: '',
        lifecycleCountdownExpired: false
      });
      return;
    }
    const update = () => {
      const deadline = new Date(meta.deadlineIso);
      const now = Date.now();
      if (!deadline.getTime() || Number.isNaN(deadline.getTime())) {
        this.setData({
          lifecycleCountdownVisible: false,
          lifecycleCountdownTitle: '',
          lifecycleCountdownText: '',
          lifecycleCountdownExpired: false
        });
        return;
      }
      if (now >= deadline.getTime()) {
        this.setData({
          lifecycleCountdownVisible: true,
          lifecycleCountdownTitle: meta.title,
          lifecycleCountdownText: '',
          lifecycleCountdownExpired: true
        });
        if (this._lifecycleTimer) {
          clearInterval(this._lifecycleTimer);
          this._lifecycleTimer = null;
        }
        return;
      }
      const ms = deadline.getTime() - now;
      const d = Math.floor(ms / 86400000);
      const h = Math.floor((ms % 86400000) / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      let text = '';
      if (d > 0) text = d + '天' + (h > 0 ? h + '小时' : '');
      else if (h > 0) text = h + '小时' + m + '分';
      else text = m + '分钟';
      this.setData({
        lifecycleCountdownVisible: true,
        lifecycleCountdownTitle: meta.title,
        lifecycleCountdownText: text || '不足1分钟',
        lifecycleCountdownExpired: false
      });
    };
    update();
    this._lifecycleTimer = setInterval(update, 60000);
  },

  onUnload() {
    if (this._durationTimer) {
      clearInterval(this._durationTimer);
      this._durationTimer = null;
    }
    if (this._lifecycleTimer) {
      clearInterval(this._lifecycleTimer);
      this._lifecycleTimer = null;
    }
  },

  async onAccept() {
    if (this.data.accepting) return;
    this.setData({ accepting: true });
    try {
      await acceptOrder(this.data.orderId);
      ui.showSuccess('接单成功');
      this.loadOrder();
    } catch (err) {
      logger.error('接单失败', err);
      ui.showError(err.message || '接单失败');
    }
    this.setData({ accepting: false });
  },

  onWaitingParts() {
    const id = this.data.orderId;
    if (!id) return;
    wx.navigateTo({ url: '/pages/merchant/order/waiting-parts-extension/index?id=' + encodeURIComponent(id) });
  },

  onSetPromisedDelivery() {
    const id = this.data.orderId;
    if (!id) return;
    wx.navigateTo({ url: '/pages/merchant/order/promised-delivery/index?id=' + encodeURIComponent(id) });
  },

  onPreviewOwnerPhotos(e) {
    const idx = parseInt(e.currentTarget.dataset.index, 10);
    const urls = this.data.damageReportImages || [];
    if (!urls.length) return;
    const cur = urls[Number.isNaN(idx) ? 0 : idx] || urls[0];
    wx.previewImage({ current: cur, urls });
  },

  onPreviewEvidence(e) {
    const urlsRaw = e.currentTarget.dataset.urls;
    const cur = e.currentTarget.dataset.current;
    const urls = Array.isArray(urlsRaw) ? urlsRaw : [];
    if (!urls.length) return;
    wx.previewImage({ current: cur || urls[0], urls });
  },

  onCallOwner() {
    const phone = this.data.order && this.data.order.owner_phone;
    if (phone) {
      wx.makePhoneCall({ phoneNumber: phone });
    } else {
      ui.showWarning('暂无车主联系方式');
    }
  },

  onEditPlan() {
    const { orderId, canEditPlan } = this.data;
    if (!canEditPlan) return;
    wx.showModal({
      title: '修改前须知',
      content: '修改前请先通知车主，沟通后再提交。确认已通知？',
      success: (res) => {
        if (res.confirm) {
          wx.navigateTo({ url: '/pages/merchant/order/repair-plan-edit/index?id=' + orderId });
        }
      }
    });
  },

  onSubmitFinalQuote() {
    const { orderId, canSubmitFinalQuote } = this.data;
    if (!canSubmitFinalQuote) return;
    wx.navigateTo({ url: '/pages/merchant/order/repair-plan-edit/index?id=' + orderId + '&mode=final' });
  },

  onRecordMilestone() {
    if (this.data.materialAuditing || !this.data.orderId) return;
    wx.navigateTo({ url: '/pages/merchant/order/repair-milestone/index?id=' + this.data.orderId });
  }
});
