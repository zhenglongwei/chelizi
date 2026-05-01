// pages/user/index/index.js
const ui = require('../../../utils/ui');
const {
  getToken,
  getMerchantToken,
  setMerchantToken,
  setMerchantUser,
  getUserProfile,
  updateUserProfile,
  uploadImage,
  merchantCheckOpenid,
  merchantWechatLogin,
  getUserBookingOptionsAll,
  bindReferrer
} = require('../../../utils/api');
const { runUserBookingFlow } = require('../../../utils/user-booking-flow');
const { fetchAndApplyUnreadBadge, applyUnreadToTabBar } = require('../../../utils/message-badge');
const { getNavBarHeight } = require('../../../utils/util');
const { showWechatShareMenu } = require('../../../utils/show-share-menu');

function formatMoney(v) {
  if (v == null || v === '' || isNaN(v)) return '0.00';
  return Number(v).toFixed(2);
}

Page({
  data: {
    hasToken: false,
    hasMerchantToken: false,
    /** 车主已登录且本地无 merchant_token，且已检测 openid 已绑定服务商 */
    merchantOpenidBound: false,
    merchantEntryShopName: '',
    merchantEntryPending: false,
    merchantWechatLoading: false,
    userInfo: {},
    balanceText: '0.00',
    totalRebateText: '0.00',
    locationAddress: '',
    locationShort: '',
    pageRootStyle: 'padding-top: 88px'
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    /** 用于识别「刚完成车主登录」：首次进入本页为 false，与当前是否带 token 比较 */
    this._hadUserTokenBeforeShow = false;
    this.checkToken();
  },

  onShow() {
    showWechatShareMenu();
    this.checkToken();
    const hasToken = !!getToken();
    /** 由未登录变为已登录（含冷启动首次展示且本地已有 token） */
    const justAuthorized = hasToken && !this._hadUserTokenBeforeShow;
    this._hadUserTokenBeforeShow = hasToken;

    if (getMerchantToken()) {
      this.setData({ merchantOpenidBound: false });
    } else if (hasToken && justAuthorized) {
      this.refreshMerchantOpenidEntry();
    } else if (!hasToken) {
      this.setData({ merchantOpenidBound: false });
    }

    if (this.data.hasToken) {
      this.tryBindPendingReferrer();
      this.loadProfile();
      this.refreshUnreadTabBadge();
    }
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 });
    }
  },

  /** 车主已登录后：检测当前微信 openid 是否已注册为服务商，再决定是否展示入口 */
  async refreshMerchantOpenidEntry() {
    try {
      const code = await new Promise((resolve, reject) => {
        wx.login({ success: (r) => resolve((r && r.code) || ''), fail: reject });
      });
      if (!code) {
        this.setData({ merchantOpenidBound: false });
        return;
      }
      const res = await merchantCheckOpenid({ code });
      if (res && res.is_merchant) {
        this.setData({
          merchantOpenidBound: true,
          merchantEntryShopName: res.shop_name || '',
          merchantEntryPending: res.merchant_status === 0
        });
      } else {
        this.setData({ merchantOpenidBound: false });
      }
    } catch (_) {
      this.setData({ merchantOpenidBound: false });
    }
  },

  async refreshUnreadTabBadge() {
    if (!getToken()) {
      applyUnreadToTabBar(0);
      return;
    }
    await fetchAndApplyUnreadBadge();
  },

  checkToken() {
    const hasToken = !!getToken();
    const hasMerchantToken = !!getMerchantToken();
    const patch = { hasToken, hasMerchantToken };
    if (!hasToken) {
      patch.merchantOpenidBound = false;
      applyUnreadToTabBar(0);
    }
    this.setData(patch);
  },

  /** 分享落地参数 ?ref= 推荐人 user_id，登录后自动绑定一次 */
  async tryBindPendingReferrer() {
    let rid = '';
    try {
      rid = wx.getStorageSync('pending_referrer_user_id') || '';
    } catch (_) {}
    rid = String(rid).trim();
    if (!rid || !getToken()) return;
    try {
      await bindReferrer(rid);
      wx.removeStorageSync('pending_referrer_user_id');
    } catch (err) {
      const msg = (err && err.message) || '';
      if (msg.includes('已绑定')) {
        wx.removeStorageSync('pending_referrer_user_id');
      }
    }
  },

  async loadProfile() {
    if (!getToken()) return;
    try {
      const profile = await getUserProfile();
      const userInfo = profile || {};
      const balanceText = formatMoney(userInfo.balance);
      const totalRebateText = formatMoney(userInfo.total_rebate);
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
        if (locationAddress) {
          locationShort = locationAddress.length > 6 ? locationAddress.slice(0, 6) + '…' : locationAddress;
        }
      } catch (_) {}
      this.setData({
        userInfo: {
          nickname: userInfo.nickname,
          avatar_url: userInfo.avatar_url,
          level: userInfo.level,
          level_name: userInfo.level_name,
          needs_verification: userInfo.needs_verification
        },
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
  },

  /** 与维修厂详情「立即预约」同一套逻辑，数据为全平台可预约项 */
  async onUserBookTap() {
    await runUserBookingFlow({
      context: 'global',
      fetchBookingOptions: () => getUserBookingOptionsAll(),
      loginRedirect: '/pages/user/index/index'
    });
  },

  /** 当前微信已绑定服务商但本地无 token：微信登录后进入工作台 */
  async onMerchantWechatQuickEnter() {
    if (this.data.merchantEntryPending) {
      ui.showWarning('账号审核中，请耐心等待');
      return;
    }
    if (this.data.merchantWechatLoading) return;
    this.setData({ merchantWechatLoading: true });
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
      this.setData({
        hasMerchantToken: true,
        merchantOpenidBound: false,
        merchantWechatLoading: false
      });
      wx.navigateTo({ url: '/pages/merchant/home' });
    } catch (err) {
      ui.showError((err && err.message) || '登录失败');
      this.setData({ merchantWechatLoading: false });
    }
  },

  /** 代理人分销：从「我的」分享小程序，好友打开后带 ref 可绑定推荐人 */
  onShareAppMessage() {
    const { buildReferralSharePath, SHARE_TITLES } = require('../../../utils/referral-share');
    return {
      title: SHARE_TITLES.invite,
      path: buildReferralSharePath('/pages/index/index')
    };
  }
});
