// 竞价邀请列表 - M04
const { getLogger } = require('../../../../utils/logger');
const ui = require('../../../../utils/ui');
const { getMerchantToken, getMerchantBiddings } = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');

const logger = getLogger('MerchantBiddingList');

function formatCountdown(expireAt) {
  if (!expireAt) return '--';
  const end = new Date(expireAt).getTime();
  const diff = end - Date.now();
  if (diff <= 0) return '已结束';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 0) return `${h}小时后`;
  if (m > 0) return `${m}分钟后`;
  return '即将结束';
}

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
          countdown_text: formatCountdown(item.expire_at),
          created_short: item.created_at ? String(item.created_at).slice(0, 16).replace('T', ' ') : '',
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
