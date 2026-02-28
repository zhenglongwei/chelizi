// 服务商消息页 - 申诉、材料审核、竞价等站内消息
const { getMerchantMessages, markMerchantMessagesRead } = require('../../../utils/api');
const { getNavBarHeight, formatRelativeTime } = require('../../../utils/util');
const ui = require('../../../utils/ui');

const TYPE_LABEL = {
  evidence_request: '申诉',
  appeal_result: '申诉',
  material_audit: '材料审核',
  bidding: '竞价'
};

function getJumpUrl(type, relatedId) {
  if (!type) return '';
  if (type === 'evidence_request' || type === 'appeal_result') {
    return '/pages/merchant/appeal/list/index';
  }
  if (type === 'bidding' && relatedId) {
    return '/pages/merchant/bidding/detail/index?id=' + relatedId;
  }
  if (type === 'material_audit' && relatedId) {
    return '/pages/merchant/order/detail/index?id=' + relatedId;
  }
  return '';
}

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    scrollStyle: 'height: 600px',
    list: [],
    page: 1,
    limit: 10,
    total: 0,
    hasMore: true,
    loading: false
  },

  onLoad() {
    const navH = getNavBarHeight();
    const sys = wx.getSystemInfoSync();
    this.setData({
      pageRootStyle: 'padding-top: ' + navH + 'px',
      scrollStyle: 'height: ' + (sys.windowHeight - navH - 20) + 'px'
    });
    this.loadList(true);
  },

  onShow() {
    this.loadList(true);
  },

  async loadList(refresh) {
    if (this.data.loading) return;
    const page = refresh ? 1 : this.data.page;
    if (!refresh && !this.data.hasMore) return;

    this.setData({ loading: true });
    try {
      const res = await getMerchantMessages({ page, limit: this.data.limit });
      const rawList = res.list || [];
      const list = rawList.map((item) => ({
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
      ui.showError(err.message || '加载失败');
      this.setData({ loading: false });
    }
  },

  async onItemTap(e) {
    const { id: message_id, type, related: related_id, read: is_read } = e.currentTarget.dataset;

    if (message_id && (is_read === '0' || is_read === 0 || !is_read)) {
      try {
        await markMerchantMessagesRead({ message_ids: [message_id] });
      } catch (_) {}
    }

    const url = getJumpUrl(type, related_id);
    if (url) {
      wx.navigateTo({ url });
    } else {
      ui.showWarning('该消息暂无详情');
    }
  },

  onLoadMore() {
    if (!this.data.hasMore || this.data.loading) return;
    this.setData({ page: this.data.page + 1 }, () => this.loadList(false));
  }
});
