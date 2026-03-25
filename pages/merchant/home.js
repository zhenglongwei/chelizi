// 服务商工作台 - M03
const { getLogger } = require('../../utils/logger');
const ui = require('../../utils/ui');
const {
  getMerchantToken,
  getMerchantUser,
  getMerchantDashboard,
  getMerchantShop,
  merchantBindOpenid,
  getMerchantUnreadCount,
  getMerchantCommissionWallet
} = require('../../utils/api');
const { getNavBarHeight } = require('../../utils/util');
const { requestMerchantSubscribe } = require('../../utils/subscribe');

const logger = getLogger('MerchantHome');

/** 首页得分分档：绿 ≥80、橙 60–79、红 <60；重大违规≥2 强制红 */
function buildScorePresentation(detail) {
  if (!detail || detail.score == null) {
    return { scoreTierClass: '', scoreTip: '' };
  }
  const score = Number(detail.score);
  const major = Number(detail.major_violation_count) || 0;
  if (major >= 2) {
    return {
      scoreTierClass: 'merchant-score-tier-low',
      scoreTip: '因重大违规累计达阈值，综合得分已清零，请尽快处理合规与申诉事项。'
    };
  }
  if (major === 1) {
    return {
      scoreTierClass: score >= 80 ? 'merchant-score-tier-mid' : 'merchant-score-tier-low',
      scoreTip: '已存在重大违规记录，再发生一次将面临得分清零。请查看构成并尽快申诉或整改。'
    };
  }
  if (score >= 80) {
    return {
      scoreTierClass: 'merchant-score-tier-high',
      scoreTip: '表现优秀，请保持服务质量与合规，稳住口碑与排序优势。'
    };
  }
  if (score >= 60) {
    return {
      scoreTierClass: 'merchant-score-tier-mid',
      scoreTip: '尚有提升空间，查看构成分项，针对性优化评价与硬指标。'
    };
  }
  return {
    scoreTierClass: 'merchant-score-tier-low',
    scoreTip: '得分偏低，请查看构成与规则，优先处理扣分项与店铺资料。'
  };
}

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    shopName: '',
    qualificationStatus: 1,
    qualificationSubmitted: false,
    qualificationAuditReason: '',
    shopInfoStatusText: '',
    pendingBidding: 0,
    pendingOrder: 0,
    repairing: 0,
    pendingConfirm: 0,
    messageUnreadCount: 0,
    commissionBalanceText: '',
    /** GET /api/v1/merchant/dashboard 返回的 shop_score_detail */
    scoreDetail: null,
    scoreTierClass: '',
    scoreTip: ''
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
  },

  onShow() {
    if (!getMerchantToken()) {
      wx.redirectTo({ url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/home') });
      return;
    }
    // 从支付页返回等场景下，栈底页可能收到 onShow；避免在非当前页请求工作台导致误报「令牌无效」
    try {
      const pages = getCurrentPages();
      const top = pages[pages.length - 1];
      if (!top || top.route !== 'pages/merchant/home') {
        return;
      }
    } catch (_) {}
    const user = getMerchantUser();
    this.setData({ shopName: (user && user.shop_name) || '' });
    this.loadDashboard();
    this.bindOpenid();
    requestMerchantSubscribe('order_new');
  },

  async bindOpenid() {
    try {
      const { code } = await new Promise((resolve, reject) => {
        wx.login({ success: (r) => resolve(r), fail: reject });
      });
      if (code) await merchantBindOpenid(code);
    } catch (_) {}
  },

  async loadDashboard() {
    try {
      const [res, wallet] = await Promise.all([
        getMerchantDashboard(),
        getMerchantCommissionWallet().catch(() => null)
      ]);
      let qualificationStatus = res.qualification_status;
      let submitted = res.qualification_submitted === true;
      if (qualificationStatus == null || submitted === undefined) {
        const shop = await getMerchantShop();
        if (qualificationStatus == null) qualificationStatus = shop.qualification_status;
        if (submitted === undefined) submitted = !!(shop.qualification_level && String(shop.qualification_level).trim()) || !!(shop.technician_certs && (Array.isArray(shop.technician_certs) ? shop.technician_certs.length : shop.technician_certs));
      }
      const status = (qualificationStatus === 1 || qualificationStatus === '1') ? 1 : ((qualificationStatus === 2 || qualificationStatus === '2') ? 2 : 0);
      let shopInfoStatusText = '查看/编辑本店';
      if (status === 0 && !submitted) shopInfoStatusText = '去补充';
      else if (status === 0 && submitted) shopInfoStatusText = '审核中';
      else if (status === 2) shopInfoStatusText = '去修改';

      let commissionBalanceText = '';
      if (wallet) {
        const parts = [];
        if (wallet.balance != null && !Number.isNaN(Number(wallet.balance))) {
          parts.push(`佣金 ¥${Number(wallet.balance).toFixed(2)}`);
        }
        const inc = wallet.income_balance != null ? Number(wallet.income_balance) : 0;
        if (!Number.isNaN(inc) && inc > 0) {
          parts.push(`货款 ¥${inc.toFixed(2)}`);
        }
        if (parts.length) commissionBalanceText = parts.join(' · ');
      }

      const scoreDetail = res.shop_score_detail || null;
      const pres = buildScorePresentation(scoreDetail);

      this.setData({
        qualificationStatus: status,
        qualificationSubmitted: submitted,
        qualificationAuditReason: res.qualification_audit_reason || '',
        shopInfoStatusText,
        pendingBidding: res.pending_bidding_count || 0,
        pendingOrder: res.pending_order_count || 0,
        repairing: res.repairing_count || 0,
        pendingConfirm: res.pending_confirm_count || 0,
        commissionBalanceText,
        scoreDetail,
        scoreTierClass: pres.scoreTierClass,
        scoreTip: pres.scoreTip
      });
      this.loadMessageUnreadCount();
    } catch (err) {
      logger.error('加载工作台失败', err);
      if (err && err.statusCode === 401) return;
      ui.showError(err.message || '加载失败');
    }
  },

  async loadMessageUnreadCount() {
    try {
      const res = await getMerchantUnreadCount();
      const n = parseInt(res?.count ?? res?.unread_count ?? 0, 10) || 0;
      this.setData({ messageUnreadCount: n });
    } catch (_) {}
  },

  onBiddingTap(e) {
    const status = (e.currentTarget.dataset.status || 'pending');
    wx.navigateTo({ url: '/pages/merchant/bidding/list/index?status=' + status });
  },

  onOrderTap() {
    wx.navigateTo({ url: '/pages/merchant/order/list/index' });
  },

  onShopTap() {
    wx.navigateTo({ url: '/pages/merchant/shop/profile/index' });
  },

  onCommissionTap() {
    wx.navigateTo({ url: '/pages/merchant/commission/index' });
  },

  onMessageTap() {
    wx.navigateTo({ url: '/pages/merchant/message/index' });
  },

  onAppealTap() {
    wx.navigateTo({ url: '/pages/merchant/appeal/list/index' });
  },

  onProductTap() {
    wx.navigateTo({ url: '/pages/merchant/product/list/index' });
  },

  onProductOrderTap() {
    wx.navigateTo({ url: '/pages/merchant/product-order/list/index' });
  },

  onOpenScoreDetail() {
    wx.navigateTo({ url: '/pages/merchant/score/index' });
  }
});
