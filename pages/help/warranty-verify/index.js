const { verifyWarrantyCard } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');
const ui = require('../../../utils/ui');

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    orderId: '',
    antiFakeCode: '',
    loading: false,
    result: null
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
  },

  onOrderInput(e) {
    this.setData({ orderId: (e.detail.value || '').trim(), result: null });
  },

  onCodeInput(e) {
    this.setData({ antiFakeCode: (e.detail.value || '').trim(), result: null });
  },

  async onVerify() {
    const orderId = (this.data.orderId || '').trim();
    const antiFakeCode = (this.data.antiFakeCode || '').trim();
    if (!orderId || !antiFakeCode) {
      ui.showWarning('请填写订单号与存证防伪码');
      return;
    }
    this.setData({ loading: true, result: null });
    try {
      const data = await verifyWarrantyCard({ order_id: orderId, anti_fake_code: antiFakeCode });
      const gen = data.generated_at;
      if (gen) data.generated_at = String(gen).slice(0, 19).replace('T', ' ');
      this.setData({
        loading: false,
        result: { ok: true, ...data }
      });
      ui.showSuccess('核验通过');
    } catch (e) {
      this.setData({
        loading: false,
        result: { ok: false, message: (e && e.message) || '核验失败' }
      });
    }
  }
});
