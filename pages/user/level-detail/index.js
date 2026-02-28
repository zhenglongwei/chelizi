// 等级详情 - 升级进度、权益、保级条件
const { getNavBarHeight } = require('../../../utils/util');
const { getToken, getUserLevelDetail } = require('../../../utils/api');

Page({
  data: {
    loading: true,
    pageRootStyle: 'padding-top: 88px',
    detail: null,
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    if (!getToken()) {
      wx.redirectTo({ url: '/pages/auth/login/index' });
      return;
    }
    this.loadDetail();
  },

  async loadDetail() {
    try {
      const detail = await getUserLevelDetail();
      this.setData({ detail, loading: false });
    } catch (err) {
      console.error('加载等级详情失败', err);
      this.setData({ loading: false });
    }
  },

  onPullDownRefresh() {
    this.loadDetail().then(() => wx.stopPullDownRefresh());
  },
});
