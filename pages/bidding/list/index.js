// 我的竞价列表 - 09-我的竞价列表页
const { getToken, getUserBiddings, endBidding } = require('../../../utils/api');
const { getNavBarHeight, getSystemInfo } = require('../../../utils/util');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');

const STATUS_MAP = { 0: '询价中', 1: '已关闭', 2: '已取消' };

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatCountdown(expireAt) {
  if (!expireAt) return '--';
  const end = new Date(expireAt).getTime();
  const now = Date.now();
  const diff = end - now;
  if (diff <= 0) return '窗口已截止';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分钟`;
  return '即将结束';
}

/** 截止时间已到（与 status 是否已落库无关，用于列表展示一致） */
function isExpireAtPassed(expireAt) {
  if (!expireAt) return false;
  const t = new Date(expireAt).getTime();
  return t > 0 && t <= Date.now();
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
    const sys = getSystemInfo();
    this.setData({ pageRootStyle: 'padding-top: ' + navH + 'px', scrollStyle: 'height: ' + (sys.windowHeight - navH - 20) + 'px' });
    const status = (options.status ?? '').toString();
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
      if (this.data.status !== '') params.status = parseInt(this.data.status, 10);
      const res = await getUserBiddings(params);
      const list = (res.list || []).map((item) => {
        const vi = item.vehicle_info || {};
        const title = vi.plate_number || vi.model || vi.brand || '车辆';
        const timeExpired = isExpireAtPassed(item.expire_at);
        const isOngoing = item.status === 0 && !timeExpired;
        const isSelectingPhase = item.status === 0 && timeExpired && !item.selected_shop_id;
        let statusText = STATUS_MAP[item.status] || '未知';
        if (item.status === 0 && timeExpired) statusText = '待选厂';
        let badgeVariant = 'ended';
        if (isOngoing) badgeVariant = 'ongoing';
        else if (isSelectingPhase) badgeVariant = 'selecting';
        const metaTimeLabel = isOngoing ? '剩余' : isSelectingPhase ? '询价截止' : '结束';
        let metaTimeValue = isOngoing ? formatCountdown(item.expire_at) : formatDate(item.expire_at);
        if (isSelectingPhase) metaTimeValue = '窗口已截止';
        const showEndRound = item.status === 0 && !item.selected_shop_id;
        const canRecreate =
          (item.status === 1 || (item.status === 0 && timeExpired)) && !item.selected_shop_id;
        return {
          ...item,
          statusText,
          title,
          created_at: formatDate(item.created_at),
          expire_at_fmt: formatDate(item.expire_at),
          metaTimeLabel,
          metaTimeValue,
          isOngoing,
          isSelectingPhase,
          badgeVariant,
          showEndRound,
          canRecreate
        };
      });
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
      console.error('加载竞价失败', err);
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
    if (id) wx.navigateTo({ url: '/pages/bidding/detail/index?id=' + id });
  },

  onViewQuotesTap(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/bidding/detail/index?id=' + id });
  },

  onEndBiddingTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showModal({
      title: '结束本轮比价',
      content: '确定结束吗？结束后不能再选厂，当前所有报价将作废。',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await endBidding(id);
          ui.showSuccess('已结束本轮');
          this.loadList(true);
        } catch (err) {
          ui.showError(err.message || '操作失败');
        }
      }
    });
  },

  onRecreateTap(e) {
    const reportId = e.currentTarget.dataset.reportId;
    if (!reportId) return;
    wx.showModal({
      title: '重新发起询价',
      content:
        '将使用同一份定损报告开启新一轮询价。若当前轮仍在进行中或窗口已截止但未关单，会先结束本轮并作废已有报价。确认前往定损页补充信息后发起？',
      confirmText: '前往',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return;
        wx.setStorageSync('pendingReportId', reportId);
        navigation.switchTab('/pages/damage/upload/index');
      }
    });
  },

  onOrderTap(e) {
    const orderId = e.currentTarget.dataset.orderId;
    if (orderId) wx.navigateTo({ url: '/pages/order/detail/index?id=' + orderId });
  },

  onPullDownRefresh() {
    this.loadList(true).finally(() => wx.stopPullDownRefresh());
  }
});
