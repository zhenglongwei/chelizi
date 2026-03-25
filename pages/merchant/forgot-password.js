// 服务商找回密码
const { getLogger } = require('../../utils/logger');
const ui = require('../../utils/ui');
const { getNavBarHeight } = require('../../utils/util');
const { merchantResetPassword } = require('../../utils/api');

const logger = getLogger('MerchantForgotPassword');

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    phone: '',
    newPassword: '',
    confirmPassword: '',
    loading: false
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
  },

  onPhoneInput(e) {
    this.setData({ phone: (e.detail.value || '').trim() });
  },

  onNewPasswordInput(e) {
    this.setData({ newPassword: e.detail.value || '' });
  },

  onConfirmPasswordInput(e) {
    this.setData({ confirmPassword: e.detail.value || '' });
  },

  async onSubmit() {
    const { phone, newPassword, confirmPassword, loading } = this.data;
    if (!phone || !newPassword || !confirmPassword) {
      ui.showWarning('请填写手机号与新密码');
      return;
    }
    if (!/^1\d{10}$/.test(phone)) {
      ui.showWarning('手机号格式不正确');
      return;
    }
    if (newPassword.length < 6) {
      ui.showWarning('新密码至少 6 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      ui.showWarning('两次新密码不一致');
      return;
    }
    if (loading) return;

    this.setData({ loading: true });
    try {
      let code = '';
      try {
        code = await new Promise((resolve, reject) => {
          wx.login({ success: (r) => resolve((r && r.code) || ''), fail: reject });
        });
      } catch (e) {
        logger.error('wx.login 失败', e);
        ui.showError('获取微信校验失败，请重试');
        this.setData({ loading: false });
        return;
      }
      if (!code) {
        ui.showError('获取登录码失败');
        this.setData({ loading: false });
        return;
      }
      await merchantResetPassword({
        phone,
        new_password: newPassword,
        code
      });
      ui.showSuccess('密码已重置，请使用新密码登录');
      setTimeout(() => {
        wx.navigateBack();
      }, 1200);
    } catch (err) {
      logger.error('服务商重置密码失败', err);
      ui.showError(err.message || '重置失败');
      this.setData({ loading: false });
    }
  }
});
