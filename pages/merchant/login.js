// 服务商登录 - M01
const { getLogger } = require('../../utils/logger');
const ui = require('../../utils/ui');
const { getNavBarHeight } = require('../../utils/util');
const { merchantLogin, setMerchantToken, setMerchantUser } = require('../../utils/api');

const logger = getLogger('MerchantLogin');

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    phone: '',
    password: '',
    loading: false
  },

  onLoad(options) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    this.redirect = options.redirect ? decodeURIComponent(options.redirect) : '';
  },

  onPhoneInput(e) {
    this.setData({ phone: (e.detail.value || '').trim() });
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value || '' });
  },

  async onSubmit() {
    const { phone, password, loading } = this.data;
    if (!phone || !password) {
      ui.showWarning('请填写手机号和密码');
      return;
    }
    if (!/^1\d{10}$/.test(phone)) {
      ui.showWarning('手机号格式不正确');
      return;
    }
    if (loading) return;

    this.setData({ loading: true });
    try {
      const res = await merchantLogin({ phone, password });
      setMerchantToken(res.token);
      if (res.user) setMerchantUser(res.user);
      ui.showSuccess('登录成功');
      const target = this.redirect && this.redirect.startsWith('/') ? this.redirect : '/pages/merchant/home';
      setTimeout(() => {
        wx.redirectTo({ url: target });
      }, 800);
    } catch (err) {
      logger.error('服务商登录失败', err);
      ui.showError(err.message || '登录失败');
      this.setData({ loading: false });
    }
  },

  onToRegister() {
    wx.navigateTo({ url: '/pages/merchant/register' });
  }
});
