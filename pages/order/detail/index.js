// 订单详情 - 07-订单详情页
const { getToken, getUserOrder, getRewardPreview, cancelOrder, confirmOrder, escalateCancelRequest, approveRepairPlan } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');
const ui = require('../../../utils/ui');

const STATUS_MAP = { 0: '待接单', 1: '维修中', 2: '待确认完成', 3: '待评价', 4: '已取消' };

Page({
  data: {
    order: null,
    rewardPreview: null,
    loading: true,
    pageRootStyle: 'padding-top: 88px',
    planItems: [],
    planValueAdded: [],
    approving: false,
    durationCountdownText: '',
    durationCountdownExpired: false
  },

  _durationTimer: null,

  onLoad(options) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    const id = options.id;
    if (!id) {
      wx.showToast({ title: '参数错误', icon: 'none' });
      return;
    }
    if (!getToken()) {
      wx.navigateTo({ url: '/pages/auth/login/index?redirect=' + encodeURIComponent('/pages/order/detail/index?id=' + id) });
      return;
    }
    this.loadOrder(id);
  },

  async loadOrder(id) {
    try {
      const [order, rewardPreview] = await Promise.all([
        getUserOrder(id),
        getRewardPreview(id).catch(() => null)
      ]);
      order.statusText = STATUS_MAP[order.status] ?? '未知';
      order.canCancel = order.can_cancel === true;
      order.cancelNeedsReason = order.cancel_needs_reason === true;
      order.cancelRejected = order.cancel_rejected === true;
      order.cancelRequestId = order.cancel_request_id;
      order.canConfirm = (order.status === 2);
      order.canReview = (order.status === 3 && !order.first_review_id);
      order.canFollowup = order.can_followup && order.first_review_id;
      order.repair_plan_status = parseInt(order.repair_plan_status, 10) || 0;

      const rp = order.repair_plan;
      const quote = order.quote || {};
      const planItems = (rp && rp.items && rp.items.length) ? rp.items : (quote.items || []);
      const planValueAdded = (rp && rp.value_added_services && rp.value_added_services.length) ? rp.value_added_services : (quote.value_added_services || []);
      order.displayAmount = (rp && rp.amount != null) ? rp.amount : order.quoted_amount;
      order.displayDuration = rp && rp.duration != null ? rp.duration : (quote.duration || order.quote_duration);
      order.displayWarranty = rp && rp.warranty != null ? rp.warranty : quote.warranty;

      this.setData({ order, rewardPreview, planItems, planValueAdded, loading: false });
      this._startDurationTimer();
    } catch (e) {
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
      this.setData({ loading: false });
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

  onCallShop() {
    const phone = this.data.order && this.data.order.shop_phone;
    if (phone) wx.makePhoneCall({ phoneNumber: phone });
  },

  async onConfirm() {
    const { order } = this.data;
    if (!order || !order.canConfirm) return;
    wx.showModal({
      title: '确认完成',
      content: '确认维修已完成？确认后将进行评价',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await confirmOrder(order.order_id);
          ui.showSuccess('已确认完成');
          wx.navigateTo({ url: '/pages/review/submit/index?order_id=' + order.order_id });
        } catch (e) {
          ui.showError(e.message || '操作失败');
        }
      }
    });
  },

  onReview() {
    const { order } = this.data;
    if (!order || !order.canReview) return;
    wx.navigateTo({ url: '/pages/review/submit/index?order_id=' + order.order_id });
  },

  onFollowup() {
    const { order } = this.data;
    if (!order || !order.canFollowup) return;
    wx.navigateTo({ url: '/pages/review/followup/index?review_id=' + order.first_review_id + '&stage=1m' });
  },

  onCancel() {
    const { order } = this.data;
    if (!order || !order.canCancel) return;
    if (order.cancelNeedsReason) {
      wx.showModal({
        title: '申请撤销',
        editable: true,
        placeholderText: '请填写撤单理由（必填）',
        success: async (res) => {
          if (!res.confirm) return;
          const reason = (res.content || '').trim();
          if (!reason) {
            ui.showWarning('请填写撤单理由');
            return;
          }
          try {
            const data = await cancelOrder(order.order_id, reason);
            ui.showSuccess(data.direct ? '已撤销' : '撤单申请已提交');
            if (data.direct) wx.navigateBack();
            else this.loadOrder(order.order_id);
          } catch (e) {
            ui.showError(e.message || '操作失败');
          }
        }
      });
    } else {
      wx.showModal({
        title: '撤销订单',
        content: '撤销后可重新选择其他报价，确定撤销吗？',
        success: async (res) => {
          if (!res.confirm) return;
          try {
            await cancelOrder(order.order_id);
            ui.showSuccess('已撤销');
            wx.navigateBack();
          } catch (e) {
            ui.showError(e.message || '撤销失败');
          }
        }
      });
    }
  },

  async onApprovePlan(e) {
    const approve = e.currentTarget.dataset.approve === 'true' || e.currentTarget.dataset.approve === true;
    const { order } = this.data;
    if (!order || order.repair_plan_status !== 1) return;
    this.setData({ approving: true });
    try {
      await approveRepairPlan(order.order_id, approve);
      ui.showSuccess(approve ? '已同意维修方案' : '如有疑问请联系客服');
      this.loadOrder(order.order_id);
    } catch (err) {
      ui.showError(err.message || '操作失败');
    }
    this.setData({ approving: false });
  },

  async onEscalateCancel() {
    const { order } = this.data;
    if (!order || !order.cancelRejected || !order.cancelRequestId) return;
    try {
      await escalateCancelRequest(order.order_id, order.cancelRequestId);
      ui.showSuccess('已提交人工通道');
      this.loadOrder(order.order_id);
    } catch (e) {
      ui.showError(e.message || '提交失败');
    }
  }
});
