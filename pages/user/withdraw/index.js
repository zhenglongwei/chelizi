// pages/user/withdraw/index.js
const { getToken, getUserProfile, withdraw } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

Page({
  data: {
    balance: '0.00',
    amount: '',
    loading: false,
    pageRootStyle: 'padding-top: 88px'
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    if (!getToken()) {
      wx.navigateTo({ url: '/pages/auth/login/index?redirect=' + encodeURIComponent('/pages/user/withdraw/index') });
      return;
    }
    this.loadBalance();
  },

  async loadBalance() {
    try {
      const p = await getUserProfile();
      const b = (p && p.balance != null) ? Number(p.balance).toFixed(2) : '0.00';
      this.setData({ balance: b });
    } catch (e) {
      console.error(e);
    }
  },

  onAmountInput(e) {
    this.setData({ amount: e.detail.value });
  },

  onWithdrawAll() {
    this.setData({ amount: this.data.balance });
  },

  async onSubmit() {
    const amount = parseFloat(this.data.amount || '0');
    const balance = parseFloat(this.data.balance || '0');
    if (!amount || amount < 10) {
      wx.showToast({ title: '最低提现10元', icon: 'none' });
      return;
    }
    if (amount > balance) {
      wx.showToast({ title: '余额不足', icon: 'none' });
      return;
    }
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      await withdraw({ amount });
      this.setData({ loading: false });
      wx.showToast({ title: '提现申请已提交', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '提现失败', icon: 'none' });
    }
  }
});
