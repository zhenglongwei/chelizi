// 定损历史记录
const { getToken, getDamageReports } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}
const navigation = require('../../../utils/navigation');

Page({
  data: {
    scrollStyle: 'height: 600px',
    hasToken: false,
    list: [],
    page: 1,
    limit: 10,
    total: 0,
    hasMore: true,
    loading: false,
    pageRootStyle: 'padding-top: 88px'
  },

  onLoad() {
    const navH = getNavBarHeight();
    this.setData({ pageRootStyle: 'padding-top: ' + navH + 'px', scrollStyle: 'height: ' + (wx.getSystemInfoSync().windowHeight - navH - 20) + 'px' });
    this.checkToken();
  },

  onShow() {
    this.checkToken();
    if (this.data.hasToken && this.data.list.length === 0) {
      this.loadList(true);
    }
  },

  onPullDownRefresh() {
    this.loadList(true).finally(() => wx.stopPullDownRefresh());
  },

  checkToken() {
    const hasToken = !!getToken();
    this.setData({ hasToken });
    if (hasToken) {
      this.loadList(true);
    }
  },

  async loadList(refresh) {
    if (!getToken()) return;
    if (this.data.loading) return;

    const page = refresh ? 1 : this.data.page;
    if (!refresh && !this.data.hasMore) return;

    this.setData({ loading: true });
    try {
      const res = await getDamageReports({ page, limit: this.data.limit });
      const list = res.list || [];
      const total = res.total || 0;
      const prevList = refresh ? [] : this.data.list;
      const newList = [...prevList, ...list];
      const hasMore = newList.length < total;
      const formatted = newList.map((item) => ({
        ...item,
        created_at: item.created_at ? formatDate(item.created_at) : ''
      }));

      this.setData({
        list: formatted,
        page,
        total,
        hasMore,
        loading: false
      });
    } catch (err) {
      console.error('加载定损历史失败', err);
      this.setData({ loading: false });
    }
  },

  onLoadMore() {
    if (!this.data.hasMore || this.data.loading) return;
    this.setData({ page: this.data.page + 1 }, () => this.loadList(false));
  },

  onItemTap(e) {
    const id = e.currentTarget.dataset.id;
    if (id) {
      wx.setStorageSync('pendingReportId', id);
      navigation.switchTab('/pages/damage/upload/index');
    }
  }
});
