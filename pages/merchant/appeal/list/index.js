// 商户申诉列表 - M09
const { getLogger } = require('../../../../utils/logger');
const ui = require('../../../../utils/ui');
const { getMerchantToken, getMerchantAppeals } = require('../../../../utils/api');
const { getNavBarHeight, getSystemInfo } = require('../../../../utils/util');
const { formatBeijingDateTimeShort, parseBackendDate } = require('../../../../utils/beijing-time');

const logger = getLogger('MerchantAppealList');

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    scrollStyle: 'height: 500px',
    tabIndex: 0,
    list: [],
    loading: false,
    empty: false
  },

  onLoad() {
    const navH = getNavBarHeight();
    const sys = getSystemInfo();
    this.setData({
      pageRootStyle: 'padding-top: ' + navH + 'px',
      scrollStyle: 'height: ' + (sys.windowHeight - navH - 100) + 'px'
    });
    this.checkAuth();
  },

  onShow() {
    if (getMerchantToken()) {
      this.loadList();
    }
  },

  onPullDownRefresh() {
    this.loadList().then(() => wx.stopPullDownRefresh());
  },

  checkAuth() {
    if (!getMerchantToken()) {
      wx.redirectTo({ url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/appeal/list/index') });
      return;
    }
    this.loadList();
  },

  onTabChange(e) {
    const idx = parseInt(e.currentTarget.dataset.index, 10);
    this.setData({ tabIndex: idx });
    this.loadList();
  },

  async loadList() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const params = { limit: 50 };
      if (this.data.tabIndex === 0) params.status = 0;
      const res = await getMerchantAppeals(params);
      const list = (res.list || []).map((item) => {
        const deadlineDt = parseBackendDate(item.deadline);
        return {
          ...item,
          deadline_short: formatBeijingDateTimeShort(item.deadline),
          is_overdue: !!(deadlineDt && deadlineDt.getTime() < Date.now())
        };
      });
      this.setData({
        list,
        loading: false,
        empty: list.length === 0
      });
    } catch (err) {
      logger.error('加载申诉列表失败', err);
      ui.showError(err.message || '加载失败');
      this.setData({ loading: false });
    }
  },

  onItemTap(e) {
    const { requestId, questionLabel, status } = e.currentTarget.dataset;
    if (!requestId || parseInt(status, 10) !== 0) return;
    wx.navigateTo({ url: '/pages/merchant/appeal/submit/index?requestId=' + encodeURIComponent(requestId) + '&questionLabel=' + encodeURIComponent(questionLabel || '') });
  }
});
