// 已合并到「我的订单」hub；保留路径以兼容旧链接
const ui = require('../../../../utils/ui');
const { getToken } = require('../../../../utils/api');
const navigation = require('../../../../utils/navigation');

Page({
  onLoad() {
    if (!getToken()) {
      ui.showWarning('请先登录');
      setTimeout(
        () =>
          navigation.redirectTo('/pages/auth/login/index', {
            redirect: '/pages/order/hub/index?tab=product'
          }),
        400
      );
      return;
    }
    wx.redirectTo({ url: '/pages/order/hub/index?tab=product' });
  }
});
