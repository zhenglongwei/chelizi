// 登录授权页 - 11-登录授权页
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const { getToken, setToken, authLogin } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

const logger = getLogger('AuthLogin');

Page({
  data: {
    agreed: false,
    loading: false,
    pageRootStyle: 'padding-top: 88px'
  },

  onLoad(options) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    const { redirect } = options || {};
    if (redirect) {
      this.redirect = decodeURIComponent(redirect);
    }
    if (getToken()) {
      this.doRedirect();
    }
  },

  onToggleAgree() {
    this.setData({ agreed: !this.data.agreed });
  },

  async onLogin() {
    const { agreed, loading } = this.data;
    if (!agreed || loading) return;

    this.setData({ loading: true });
    try {
      const code = await new Promise((resolve, reject) => {
        wx.login({
          success: (res) => resolve(res.code || ''),
          fail: reject
        });
      });
      if (!code) {
        ui.showError('获取登录码失败');
        this.setData({ loading: false });
        return;
      }
      const res = await authLogin(code);
      setToken(res.token);
      if (res.user) {
        wx.setStorageSync('user', res.user);
      }
      ui.showSuccess('登录成功');
      const needProfile = res.user && (!res.user.avatar_url || !res.user.nickname);
      if (needProfile) {
        const redirect = this.redirect || '/pages/user/index/index';
        setTimeout(() => {
          wx.redirectTo({
            url: '/pages/auth/profile/index?redirect=' + encodeURIComponent(redirect)
          });
        }, 800);
      } else {
        setTimeout(() => this.doRedirect(), 800);
      }
    } catch (err) {
      logger.error('登录失败', err);
      ui.showError(err.message || '登录失败');
      this.setData({ loading: false });
    }
  },

  doRedirect() {
    const redirect = this.redirect;
    const url = redirect && redirect.startsWith('/') ? redirect : '/pages/user/index/index';
    const pathOnly = url.split('?')[0];
    const tabPages = ['/pages/index/index', '/pages/user/index/index', '/pages/damage/upload/index'];
    if (tabPages.includes(pathOnly)) {
      wx.switchTab({ url: pathOnly });
    } else {
      wx.redirectTo({ url });
    }
  }
});
