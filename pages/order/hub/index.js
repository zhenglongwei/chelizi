// 我的订单（维修 + 标品）
const { getToken, getUserOrders, getUserProductOrders } = require('../../../utils/api');
const navigation = require('../../../utils/navigation');
const ui = require('../../../utils/ui');
const { getNavBarHeight, getSystemInfo } = require('../../../utils/util');
const { formatBeijingDateTimeShort, formatBeijingDateTimeFull } = require('../../../utils/beijing-time');

const STATUS_MAP = { 0: '待接单', 1: '维修中', 2: '待确认', 3: '已完成', 4: '已取消' };

Page({
  data: {
    tab: 'repair',
    scrollStyle: 'height: 600px',
    hasToken: false,
    status: '',
    repairList: [],
    repairPage: 1,
    repairLimit: 10,
    repairTotal: 0,
    repairHasMore: true,
    repairLoading: false,
    productList: [],
    productLoading: false,
    pageRootStyle: 'padding-top: 88px'
  },

  onLoad(options) {
    const navH = getNavBarHeight();
    const sys = getSystemInfo();
    const tabRaw = (options.tab || 'repair').toLowerCase();
    const tab = tabRaw === 'product' ? 'product' : 'repair';
    const status =
      options.status !== undefined && options.status !== null ? String(options.status) : '';
    this.setData({
      tab,
      status,
      pageRootStyle: 'padding-top: ' + navH + 'px',
      scrollStyle: 'height: ' + (sys.windowHeight - navH - 140) + 'px'
    });
    if (!getToken()) {
      ui.showWarning('请先登录');
      setTimeout(
        () =>
          navigation.redirectTo('/pages/auth/login/index', {
            redirect: '/pages/order/hub/index?tab=' + tab
          }),
        400
      );
      return;
    }
    this.setData({ hasToken: true });
    this.loadActiveTab(true);
  },

  onShow() {
    if (getToken()) {
      this.setData({ hasToken: true });
    }
  },

  onMainTab(e) {
    const t = e.currentTarget.dataset.tab;
    if (!t || t === this.data.tab) return;
    this.setData({ tab: t }, () => this.loadActiveTab(true));
  },

  loadActiveTab(refresh) {
    if (this.data.tab === 'repair') this.loadRepairList(refresh);
    else this.loadProductList();
  },

  onRepairFilterTap(e) {
    const status = (e.currentTarget.dataset.status || '').toString();
    if (status === this.data.status) return;
    this.setData({ status });
    this.loadRepairList(true);
  },

  async loadRepairList(refresh) {
    if (!getToken()) return;
    if (this.data.repairLoading) return;
    const page = refresh ? 1 : this.data.repairPage;
    if (!refresh && !this.data.repairHasMore) return;

    this.setData({ repairLoading: true });
    try {
      const params = { page, limit: this.data.repairLimit };
      if (this.data.status !== '') params.status = this.data.status;
      const res = await getUserOrders(params);
      const st = this.data.status;
      const list = (res.list || []).map((item) => ({
        ...item,
        statusText:
          st === 'to_review'
            ? '待评价'
            : st === 'completed' && item.status === 3
              ? '已评价'
              : STATUS_MAP[item.status] || '未知',
        created_at: formatBeijingDateTimeShort(item.created_at)
      }));
      const prevList = refresh ? [] : this.data.repairList;
      const newList = [...prevList, ...list];
      const total = res.total || 0;
      const hasMore = newList.length < total;

      this.setData({
        repairList: newList,
        repairPage: page,
        repairTotal: total,
        repairHasMore: hasMore,
        repairLoading: false
      });
    } catch (err) {
      console.error('加载维修订单失败', err);
      this.setData({ repairLoading: false });
    }
  },

  onRepairLoadMore() {
    if (!this.data.repairHasMore || this.data.repairLoading) return;
    this.setData({ repairPage: this.data.repairPage + 1 }, () => this.loadRepairList(false));
  },

  onRepairItemTap(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/order/detail/index?id=' + id });
  },

  async loadProductList() {
    if (!getToken()) return;
    this.setData({ productLoading: true });
    try {
      const res = await getUserProductOrders({ page: 1, limit: 50 });
      const raw = res.list || [];
      const productList = raw.map((r) => ({
        ...r,
        paid: r.payment_status === 'paid',
        statusLabel:
          r.payment_status === 'paid' ? '已支付' : r.payment_status === 'pending_pay' ? '待支付' : r.payment_status,
        amountText: parseFloat(r.amount_total).toFixed(2),
        paidAtText: formatBeijingDateTimeFull(r.paid_at)
      }));
      this.setData({ productList, productLoading: false });
    } catch (e) {
      ui.showError(e.message || '加载失败');
      this.setData({ productLoading: false });
    }
  },

  onProductBook(e) {
    const shopId = (e.currentTarget.dataset.shopId || '').trim();
    const poid = (e.currentTarget.dataset.poid || '').trim();
    if (!shopId || !poid) return;
    navigation.navigateTo('/pages/shop/book/index', { id: shopId, product_order_id: poid });
  },

  onPullDownRefresh() {
    this.loadActiveTab(true);
    setTimeout(() => wx.stopPullDownRefresh(), 400);
  }
});
