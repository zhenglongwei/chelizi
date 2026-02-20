// 奖励金余额明细页 - 14-奖励金余额明细页
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const { getToken, getUserBalance } = require('../../../utils/api');
const { getNavBarHeight, formatRelativeTime } = require('../../../utils/util');

const logger = getLogger('Balance');

const TYPE_LABEL = {
  rebate: '评价奖励金',
  withdraw: '提现',
  recharge: '充值',
  refund: '提现退回'
};

const STAGE_LABEL = { main: '主评价', '1m': '1个月追评', '3m': '3个月追评' };

function formatMoney(v) {
  if (v == null || v === '' || isNaN(v)) return '0.00';
  return Number(v).toFixed(2);
}

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    scrollStyle: 'height: 500px',
    balanceText: '0.00',
    totalRebateText: '0.00',
    canWithdraw: false,
    list: [],
    page: 1,
    limit: 10,
    total: 0,
    hasMore: true,
    loading: false
  },

  onLoad() {
    const navH = getNavBarHeight();
    this.setData({ pageRootStyle: 'padding-top: ' + navH + 'px' });
    const sys = wx.getSystemInfoSync();
    this.setData({ scrollStyle: 'height: ' + (sys.windowHeight - navH - 280) + 'px' });
    this.checkAuth();
  },

  onShow() {
    this.checkAuth();
    if (this.data.hasToken) this.loadData(true);
  },

  checkAuth() {
    const hasToken = !!getToken();
    this.setData({ hasToken });
    if (!hasToken) {
      navigation.redirectTo('/pages/auth/login/index', { redirect: '/pages/user/balance/index' });
    }
  },

  async loadData(refresh) {
    if (!getToken()) return;
    if (this.data.loading) return;
    const page = refresh ? 1 : this.data.page;
    if (!refresh && !this.data.hasMore) return;

    this.setData({ loading: true });
    try {
      const res = await getUserBalance({ page, limit: this.data.limit });
      const list = (res.list || []).map((row) => {
        const stageLabel = row.review_stage ? (STAGE_LABEL[row.review_stage] || row.review_stage) : '';
        const taxLabel = row.tax_deducted > 0 ? '代扣个税 ¥' + formatMoney(row.tax_deducted) : (row.type === 'rebate' && row.amount <= 800 ? '无需扣税' : '');
        return {
          ...row,
          typeLabel: TYPE_LABEL[row.type] || row.type || '其他',
          amountText: (row.amount >= 0 ? '+' : '') + formatMoney(row.amount),
          isIncome: row.amount >= 0,
          timeText: formatRelativeTime(row.created_at),
          stageLabel,
          taxLabel
        };
      });
      const prevList = refresh ? [] : this.data.list;
      const newList = [...prevList, ...list];
      const total = res.total || 0;
      const hasMore = newList.length < total;

      const balanceNum = parseFloat(res.balance) || 0;
      this.setData({
        balanceText: formatMoney(res.balance),
        totalRebateText: formatMoney(res.total_rebate),
        canWithdraw: balanceNum >= 10,
        list: newList,
        page,
        total,
        hasMore,
        loading: false
      });
    } catch (err) {
      logger.error('加载余额明细失败', err);
      ui.showError(err.message || '加载失败');
      this.setData({ loading: false });
    }
  },

  onWithdraw() {
    const balance = parseFloat(this.data.balanceText || '0');
    if (balance < 10) {
      ui.showWarning('至少 10 元可提现');
      return;
    }
    navigation.navigateTo('/pages/user/withdraw/index');
  },

  onLoadMore() {
    if (!this.data.hasMore || this.data.loading) return;
    this.setData({ page: this.data.page + 1 }, () => this.loadData(false));
  },

  onPullDownRefresh() {
    this.loadData(true).finally(() => wx.stopPullDownRefresh());
  }
});
