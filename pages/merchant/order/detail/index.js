// 服务商订单详情 - M07
const { getLogger } = require('../../../../utils/logger');
const ui = require('../../../../utils/ui');
const { getMerchantToken, getMerchantOrder, acceptOrder, updateOrderStatus, merchantUploadImage, respondCancelRequest, updateRepairPlan } = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');

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
    durationCountdownExpired: false
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
      const canEditPlan = res.status === 1 && (res.repair_plan_status === 0 || res.repair_plan_status === undefined);
      const planPendingConfirm = res.status === 1 && res.repair_plan_status === 1;
      this.setData({
        order: {
          ...res,
          status_text: STATUS_MAP[res.status] || '未知',
          commission_rate: crDisplay,
          displayAmount: (rp && rp.amount != null) ? rp.amount : res.quoted_amount,
          displayDuration: rp && rp.duration,
          displayWarranty: rp && rp.warranty
        },
        planItems,
        planValueAdded,
        canEditPlan,
        planPendingConfirm
      });
      this._startDurationTimer();
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
    this._chooseAndUpload('repair', 6 - this.data.repairPhotoUrls.length);
  },
  onChooseSettlementPhoto() {
    this._chooseAndUpload('settlement', 4 - this.data.settlementPhotoUrls.length);
  },
  onChooseMaterialPhoto() {
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
        const keyUrls = type === 'repair' ? 'repairPhotoUrls' : type === 'settlement' ? 'settlementPhotoUrls' : 'materialPhotoUrls';
        const keyPhotos = type === 'repair' ? 'repairPhotos' : type === 'settlement' ? 'settlementPhotos' : 'materialPhotos';
        for (const f of files) {
          try {
            const url = await merchantUploadImage(f.tempFilePath);
            const urls = [...(this.data[keyUrls] || []), url];
            const imgs = [...(this.data[keyPhotos] || []), f.tempFilePath];
            this.setData({ [keyUrls]: urls, [keyPhotos]: imgs });
          } catch (e) {
            logger.error('上传失败', e);
            ui.showError('上传失败');
          }
        }
      }
    });
  },
  onDelEvidencePhoto(e) {
    const { type, index } = e.currentTarget.dataset;
    const keyUrls = type === 'repair' ? 'repairPhotoUrls' : type === 'settlement' ? 'settlementPhotoUrls' : 'materialPhotoUrls';
    const keyPhotos = type === 'repair' ? 'repairPhotos' : type === 'settlement' ? 'settlementPhotos' : 'materialPhotos';
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
        this.setData({ updating: true });
        try {
          await updateOrderStatus(this.data.orderId, {
            status: 2,
            completion_evidence: {
              repair_photos: repairPhotoUrls,
              settlement_photos: settlementPhotoUrls,
              material_photos: materialPhotoUrls
            }
          });
          ui.showSuccess('已标记为待确认');
          this.setData({ repairPhotos: [], repairPhotoUrls: [], settlementPhotos: [], settlementPhotoUrls: [], materialPhotos: [], materialPhotoUrls: [] });
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
  }
});
