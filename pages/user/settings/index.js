// 设置页 - 13-设置页
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const { getToken, setToken } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

const logger = getLogger('Settings');

Page({
  data: {
    pageRootStyle: 'padding-top: 88px'
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    this.checkAuth();
  },

  onShow() {
    this.checkAuth();
  },

  checkAuth() {
    const hasToken = !!getToken();
    this.setData({ hasToken });
    if (!hasToken) {
      navigation.redirectTo('/pages/auth/login/index', { redirect: '/pages/user/settings/index' });
    }
  },

  onAccount() {
    ui.showWarning('账号编辑功能开发中，敬请期待');
  },

  onAbout() {
    ui.showConfirm({
      title: '关于我们',
      content: '车厘子 - 事故车维修点评平台\n专业、透明、省心的维修服务',
      confirmText: '知道了',
      showCancel: false
    });
  },

  onAgreement() {
    ui.showConfirm({
      title: '用户协议',
      content: '请在使用前阅读并同意《车厘子用户服务协议》。协议内容可在小程序内查看。',
      confirmText: '知道了',
      showCancel: false
    });
  },

  onPrivacy() {
    ui.showConfirm({
      title: '隐私政策',
      content: '我们重视您的隐私，收集的信息仅用于提供服务。详见《车厘子隐私政策》。',
      confirmText: '知道了',
      showCancel: false
    });
  },

  onLogout() {
    ui.showConfirm({
      title: '退出登录',
      content: '确定要退出登录吗？',
      confirmText: '退出',
      confirmColor: '#EF4444',
      success: (res) => {
        if (res.confirm) {
          setToken('');
          wx.removeStorageSync('user');
          wx.removeStorageSync('userInfo');
          this.setData({ hasToken: false });
          logger.info('用户已退出登录');
          ui.showSuccess('已退出');
          setTimeout(() => navigation.switchTab('/pages/user/index/index'), 800);
        }
      }
    });
  }
});
