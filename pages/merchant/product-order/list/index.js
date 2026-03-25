const { getLogger } = require('../../../../utils/logger');
const ui = require('../../../../utils/ui');
const navigation = require('../../../../utils/navigation');
const { getMerchantToken, getMerchantProductOrders } = require('../../../../utils/api');
const { getNavBarHeight, getSystemInfo } = require('../../../../utils/util');

const logger = getLogger('MerchantProductOrders');

Page({
  data: {
    list: [],
    loading: true,
    pageRootStyle: 'padding-top: 88px',
    scrollStyle: 'height: 500px'
  },

  onLoad() {
    const navH = getNavBarHeight();
    this.setData({ pageRootStyle: 'padding-top: ' + navH + 'px' });
    try {
      const sys = getSystemInfo();
      this.setData({ scrollStyle: 'height: ' + (sys.windowHeight - navH) + 'px' });
    } catch (_) {}
    if (!getMerchantToken()) {
      ui.showWarning('请先登录');
      setTimeout(() => navigation.redirectTo('/pages/merchant/login'), 400);
      return;
    }
    this.loadList();
  },

  async loadList() {
    this.setData({ loading: true });
    try {
      const res = await getMerchantProductOrders({ page: 1, limit: 50 });
      const raw = res.list || [];
      const list = raw.map((r) => ({
        ...r,
        paid: r.payment_status === 'paid',
        statusLabel: r.payment_status === 'paid' ? '已支付' : r.payment_status === 'pending_pay' ? '待支付' : r.payment_status,
        amountText: parseFloat(r.amount_total).toFixed(2),
        createdText: r.created_at ? String(r.created_at).replace('T', ' ').slice(0, 19) : ''
      }));
      this.setData({ list, loading: false });
    } catch (e) {
      logger.error(e);
      ui.showError(e.message || '加载失败');
      this.setData({ loading: false });
    }
  }
});
