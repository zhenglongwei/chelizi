const ui = require('../../../../utils/ui');
const { getNavBarHeight } = require('../../../../utils/util');
const { setMerchantPromisedDelivery } = require('../../../../utils/api');

Page({
  data: {
    orderId: '',
    pageRootStyle: 'padding-top: 88px',
    date: '',
    time: '',
    submitting: false,
  },

  onLoad(options) {
    const orderId = (options.id || options.order_id || '').trim();
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px', orderId });
    if (!orderId) ui.showError('订单ID无效');
  },

  onDateChange(e) {
    this.setData({ date: e.detail.value });
  },

  onTimeChange(e) {
    this.setData({ time: e.detail.value });
  },

  async onSubmit() {
    const { orderId, date, time, submitting } = this.data;
    if (!orderId || !date || !time || submitting) return;
    this.setData({ submitting: true });
    try {
      const iso = new Date(`${date}T${time}:00`).toISOString();
      await setMerchantPromisedDelivery(orderId, { promised_delivery_at: iso });
      ui.showSuccess('已设置');
      setTimeout(() => wx.navigateBack(), 400);
    } catch (e) {
      ui.showError(e.message || '设置失败');
    } finally {
      this.setData({ submitting: false });
    }
  }
});

