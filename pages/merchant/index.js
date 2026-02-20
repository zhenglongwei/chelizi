// 服务商管理入口页 - 设置→服务商注册/登录 可跳转至此（TabBar 服务商为维修厂搜索列表）
const { getNavBarHeight } = require('../../utils/util');

Page({
  data: {
    pageRootStyle: 'padding-top: 88px'
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
  }
});
