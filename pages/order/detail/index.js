// 订单详情 - 07-订单详情页
const { getToken, getUserOrder, getRewardPreview, cancelOrder, confirmOrder } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');
const ui = require('../../../utils/ui');

const STATUS_MAP = { 0: '待接单', 1: '维修中', 2: '待确认完成', 3: '待评价', 4: '已取消' };

Page({
  data: {
    order: null,
    rewardPreview: null,
    loading: true,
    pageRootStyle: 'padding-top: 88px'
  },

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
      order.canCancel = (order.status === 0 || order.status === 1 || order.status === 2);
      order.canConfirm = (order.status === 2);
      order.canReview = (order.status === 3 && !order.first_review_id);
      order.canFollowup = order.can_followup && order.first_review_id;
      this.setData({ order, rewardPreview, loading: false });
    } catch (e) {
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
      this.setData({ loading: false });
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
});
