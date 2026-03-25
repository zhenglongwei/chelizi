// 商品直购确认与微信支付
const { getLogger } = require('../../../../utils/logger');
const ui = require('../../../../utils/ui');
const navigation = require('../../../../utils/navigation');
const { getShopDetail, createUserProductOrder, prepayUserProductOrder, getToken } = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');

const logger = getLogger('ProductConfirm');

function formatPrice(n) {
  const x = parseFloat(n);
  if (isNaN(x)) return '0.00';
  return x.toFixed(2);
}

Page({
  data: {
    shopId: '',
    productId: '',
    shopName: '',
    product: null,
    quantity: 1,
    totalText: '0.00',
    loading: true,
    paying: false,
    pageRootStyle: 'padding-top: 88px'
  },

  onLoad(options) {
    const shopId = (options.shop_id || options.shopId || '').trim();
    const productId = (options.product_id || options.productId || '').trim();
    const navH = getNavBarHeight();
    this.setData({ shopId, productId, pageRootStyle: 'padding-top: ' + navH + 'px' });
    if (!shopId || !productId) {
      ui.showError('参数错误');
      setTimeout(() => navigation.navigateBack(), 1500);
      return;
    }
    this.loadProduct();
  },

  async loadProduct() {
    const { shopId, productId } = this.data;
    this.setData({ loading: true });
    try {
      const shop = await getShopDetail(shopId);
      const list = shop.products || [];
      const raw = list.find((p) => p.product_id === productId);
      if (!raw) {
        this.setData({ loading: false, product: null });
        ui.showError('商品已下架或不存在');
        return;
      }
      const imgs = raw.images || [];
      const product = {
        ...raw,
        cover: imgs[0] || '',
        priceText: formatPrice(raw.price)
      };
      const qty = this.data.quantity;
      const total = formatPrice(parseFloat(raw.price) * qty);
      this.setData({
        shopName: shop.name || '',
        product,
        totalText: total,
        loading: false
      });
    } catch (e) {
      logger.error('loadProduct', e);
      ui.showError(e.message || '加载失败');
      this.setData({ loading: false, product: null });
    }
  },

  recalcTotal() {
    const { product, quantity } = this.data;
    if (!product) return;
    const total = formatPrice(parseFloat(product.price) * quantity);
    this.setData({ totalText: total });
  },

  onQtyMinus() {
    const q = Math.max(1, (this.data.quantity || 1) - 1);
    this.setData({ quantity: q }, () => this.recalcTotal());
  },

  onQtyPlus() {
    const q = Math.min(99, (this.data.quantity || 1) + 1);
    this.setData({ quantity: q }, () => this.recalcTotal());
  },

  async runJsapiPay(prepayPayload) {
    const { timeStamp, nonceStr, package: pkg, signType, paySign } = prepayPayload;
    return new Promise((resolve, reject) => {
      wx.requestPayment({
        timeStamp,
        nonceStr,
        package: pkg,
        signType: signType || 'RSA',
        paySign,
        success: () => resolve(),
        fail: (err) => reject(new Error(err.errMsg || '支付取消'))
      });
    });
  },

  async onPay() {
    if (!getToken()) {
      ui.showWarning('请先登录');
      navigation.navigateTo('/pages/auth/login/index', {
        redirect: '/pages/shop/product/confirm/index?shop_id=' + this.data.shopId + '&product_id=' + this.data.productId
      });
      return;
    }
    const { shopId, productId, quantity, paying } = this.data;
    if (paying || !productId) return;
    this.setData({ paying: true });
    try {
      const order = await createUserProductOrder({
        shop_id: shopId,
        product_id: productId,
        quantity
      });
      const poid = order.product_order_id;
      if (!poid) throw new Error('创建订单失败');

      const login = await new Promise((resolve, reject) => {
        wx.login({ success: (r) => resolve(r.code), fail: reject });
      });
      const prepay = await prepayUserProductOrder(poid, login);
      await this.runJsapiPay(prepay);
      navigation.redirectTo('/pages/shop/product/success/index', {
        shop_id: shopId,
        product_order_id: poid
      });
    } catch (e) {
      logger.error('onPay', e);
      ui.showError(e.message || '支付失败');
    } finally {
      this.setData({ paying: false });
    }
  }
});
