// 完善资料 - 头像昵称填写（微信头像昵称填写能力）
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const { getNavBarHeight } = require('../../../utils/util');
const { getToken, updateUserProfile, uploadImage, getUserProfile, authPhoneByCode, authPhoneBySms, getUserVehicles } = require('../../../utils/api');

const logger = getLogger('Profile');

/** 未点「保存」时的头像/昵称草稿，避免去车辆页返回后被 loadCurrentProfile 覆盖 */
const PROFILE_DRAFT_KEY = 'profile_edit_draft';

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
    this._skipVehicleRefreshOnce = true;
    this.loadCurrentProfile();
  },

  onShow() {
    if (!getToken()) return;
    // 首次展示已在 onLoad 中拉全量；之后从车辆页返回只刷新手机号与车辆数，不覆盖未保存的头像/昵称
    if (this._skipVehicleRefreshOnce) {
      this._skipVehicleRefreshOnce = false;
      return;
    }
    this.refreshPhoneAndVehiclesOnly();
  },

  saveDraftToStorage() {
    try {
      const { avatarUrl, nickname } = this.data;
      wx.setStorageSync(PROFILE_DRAFT_KEY, {
        avatarUrl: avatarUrl || '',
        nickname: nickname || '',
        ts: Date.now()
      });
    } catch (_) {}
  },

  readDraftFromStorage() {
    try {
      return wx.getStorageSync(PROFILE_DRAFT_KEY) || null;
    } catch (_) {
      return null;
    }
  },

  clearDraftStorage() {
    try {
      wx.removeStorageSync(PROFILE_DRAFT_KEY);
    } catch (_) {}
  },

  /** 仅同步手机号、车辆数（供 onShow 使用） */
  async refreshPhoneAndVehiclesOnly() {
    try {
      const [profile, vehiclesRes] = await Promise.all([
        getUserProfile(),
        getUserVehicles().catch(() => ({ list: [] }))
      ]);
      if (!profile) return;
      const phone = profile.phone || '';
      const masked = phone ? (phone.slice(0, 3) + '****' + phone.slice(-4)) : '';
      this.setData({
        phone: masked || '',
        phoneRaw: phone,
        vehicleCount: (vehiclesRes?.list || []).length
      });
    } catch (err) {
      logger.warn('刷新手机号/车辆数失败', err);
    }
  },

  applyDraftOverServer(avatarFromServer, nicknameFromServer) {
    const draft = this.readDraftFromStorage();
    if (!draft || !draft.ts) {
      return { avatarUrl: avatarFromServer || '', nickname: nicknameFromServer || '' };
    }
    return {
      avatarUrl: draft.avatarUrl !== undefined ? draft.avatarUrl : (avatarFromServer || ''),
      nickname: draft.nickname !== undefined ? draft.nickname : (nicknameFromServer || '')
    };
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
        const merged = this.applyDraftOverServer(profile.avatar_url, profile.nickname);
        this.setData({
          avatarUrl: merged.avatarUrl,
          nickname: merged.nickname,
          phone: masked || '',
          phoneRaw: phone,
          vehicleCount: (vehiclesRes?.list || []).length,
          canSubmit: !!(merged.avatarUrl || (merged.nickname && merged.nickname.trim()))
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
        await authPhoneByCode(code);
        ui.hideLoading();
        ui.showSuccess('手机号已绑定');
        // 合并草稿，避免刷新覆盖未保存的头像/昵称
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
    this.saveDraftToStorage();
    logger.info('选择头像', { avatarUrl });
  },

  onNicknameInput(e) {
    const nickname = e.detail.value || '';
    this.setData({ nickname, canSubmit: !!nickname.trim() || !!this.data.avatarUrl });
    this.saveDraftToStorage();
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
      this.clearDraftStorage();

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
