// 完善资料 - 头像昵称填写（微信头像昵称填写能力）
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const { getNavBarHeight } = require('../../../utils/util');
const { getToken, updateUserProfile, uploadImage, getUserProfile, authPhoneByCode, authPhoneBySms, getUserVehicles } = require('../../../utils/api');

const logger = getLogger('Profile');

Page({
  data: {
    avatarUrl: '',
    nickname: '',
    phone: '',
    phoneManualMode: false,
    phoneInput: '',
    vehicleCount: 0,
    canSubmit: false,
    loading: false,
    pageRootStyle: 'padding-top: 88px'
  },

  onLoad(options) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    const opts = options || {};
    this.redirect = opts.redirect ? decodeURIComponent(opts.redirect) : '/pages/user/index/index';
    if (!getToken()) {
      wx.redirectTo({ url: '/pages/auth/login/index' });
      return;
    }
    this.loadCurrentProfile();
  },

  async loadCurrentProfile() {
    try {
      const [profile, vehiclesRes] = await Promise.all([
        getUserProfile(),
        getUserVehicles().catch(() => ({ list: [] }))
      ]);
      if (profile) {
        const phone = profile.phone || '';
        const masked = phone ? (phone.slice(0, 3) + '****' + phone.slice(-4)) : '';
        this.setData({
          avatarUrl: profile.avatar_url || '',
          nickname: profile.nickname || '',
          phone: masked || '',
          phoneRaw: phone,
          vehicleCount: (vehiclesRes?.list || []).length,
          canSubmit: !!(profile.avatar_url || profile.nickname)
        });
      }
    } catch (err) {
      logger.warn('加载资料失败', err);
    }
  },

  async onGetPhoneNumber(e) {
    const { code, errMsg } = e.detail || {};
    if (code) {
      try {
        ui.showLoading('获取中...');
        const res = await authPhoneByCode(code);
        ui.hideLoading();
        ui.showSuccess('手机号已绑定');
        this.loadCurrentProfile();
      } catch (err) {
        ui.hideLoading();
        ui.showError(err.message || '获取失败');
      }
      return;
    }
    if (errMsg && errMsg.includes('deny') || errMsg?.includes('fail')) {
      this.setData({ phoneManualMode: true });
      ui.showToast('您已拒绝授权，可手动输入手机号', 'none', 2000);
    }
  },

  onPhoneInput(e) {
    this.setData({ phoneInput: (e.detail.value || '').trim() });
  },

  async onVerifyPhoneBySms() {
    const { phoneInput } = this.data;
    if (!/^1\d{10}$/.test(phoneInput)) {
      ui.showError('请输入正确的11位手机号');
      return;
    }
    try {
      await authPhoneBySms(phoneInput, '');
    } catch (err) {
      ui.showError(err.message || '验证失败');
    }
  },

  onChooseAvatar(e) {
    const { avatarUrl } = e.detail || {};
    if (!avatarUrl) return;
    this.setData({ avatarUrl, canSubmit: true });
    logger.info('选择头像', { avatarUrl });
  },

  onNicknameInput(e) {
    const nickname = e.detail.value || '';
    this.setData({ nickname, canSubmit: !!nickname.trim() || !!this.data.avatarUrl });
  },

  async onSubmit() {
    const { avatarUrl, nickname } = this.data;
    const nick = (nickname || '').trim();

    if (!nick && !avatarUrl) {
      ui.showError('请至少设置头像或昵称');
      return;
    }

    this.setData({ loading: true });
    try {
      let avatarUrlFinal = avatarUrl;
      if (avatarUrl && !avatarUrl.startsWith('https://')) {
        ui.showLoading('上传头像中...');
        avatarUrlFinal = await uploadImage(avatarUrl);
        ui.hideLoading();
      }

      const updateData = {};
      if (nick) updateData.nickname = nick;
      if (avatarUrlFinal) updateData.avatar_url = avatarUrlFinal;

      await updateUserProfile(updateData);
      const user = wx.getStorageSync('user') || {};
      if (updateData.nickname) user.nickname = updateData.nickname;
      if (updateData.avatar_url) user.avatar_url = updateData.avatar_url;
      wx.setStorageSync('user', user);

      ui.showSuccess('保存成功');
      logger.info('资料保存成功', updateData);

      const pathOnly = this.redirect.split('?')[0];
      const tabPages = ['/pages/index/index', '/pages/user/index/index', '/pages/damage/upload/index'];
      if (tabPages.includes(pathOnly)) {
        wx.switchTab({ url: this.redirect });
      } else {
        wx.redirectTo({ url: this.redirect });
      }
    } catch (err) {
      logger.error('保存失败', err);
      ui.showError(err.message || '保存失败');
    } finally {
      this.setData({ loading: false });
    }
  }
});
