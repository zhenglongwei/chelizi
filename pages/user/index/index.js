// pages/user/index/index.js
const ui = require('../../../utils/ui');
const { getToken, getMerchantToken, getUserProfile, updateUserProfile, uploadImage } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

function formatMoney(v) {
  if (v == null || v === '' || isNaN(v)) return '0.00';
  return Number(v).toFixed(2);
}

Page({
  data: {
    hasToken: false,
    hasMerchantToken: false,
    userInfo: {},
    needCompleteProfile: false,
    balanceText: '0.00',
    totalRebateText: '0.00',
    locationAddress: '',
    locationShort: '',
    pageRootStyle: 'padding-top: 88px'
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    this.checkToken();
  },

  onShow() {
    this.checkToken();
    if (this.data.hasToken) {
      this.loadProfile();
    }
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 4 });
    }
  },

  checkToken() {
    const hasToken = !!getToken();
    const hasMerchantToken = !!getMerchantToken();
    this.setData({ hasToken, hasMerchantToken });
  },

  async loadProfile() {
    if (!getToken()) return;
    try {
      const profile = await getUserProfile();
      const userInfo = profile || {};
      const balanceText = formatMoney(userInfo.balance);
      const totalRebateText = formatMoney(userInfo.total_rebate);
      const needCompleteProfile = !userInfo.avatar_url || !userInfo.nickname;
      let locationAddress = '';
      let locationShort = '';
      try {
        const stored = wx.getStorageSync('user_chosen_location');
        if (stored && stored.address) {
          locationAddress = stored.address || stored.name || '';
        }
        if (!locationAddress && userInfo.location) {
          const loc = userInfo.location;
          locationAddress = [loc.province, loc.city, loc.district].filter(Boolean).join('') || '';
        }
        const app = getApp();
        if (!locationAddress && app.globalData && app.globalData.location) {
          const loc = app.globalData.location;
          locationAddress = loc.address || loc.name || '';
        }
        if (locationAddress) {
          locationShort = locationAddress.length > 6 ? locationAddress.slice(0, 6) + '…' : locationAddress;
        }
      } catch (_) {}
      this.setData({
        userInfo: {
          nickname: userInfo.nickname,
          avatar_url: userInfo.avatar_url,
          level: userInfo.level
        },
        needCompleteProfile,
        balanceText,
        totalRebateText,
        locationAddress,
        locationShort
      });
    } catch (err) {
      console.error('加载用户信息失败', err);
    }
  },

  async onChooseLocation() {
    if (!getToken()) return;
    const app = getApp();
    try {
      const loc = await app.chooseLocation();
      if (!loc || loc.latitude == null || loc.longitude == null) return;
      const addr = loc.address || loc.name || '已选择位置';
      const short = addr.length > 6 ? addr.slice(0, 6) + '…' : addr;
      this.setData({ locationAddress: addr, locationShort: short });
      await updateUserProfile({ latitude: loc.latitude, longitude: loc.longitude });
      ui.showSuccess('已更新位置');
    } catch (err) {
      if (err.errMsg && !err.errMsg.includes('cancel')) {
        ui.showError('选择位置失败');
      }
    }
  },

  onWithdraw() {
    if (!getToken()) {
      wx.navigateTo({ url: '/pages/auth/login/index?redirect=%2Fpages%2Fuser%2Findex%2Findex' });
      return;
    }
    wx.navigateTo({ url: '/pages/user/withdraw/index' });
  }
});
