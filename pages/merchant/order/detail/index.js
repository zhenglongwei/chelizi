// 服务商订单详情 - M07
const { getLogger } = require('../../../../utils/logger');
const ui = require('../../../../utils/ui');
const { getMerchantToken, getMerchantOrder, acceptOrder, updateOrderStatus } = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');

const logger = getLogger('MerchantOrderDetail');

const STATUS_MAP = { 0: '待接单', 1: '维修中', 2: '待确认', 3: '已完成', 4: '已取消' };

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    orderId: '',
    order: null,
    accepting: false,
    updating: false
  },

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
      this.setData({
        order: {
          ...res,
          status_text: STATUS_MAP[res.status] || '未知',
          commission_rate: crDisplay
        }
      });
    } catch (err) {
      logger.error('加载订单详情失败', err);
      ui.showError(err.message || '加载失败');
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

  async onMarkComplete() {
    if (this.data.updating) return;
    wx.showModal({
      title: '确认',
      content: '维修已完成，标记为待用户确认？',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ updating: true });
        try {
          await updateOrderStatus(this.data.orderId, 2);
          ui.showSuccess('已标记为待确认');
          this.loadOrder();
        } catch (err) {
          logger.error('更新状态失败', err);
          ui.showError(err.message || '更新失败');
        }
        this.setData({ updating: false });
      }
    });
  },

  onCallOwner() {
    const phone = this.data.order && this.data.order.owner_phone;
    if (phone) {
      wx.makePhoneCall({ phoneNumber: phone });
    } else {
      ui.showWarning('暂无车主联系方式');
    }
  }
});
