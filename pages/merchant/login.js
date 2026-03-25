// 服务商登录 - M01
const { getLogger } = require('../../utils/logger');
const ui = require('../../utils/ui');
const { getNavBarHeight } = require('../../utils/util');
const { merchantLogin, merchantWechatLogin, setMerchantToken, setMerchantUser } = require('../../utils/api');

const logger = getLogger('MerchantLogin');

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    phone: '',
    password: '',
    loading: false,
    checkingWechat: true,
    wechatLoading: false
  },

  onLoad(options) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    this.redirect = options.redirect ? decodeURIComponent(options.redirect) : '';
    this.attemptWechatAutoLogin();
  },

  redirectTarget() {
    return this.redirect && this.redirect.startsWith('/') ? this.redirect : '/pages/merchant/home';
  },

  /** 进入页时若 merchant_users.openid 与当前微信一致则直接登录 */
  async attemptWechatAutoLogin() {
    this.setData({ checkingWechat: true });
    try {
      const code = await new Promise((resolve, reject) => {
        wx.login({ success: (r) => resolve((r && r.code) || ''), fail: reject });
      });
      if (!code) {
        this.setData({ checkingWechat: false });
        return;
      }
      const res = await merchantWechatLogin({ code });
      setMerchantToken(res.token);
      if (res.user) setMerchantUser(res.user);
      ui.showSuccess('登录成功');
      const target = this.redirectTarget();
      setTimeout(() => {
        wx.redirectTo({ url: target });
      }, 800);
    } catch (err) {
      logger.warn('服务商微信自动登录未命中', err);
      this.setData({ checkingWechat: false });
    }
  },

  async onWechatQuickLogin() {
    if (this.data.wechatLoading || this.data.loading) return;
    this.setData({ wechatLoading: true });
    try {
      const code = await new Promise((resolve, reject) => {
        wx.login({ success: (r) => resolve((r && r.code) || ''), fail: reject });
      });
      if (!code) {
        ui.showError('获取登录码失败');
        return;
      }
      const res = await merchantWechatLogin({ code });
      setMerchantToken(res.token);
      if (res.user) setMerchantUser(res.user);
      ui.showSuccess('登录成功');
      const target = this.redirectTarget();
      setTimeout(() => {
        wx.redirectTo({ url: target });
      }, 800);
    } catch (err) {
      logger.error('服务商微信登录失败', err);
      ui.showError(err.message || '登录失败');
    } finally {
      this.setData({ wechatLoading: false });
    }
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
      const target = this.redirectTarget();
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
  },

  onForgotPassword() {
    wx.navigateTo({ url: '/pages/merchant/forgot-password' });
  }
});
