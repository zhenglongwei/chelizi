// 我的订单列表
const { getToken, getUserOrders } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

const STATUS_MAP = { 0: '待接单', 1: '维修中', 2: '待确认', 3: '已完成', 4: '已取消' };

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

Page({
  data: {
    scrollStyle: 'height: 600px',
    hasToken: false,
    status: '',
    list: [],
    page: 1,
    limit: 10,
    total: 0,
    hasMore: true,
    loading: false,
    pageRootStyle: 'padding-top: 88px'
  },

  onLoad(options) {
    const navH = getNavBarHeight();
    const sys = wx.getSystemInfoSync();
    this.setData({ pageRootStyle: 'padding-top: ' + navH + 'px', scrollStyle: 'height: ' + (sys.windowHeight - navH - 20) + 'px' });
    const status = options.status || '';
    this.setData({ status });
    this.checkToken();
  },

  onShow() {
    this.checkToken();
  },

  checkToken() {
    const hasToken = !!getToken();
    this.setData({ hasToken });
    if (hasToken) this.loadList(true);
  },

  async loadList(refresh) {
    if (!getToken()) return;
    if (this.data.loading) return;
    const page = refresh ? 1 : this.data.page;
    if (!refresh && !this.data.hasMore) return;

    this.setData({ loading: true });
    try {
      const params = { page, limit: this.data.limit };
      if (this.data.status !== '') params.status = this.data.status;
      const res = await getUserOrders(params);
      const list = (res.list || []).map((item) => ({
        ...item,
        statusText: STATUS_MAP[item.status] || '未知',
        created_at: formatDate(item.created_at)
      }));
      const prevList = refresh ? [] : this.data.list;
      const newList = [...prevList, ...list];
      const total = res.total || 0;
      const hasMore = newList.length < total;

      this.setData({
        list: newList,
        page,
        total,
        hasMore,
        loading: false
      });
    } catch (err) {
      console.error('加载订单失败', err);
      this.setData({ loading: false });
    }
  },

  onTabTap(e) {
    const status = (e.currentTarget.dataset.status || '').toString();
    if (status === this.data.status) return;
    this.setData({ status });
    this.loadList(true);
  },

  onLoadMore() {
    if (!this.data.hasMore || this.data.loading) return;
    this.setData({ page: this.data.page + 1 }, () => this.loadList(false));
  },

  onItemTap(e) {
    const id = e.currentTarget.dataset.id;
    if (id) {
      wx.navigateTo({ url: '/pages/order/detail/index?id=' + id });
    }
  },

  onPullDownRefresh() {
    this.loadList(true).finally(() => wx.stopPullDownRefresh());
  }
});
