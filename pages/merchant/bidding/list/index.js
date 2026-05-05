// 竞价邀请列表 - M04
const { getLogger } = require('../../../../utils/logger');
const ui = require('../../../../utils/ui');
const { getMerchantToken, getMerchantBiddings } = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');
const { requestMerchantSubscribe } = require('../../../../utils/subscribe');
const { formatBeijingDateTimeShort, formatExpireCountdown } = require('../../../../utils/beijing-time');

const logger = getLogger('MerchantBiddingList');

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    tabIndex: 0,
    list: [],
    total: 0,
    page: 1,
    limit: 10,
    loading: false,
    hasMore: true,
    empty: false
  },

  onLoad(options) {
    const tabIndex = options.status === 'quoted' ? 1 : options.status === 'ended' ? 2 : 0;
    this.setData(
      { pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px', tabIndex },
      () => this.checkAuth()
    );
  },

  onShow() {
    if (getMerchantToken()) {
      this.setData({ list: [], page: 1, hasMore: true });
      this.loadList();
      if (this.data.tabIndex === 0) requestMerchantSubscribe('bidding_new');
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
      wx.redirectTo({ url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/bidding/list/index') });
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
      const statusMap = ['pending', 'quoted', 'ended'];
      const status = statusMap[this.data.tabIndex] || 'pending';
      const res = await getMerchantBiddings({
        page: this.data.page,
        limit: this.data.limit,
        status
      });
      const rawList = res.list || [];
      const list = rawList.map((item) => {
        let quoteStatusText = '';
        if (item.my_quote_status === 1) quoteStatusText = '成交';
        else if (item.my_quote_status === 2) quoteStatusText = '已失效';
        const vi = item.vehicle_info || {};
        const vehicleDisplay = [vi.brand, vi.model, vi.plate_number].filter(Boolean).join(' ') || '未知车辆';
        return Object.assign({}, item, {
          vehicle_info: vi,
          vehicle_display: vehicleDisplay,
          countdown_text: formatExpireCountdown(item.expire_at),
          created_short: formatBeijingDateTimeShort(item.created_at),
          quote_status_text: quoteStatusText
        });
      });
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
      logger.error('加载竞价列表失败', err);
      ui.showError(err.message || '加载失败');
      this.setData({ loading: false });
    }
  },

  onItemTap(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/merchant/bidding/detail/index?id=' + id });
  }
});
