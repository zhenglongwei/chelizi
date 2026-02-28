// 服务商工作台 - M03
const { getLogger } = require('../../utils/logger');
const ui = require('../../utils/ui');
const { getMerchantToken, getMerchantUser, getMerchantDashboard, getMerchantShop } = require('../../utils/api');
const { getNavBarHeight } = require('../../utils/util');

const logger = getLogger('MerchantHome');

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
    pendingConfirm: 0
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
  },

  onShow() {
    if (!getMerchantToken()) {
      wx.redirectTo({ url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/home') });
      return;
    }
    const user = getMerchantUser();
    this.setData({ shopName: (user && user.shop_name) || '' });
    this.loadDashboard();
  },

  async loadDashboard() {
    try {
      const res = await getMerchantDashboard();
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
      this.setData({
        qualificationStatus: status,
        qualificationSubmitted: submitted,
        qualificationAuditReason: res.qualification_audit_reason || '',
        shopInfoStatusText,
        pendingBidding: res.pending_bidding_count || 0,
        pendingOrder: res.pending_order_count || 0,
        repairing: res.repairing_count || 0,
        pendingConfirm: res.pending_confirm_count || 0
      });
    } catch (err) {
      logger.error('加载工作台失败', err);
      ui.showError(err.message || '加载失败');
    }
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

  onMessageTap() {
    wx.navigateTo({ url: '/pages/merchant/message/index' });
  },

  onAppealTap() {
    wx.navigateTo({ url: '/pages/merchant/appeal/list/index' });
  }
});
