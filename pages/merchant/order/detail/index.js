// 服务商订单详情 - M07
const { getLogger } = require('../../../../utils/logger');
const ui = require('../../../../utils/ui');
const {
  getMerchantToken,
  getMerchantOrder,
  acceptOrder,
  updateOrderStatus,
  merchantUploadImage,
  respondCancelRequest
} = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');
const { requestMerchantSubscribe } = require('../../../../utils/subscribe');
const { PARTS_VERIFICATION_METHODS } = require('../../../../utils/parts-verification-labels');

const logger = getLogger('MerchantOrderDetail');

const STATUS_MAP = { 0: '待接单', 1: '维修中', 2: '待确认', 3: '已完成', 4: '已取消' };

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    orderId: '',
    order: null,
    accepting: false,
    updating: false,
    repairPhotos: [],
    repairPhotoUrls: [],
    settlementPhotos: [],
    settlementPhotoUrls: [],
    materialPhotos: [],
    materialPhotoUrls: [],
    durationCountdownText: '',
    durationCountdownExpired: false,
    leadTechName: '',
    partsVerificationMethods: PARTS_VERIFICATION_METHODS,
    partsVerifyPicks: {},
    partsVerifyNotProvided: false,
    partsVerifyNote: ''
  },

  _durationTimer: null,

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
      const materialAuditPendingAi = res.status === 1 && res.material_audit_status === 'pending';
      const materialAuditManualReview = res.status === 1 && res.material_audit_status === 'manual_review';
      const materialAuditing = materialAuditPendingAi || materialAuditManualReview;
      const materialAuditRejected = res.status === 1 && res.material_audit_status === 'rejected';
      const hasPreQuote = !!res.pre_quote_snapshot;
      const fqsRaw = res.final_quote_status != null ? parseInt(res.final_quote_status, 10) : 0;
      const fqs = Number.isNaN(fqsRaw) ? 0 : fqsRaw;
      const canEditPlan =
        !materialAuditing &&
        res.status === 1 &&
        (res.repair_plan_status === 0 || res.repair_plan_status === undefined) &&
        !hasPreQuote;
      const canSubmitFinalQuote =
        !materialAuditing && res.status === 1 && hasPreQuote && fqs !== 1;
      const finalQuotePending = hasPreQuote && fqs === 1;
      const finalQuoteLocked = hasPreQuote && fqs === 2;
      // 有预报价的订单完工均须负责人/验真（选厂价或锁价后一致）
      const needLeadTech = hasPreQuote;
      const planPendingConfirm = res.status === 1 && res.repair_plan_status === 1;
      const completeDisabled =
        materialAuditing || planPendingConfirm || finalQuotePending;
      let statusText = STATUS_MAP[res.status] || '未知';
      if (materialAuditPendingAi) statusText = '正在审核材料';
      else if (materialAuditManualReview) statusText = '材料人工审核中';
      else if (materialAuditRejected) statusText = '审核未通过';
      let completeBtnText = '维修完成';
      if (materialAuditPendingAi) completeBtnText = '正在审核材料';
      else if (materialAuditManualReview) completeBtnText = '人工审核中';
      else if (planPendingConfirm) completeBtnText = '请等待车主确认维修方案';
      else if (finalQuotePending) completeBtnText = '请等待车主确认报价';
      this.setData({
        order: {
          ...res,
          status_text: statusText,
          commission_rate: crDisplay,
          displayAmount: (rp && rp.amount != null) ? rp.amount : res.quoted_amount,
          displayDuration: rp && rp.duration
        },
        planItems,
        planValueAdded,
        canEditPlan,
        canSubmitFinalQuote,
        finalQuotePending,
        finalQuoteLocked,
        needLeadTech,
        completeDisabled,
        completeBtnText,
        planPendingConfirm,
        materialAuditing,
        materialAuditPendingAi,
        materialAuditManualReview,
        materialAuditRejected,
        materialAuditRejectReason: res.material_audit_reject_reason || ''
      });
      this._startDurationTimer();
      if (res.repair_plan_status === 1) requestMerchantSubscribe('order_new');
    } catch (err) {
      logger.error('加载订单详情失败', err);
      ui.showError(err.message || '加载失败');
    }
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

  onUnload() {
    if (this._durationTimer) {
      clearInterval(this._durationTimer);
      this._durationTimer = null;
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

  onChooseRepairPhoto() {
    if (this.data.materialAuditing) return;
    this._chooseAndUpload('repair', 6 - this.data.repairPhotoUrls.length);
  },
  onChooseSettlementPhoto() {
    if (this.data.materialAuditing) return;
    this._chooseAndUpload('settlement', 4 - this.data.settlementPhotoUrls.length);
  },
  onChooseMaterialPhoto() {
    if (this.data.materialAuditing) return;
    this._chooseAndUpload('material', 4 - this.data.materialPhotoUrls.length);
  },
  async _chooseAndUpload(type, count) {
    if (count <= 0) return;
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: async (res) => {
        const files = (res.tempFiles || []).slice(0, count);
        const keyUrls =
          type === 'repair'
            ? 'repairPhotoUrls'
            : type === 'settlement'
              ? 'settlementPhotoUrls'
              : 'materialPhotoUrls';
        const keyPhotos =
          type === 'repair'
            ? 'repairPhotos'
            : type === 'settlement'
              ? 'settlementPhotos'
              : 'materialPhotos';
        for (const f of files) {
          try {
            const url = await merchantUploadImage(f.tempFilePath);
            const urls = [...(this.data[keyUrls] || []), url];
            const imgs = [...(this.data[keyPhotos] || []), f.tempFilePath];
            this.setData({ [keyUrls]: urls, [keyPhotos]: imgs });
          } catch (e) {
            logger.error('上传失败', e);
            ui.showError(e && e.message ? e.message : '上传失败');
          }
        }
      }
    });
  },
  onTogglePartsVerifyMethod(e) {
    if (this.data.materialAuditing) return;
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    const picks = { ...(this.data.partsVerifyPicks || {}) };
    if (picks[key]) delete picks[key];
    else picks[key] = true;
    this.setData({ partsVerifyPicks: picks, partsVerifyNotProvided: false });
  },

  onPartsVerifyNotProvidedChange(e) {
    if (this.data.materialAuditing) return;
    const on = !!(e.detail && e.detail.value);
    this.setData({
      partsVerifyNotProvided: on,
      partsVerifyPicks: on ? {} : this.data.partsVerifyPicks
    });
  },

  onPartsVerifyNoteInput(e) {
    this.setData({ partsVerifyNote: e.detail.value || '' });
  },

  buildPartsVerificationPayload() {
    if (!this.data.needLeadTech) return { ok: true, data: null };
    if (this.data.partsVerifyNotProvided) {
      return { ok: true, data: { not_provided: true } };
    }
    const selected = Object.keys(this.data.partsVerifyPicks || {}).filter((k) => this.data.partsVerifyPicks[k]);
    if (!selected.length) {
      return { ok: false, msg: '请选择配件验真方式，或勾选「暂不填写验真说明」' };
    }
    if (selected.indexOf('other') >= 0) {
      const note = String(this.data.partsVerifyNote || '').trim();
      if (note.length < 2) {
        return { ok: false, msg: '选择「其他」时请简短说明验真方式' };
      }
      return { ok: true, data: { methods: selected, note } };
    }
    return { ok: true, data: { methods: selected } };
  },

  onDelEvidencePhoto(e) {
    if (this.data.materialAuditing) return;
    const { type, index } = e.currentTarget.dataset;
    const keyUrls =
      type === 'repair'
        ? 'repairPhotoUrls'
        : type === 'settlement'
          ? 'settlementPhotoUrls'
          : 'materialPhotoUrls';
    const keyPhotos =
      type === 'repair'
        ? 'repairPhotos'
        : type === 'settlement'
          ? 'settlementPhotos'
          : 'materialPhotos';
    const urls = [...(this.data[keyUrls] || [])];
    const imgs = [...(this.data[keyPhotos] || [])];
    urls.splice(index, 1);
    imgs.splice(index, 1);
    this.setData({ [keyUrls]: urls, [keyPhotos]: imgs });
  },
  async onMarkComplete() {
    if (this.data.updating) return;
    const { repairPhotoUrls, settlementPhotoUrls, materialPhotoUrls } = this.data;
    if (!repairPhotoUrls || repairPhotoUrls.length < 1) {
      ui.showWarning('请上传至少 1 张修复后照片');
      return;
    }
    if (!settlementPhotoUrls || settlementPhotoUrls.length < 1) {
      ui.showWarning('请上传至少 1 张定损单或结算单照片');
      return;
    }
    if (!materialPhotoUrls || materialPhotoUrls.length < 1) {
      ui.showWarning('请上传至少 1 张物料照片');
      return;
    }
    wx.showModal({
      title: '确认',
      content: '确认维修已完成并提交凭证？',
      success: async (res) => {
        if (!res.confirm) return;
        requestMerchantSubscribe('material_audit');
        this.setData({ updating: true });
        try {
          const ev = {
            repair_photos: repairPhotoUrls,
            settlement_photos: settlementPhotoUrls,
            material_photos: materialPhotoUrls
          };
          if (this.data.needLeadTech) {
            const name = (this.data.leadTechName || '').trim();
            if (!name) {
              ui.showWarning('请填写负责维修的技师或负责人');
              this.setData({ updating: false });
              return;
            }
            ev.lead_technician = { source: 'manual', name };
            const pv = this.buildPartsVerificationPayload();
            if (!pv.ok) {
              ui.showWarning(pv.msg);
              this.setData({ updating: false });
              return;
            }
            if (pv.data) ev.parts_verification = pv.data;
          }
          const res = await updateOrderStatus(this.data.orderId, {
            status: 2,
            completion_evidence: ev
          });
          const isAuditing = res && res.status === 'auditing';
          ui.showSuccess(isAuditing ? '正在审核材料，请稍后查看结果' : '已标记为待确认');
          this.setData({
            repairPhotos: [],
            repairPhotoUrls: [],
            settlementPhotos: [],
            settlementPhotoUrls: [],
            materialPhotos: [],
            materialPhotoUrls: [],
            partsVerifyPicks: {},
            partsVerifyNotProvided: false,
            partsVerifyNote: ''
          });
          this.loadOrder();
        } catch (err) {
          logger.error('更新状态失败', err);
          ui.showError(err.message || '更新失败');
        }
        this.setData({ updating: false });
      }
    });
  },
  async onRespondCancel(e) {
    const approve = e.currentTarget.dataset.approve === 'true' || e.currentTarget.dataset.approve === true;
    const { order, orderId } = this.data;
    const req = order && order.pending_cancel_request;
    if (!req || !req.request_id) return;
    try {
      await respondCancelRequest(orderId, req.request_id, approve);
      ui.showSuccess(approve ? '已同意撤单' : '已拒绝');
      this.loadOrder();
    } catch (err) {
      logger.error('响应撤单失败', err);
      ui.showError(err.message || '操作失败');
    }
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

  onLeadTechInput(e) {
    this.setData({ leadTechName: e.detail.value || '' });
  }
});
