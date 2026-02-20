// 消息页 - 12-消息页（系统/竞价/订单/评价消息）
const { getLogger } = require('../../utils/logger');
const ui = require('../../utils/ui');
const { getToken, getUserMessages, markMessagesRead, getUnreadCount } = require('../../utils/api');
const { getNavBarHeight, formatRelativeTime } = require('../../utils/util');

const logger = getLogger('Message');

// 消息类型文案（含奖励金到账、追评推送）
const TYPE_LABEL = {
  system: '系统',
  bidding: '竞价',
  order: '订单',
  review: '评价',
  reward: '奖励金',
  followup: '追评提醒'
};

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
    const sys = wx.getSystemInfoSync();
    this.setData({
      pageRootStyle: 'padding-top: ' + navH + 'px',
      scrollStyle: 'height: ' + (sys.windowHeight - navH - 20) + 'px'
    });
    this.checkToken();
  },

  onShow() {
    this.checkToken();
    if (this.data.hasToken) {
      this.loadList(true);
      this.updateTabBarBadge();
    }
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 });
    }
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
      const res = await getUserMessages({ page, limit: this.data.limit });
      const list = (res.list || []).map((item) => ({
        ...item,
        typeLabel: TYPE_LABEL[item.type] || '消息',
        timeText: formatRelativeTime(item.created_at)
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
      logger.error('加载消息失败', err);
      ui.showError(err.message || '加载失败');
      this.setData({ loading: false });
    }
  },

  async updateTabBarBadge() {
    if (!getToken()) return;
    try {
      const res = await getUnreadCount();
      const n = parseInt(res?.count ?? res?.unread_count ?? res ?? 0, 10) || 0;
      const tabBar = typeof this.getTabBar === 'function' && this.getTabBar();
      if (tabBar) tabBar.setData({ unreadCount: n });
    } catch {
      const tabBar = typeof this.getTabBar === 'function' && this.getTabBar();
      if (tabBar) tabBar.setData({ unreadCount: 0 });
    }
  },

  async onItemTap(e) {
    const { id: message_id, type, related: related_id, read: is_read } = e.currentTarget.dataset;

    if (message_id && (is_read === '0' || is_read === 0 || !is_read)) {
      try {
        await markMessagesRead({ message_ids: [message_id] });
        this.updateTabBarBadge();
      } catch (err) {
        logger.warn('标记已读失败', err);
      }
    }

    let url = '';
    if (type === 'bidding' && related_id) {
      url = '/pages/bidding/detail/index?id=' + related_id;
    } else if (type === 'order' && related_id) {
      url = '/pages/order/detail/index?id=' + related_id;
    } else if (type === 'review' && related_id) {
      url = '/pages/review/submit/index?orderId=' + related_id;
    } else if (type === 'followup' && related_id) {
      // 追评弹窗推送：related_id 为 order_id，跳转订单详情（追评入口在订单详情）
      url = '/pages/order/detail/index?id=' + related_id;
    } else if (type === 'reward' && related_id) {
      // 奖励金到账：跳转奖励金余额明细
      url = '/pages/user/balance/index';
    }

    if (url) {
      wx.navigateTo({ url });
    } else if (type === 'system') {
      ui.showWarning('系统消息暂无详情');
    } else if (type === 'reward') {
      wx.navigateTo({ url: '/pages/user/balance/index' });
    } else {
      ui.showWarning('内容已失效');
    }
  },

  onLoadMore() {
    if (!this.data.hasMore || this.data.loading) return;
    this.setData({ page: this.data.page + 1 }, () => this.loadList(false));
  },

  onPullDownRefresh() {
    this.loadList(true).then(() => {
      this.updateTabBarBadge();
      wx.stopPullDownRefresh();
    });
  }
});
