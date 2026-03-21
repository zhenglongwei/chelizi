// 服务商佣金钱包 / 微信支付 / 明细
const ui = require('../../../utils/ui');
const {
  getMerchantToken,
  getMerchantCommissionWallet,
  putMerchantCommissionDeductMode,
  getMerchantCommissionLedger,
  merchantCommissionRechargePrepay,
  merchantCommissionPayOrderPrepay,
  merchantCommissionFinalize,
  merchantCommissionRefund,
  getMerchantOrders,
  merchantUploadImage,
} = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');
const { requestMerchantSubscribe } = require('../../../utils/subscribe');

function isMerchant401(err) {
  return !!(err && err.statusCode === 401);
}

function fmtMoney(n) {
  const x = parseFloat(n);
  if (Number.isNaN(x)) return '0.00';
  return x.toFixed(2);
}

Page({
  data: {
    pageRootStyle: '',
    walletBalance: '0.00',
    walletFrozen: '0.00',
    modeLabel: '自动扣余额',
    deductMode: 'auto',
    ledger: [],
    pendingOrders: [],
    rechargeAmount: '500',
    refundAmount: '',
    finalizeOrderId: '',
    finalizeAmount: '',
    proofUrls: [],
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
  },

  onShow() {
    if (!getMerchantToken()) {
      wx.redirectTo({
        url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/commission/index'),
      });
      return;
    }
    requestMerchantSubscribe('commission_alert');
    this.refreshAll();
  },

  async refreshAll() {
    try {
      await Promise.all([this.loadWallet(), this.loadLedger(), this.loadPendingOrders()]);
    } catch (e) {
      ui.showError(e.message || '加载失败');
    }
  },

  async loadWallet() {
    const w = await getMerchantCommissionWallet();
    const mode = w.deduct_mode || 'auto';
    this.setData({
      walletBalance: fmtMoney(w.balance),
      walletFrozen: fmtMoney(w.frozen),
      deductMode: mode,
      modeLabel: mode === 'per_order' ? '逐单微信支付' : '自动扣余额',
    });
  },

  async loadLedger() {
    const res = await getMerchantCommissionLedger({ page: 1, limit: 30 });
    const list = (res.list || []).map((r) => ({
      ...r,
      created_at: r.created_at ? String(r.created_at).slice(0, 19) : '',
    }));
    this.setData({ ledger: list });
  },

  async loadPendingOrders() {
    const res = await getMerchantOrders({ status: 3, limit: 30, page: 1 });
    const list = (res.list || []).filter((o) => ['awaiting_pay', 'arrears'].includes(o.commission_status));
    const pending = list.map((o) => {
      const due = parseFloat(o.commission_final) || parseFloat(o.commission_provisional) || 0;
      const paid = parseFloat(o.commission_paid_amount) || 0;
      const need = Math.round((due - paid) * 100) / 100;
      return { ...o, needPay: fmtMoney(need) };
    });
    this.setData({ pendingOrders: pending });
  },

  onRechargeInput(e) {
    this.setData({ rechargeAmount: e.detail.value });
  },

  onRefundInput(e) {
    this.setData({ refundAmount: e.detail.value });
  },

  onFinOrderInput(e) {
    this.setData({ finalizeOrderId: e.detail.value });
  },

  onFinAmtInput(e) {
    this.setData({ finalizeAmount: e.detail.value });
  },

  async onSetMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (!mode) return;
    try {
      wx.showLoading({ title: '保存中' });
      await putMerchantCommissionDeductMode(mode);
      wx.hideLoading();
      wx.showToast({ title: '已更新', icon: 'success' });
      await this.loadWallet();
    } catch (err) {
      wx.hideLoading();
      if (isMerchant401(err)) return;
      ui.showError(err.message || '失败');
    }
  },

  async wxLoginCode() {
    return new Promise((resolve, reject) => {
      wx.login({
        success: (r) => (r.code ? resolve(r.code) : reject(new Error('无 code'))),
        fail: reject,
      });
    });
  },

  async runJsapiPay(prepayPayload) {
    const { timeStamp, nonceStr, package: pkg, signType, paySign } = prepayPayload;
    await new Promise((resolve, reject) => {
      wx.requestPayment({
        timeStamp,
        nonceStr,
        package: pkg,
        signType: signType || 'RSA',
        paySign,
        success: resolve,
        fail: reject,
      });
    });
  },

  async onRecharge() {
    try {
      const amt = parseFloat(this.data.rechargeAmount);
      if (!(amt >= 1)) {
        ui.showError('请输入不少于 1 元的金额');
        return;
      }
      wx.showLoading({ title: '下单中' });
      const code = await this.wxLoginCode();
      const prepay = await merchantCommissionRechargePrepay(amt, code);
      wx.hideLoading();
      await this.runJsapiPay(prepay);
      wx.showToast({ title: '支付成功', icon: 'success' });
      await this.refreshAll();
    } catch (err) {
      wx.hideLoading();
      if (err.errMsg && String(err.errMsg).indexOf('cancel') >= 0) return;
      if (isMerchant401(err)) return;
      ui.showError(err.message || err.errMsg || '支付失败');
    }
  },

  async onPayOrder(e) {
    const orderId = e.currentTarget.dataset.id;
    if (!orderId) return;
    try {
      wx.showLoading({ title: '下单中' });
      const code = await this.wxLoginCode();
      const prepay = await merchantCommissionPayOrderPrepay(orderId, code);
      wx.hideLoading();
      await this.runJsapiPay(prepay);
      wx.showToast({ title: '支付成功', icon: 'success' });
      await this.refreshAll();
    } catch (err) {
      wx.hideLoading();
      if (err.errMsg && String(err.errMsg).indexOf('cancel') >= 0) return;
      if (isMerchant401(err)) return;
      ui.showError(err.message || err.errMsg || '支付失败');
    }
  },

  async onRefund() {
    const amt = parseFloat(this.data.refundAmount);
    if (!(amt > 0)) {
      ui.showError('请输入退款金额');
      return;
    }
    try {
      wx.showLoading({ title: '处理中' });
      await merchantCommissionRefund(amt);
      wx.hideLoading();
      wx.showToast({ title: '已提交退款', icon: 'success' });
      await this.refreshAll();
    } catch (err) {
      wx.hideLoading();
      if (isMerchant401(err)) return;
      ui.showError(err.message || '失败');
    }
  },

  async onPickProof() {
    try {
      const r = await new Promise((resolve, reject) => {
        wx.chooseImage({
          count: 3,
          sizeType: ['compressed'],
          sourceType: ['album', 'camera'],
          success: resolve,
          fail: reject,
        });
      });
      const paths = r.tempFilePaths || [];
      wx.showLoading({ title: '上传中' });
      const urls = [];
      for (const p of paths) {
        urls.push(await merchantUploadImage(p));
      }
      wx.hideLoading();
      this.setData({ proofUrls: (this.data.proofUrls || []).concat(urls) });
    } catch (err) {
      wx.hideLoading();
      if (isMerchant401(err)) return;
      ui.showError(err.message || '上传失败');
    }
  },

  async onFinalize() {
    const orderId = (this.data.finalizeOrderId || '').trim();
    const actual = parseFloat(this.data.finalizeAmount);
    if (!orderId) {
      ui.showError('请填写订单号');
      return;
    }
    if (Number.isNaN(actual) || actual <= 0) {
      ui.showError('请填写实际维修金额');
      return;
    }
    try {
      wx.showLoading({ title: '提交中' });
      await merchantCommissionFinalize(orderId, {
        actual_amount: actual,
        payment_proof_urls: this.data.proofUrls || [],
      });
      wx.hideLoading();
      wx.showToast({ title: '已提交', icon: 'success' });
      this.setData({ finalizeOrderId: '', finalizeAmount: '', proofUrls: [] });
      await this.refreshAll();
    } catch (err) {
      wx.hideLoading();
      if (isMerchant401(err)) return;
      ui.showError(err.message || '失败');
    }
  },
});
