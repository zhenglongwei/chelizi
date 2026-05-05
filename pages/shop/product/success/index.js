// 标品支付成功页：仅展示已支付结果与「预约 / 查看订单」
const ui = require('../../../../utils/ui');
const navigation = require('../../../../utils/navigation');
const { getToken, getUserProductOrder } = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');
const { formatBeijingDateTimeFull } = require('../../../../utils/beijing-time');

Page({
  data: {
    shopId: '',
    productOrderId: '',
    shopName: '',
    productName: '',
    quantity: 1,
    amountText: '0.00',
    paidAtText: '',
    loading: true,
    loadError: false,
    pageRootStyle: 'padding-top: 88px'
  },

  onLoad(options) {
    const navH = getNavBarHeight();
    this.setData({ pageRootStyle: 'padding-top: ' + navH + 'px' });
    const shopId = (options.shop_id || options.shopId || '').trim();
    const productOrderId = (options.product_order_id || options.poid || '').trim();
    this.setData({ shopId, productOrderId });
    if (!shopId || !productOrderId) {
      ui.showError('参数错误');
      setTimeout(() => navigation.navigateBack(), 1200);
      return;
    }
    if (!getToken()) {
      const redir =
        '/pages/shop/product/success/index?shop_id=' +
        encodeURIComponent(shopId) +
        '&product_order_id=' +
        encodeURIComponent(productOrderId);
      navigation.redirectTo('/pages/auth/login/index', { redirect: redir });
      return;
    }
    this.loadOrder();
  },

  async loadOrder() {
    const { productOrderId } = this.data;
    this.setData({ loading: true, loadError: false });
    try {
      const o = await getUserProductOrder(productOrderId);
      const amt = parseFloat(o.amount_total);
      this.setData({
        shopName: o.shop_name || '维修厂',
        productName: o.product_name || '商品',
        quantity: o.quantity || 1,
        amountText: (Number.isFinite(amt) ? amt : 0).toFixed(2),
        paidAtText: formatBeijingDateTimeFull(o.paid_at),
        loading: false,
        loadError: false
      });
    } catch (e) {
      this.setData({ loading: false, loadError: true });
    }
  },

  onBook() {
    const { shopId, productOrderId } = this.data;
    navigation.redirectTo('/pages/shop/book/index', {
      id: shopId,
      product_order_id: productOrderId
    });
  },

  onGoHub() {
    navigation.redirectTo('/pages/order/hub/index', { tab: 'product' });
  }
});
