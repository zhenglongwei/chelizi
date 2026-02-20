// 服务商订单列表 - M06
const { getLogger } = require('../../../../utils/logger');
const ui = require('../../../../utils/ui');
const { getMerchantToken, getMerchantOrders } = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');

const logger = getLogger('MerchantOrderList');

const STATUS_MAP = { 0: '待接单', 1: '维修中', 2: '待确认', 3: '已完成', 4: '已取消' };

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    tabIndex: -1,
    list: [],
    total: 0,
    page: 1,
    limit: 10,
    loading: false,
    hasMore: true,
    empty: false
  },

  onLoad(options) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    const status = options.status !== undefined ? parseInt(options.status, 10) : -1;
    this.setData({ tabIndex: status });
    this.checkAuth();
  },

  onShow() {
    if (getMerchantToken()) {
      this.setData({ list: [], page: 1, hasMore: true });
      this.loadList();
    }
  },

  onPullDownRefresh() {
    this.setData({ list: [], page: 1, hasMore: true });
    this.loadList().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadList();
  },

  checkAuth() {
    if (!getMerchantToken()) {
      wx.redirectTo({ url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/order/list/index') });
      return;
    }
    this.loadList();
  },

  onTabChange(e) {
    const idx = parseInt(e.currentTarget.dataset.index, 10);
    this.setData({ tabIndex: idx, list: [], page: 1, hasMore: true });
    this.loadList();
  },

  async loadList() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const status = this.data.tabIndex >= 0 ? this.data.tabIndex : undefined;
      const res = await getMerchantOrders({
        page: this.data.page,
        limit: this.data.limit,
        status
      });
      const rawList = res.list || [];
      const list = rawList.map((item) => ({
        ...item,
        status_text: STATUS_MAP[item.status] || '未知',
        created_short: item.created_at ? item.created_at.slice(0, 16).replace('T', ' ') : ''
      }));
      const merged = this.data.page === 1 ? list : [...this.data.list, ...list];
      const hasMore = merged.length < (res.total || 0);
      this.setData({
        list: merged,
        total: res.total || 0,
        hasMore,
        page: this.data.page + 1,
        loading: false,
        empty: merged.length === 0
      });
    } catch (err) {
      logger.error('加载订单列表失败', err);
      ui.showError(err.message || '加载失败');
      this.setData({ loading: false });
    }
  },

  onItemTap(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/merchant/order/detail/index?id=' + id });
  }
});
