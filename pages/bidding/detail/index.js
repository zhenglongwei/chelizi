// 竞价报价页 - 03-竞价报价页
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const { getToken, getBiddingDetail, getBiddingQuotes, selectBiddingShop, seedDevQuotes } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

const logger = getLogger('BiddingDetail');

function formatAmount(v) {
  if (v == null || v === '' || isNaN(v)) return '0.00';
  return Number(v).toFixed(2);
}

function formatCountdown(expireAt) {
  if (!expireAt) return '--';
  const end = new Date(expireAt).getTime();
  const now = Date.now();
  const diff = end - now;
  if (diff <= 0) return '已结束';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

Page({
  data: {
    biddingId: '',
    bidding: null,
    quotes: [],
    sortType: 'default',
    loading: true,
    error: '',
    hasToken: false,
    countdownText: '--',
    countdownExpired: false,
    reportExpanded: false,
    expandedQuoteId: '',
    showConfirm: false,
    confirmQuote: null,
    selecting: false,
    selectedShopId: '',
    redirectUrl: '',
    pageRootStyle: 'padding-top: 88px',
    scrollStyle: 'height: 600px'
  },

  _timer: null,

  onLoad(options) {
    const id = (options.id || options.bidding_id || '').trim();
    const navH = getNavBarHeight();
    const sys = wx.getSystemInfoSync();
    this.setData({
      biddingId: id,
      pageRootStyle: 'padding-top: ' + navH + 'px',
      scrollStyle: 'height: ' + (sys.windowHeight - navH - 20) + 'px',
      redirectUrl: '/pages/auth/login/index?redirect=' + encodeURIComponent('/pages/bidding/detail/index?id=' + id)
    });
    this.checkToken();
    if (id && getToken()) {
      this.loadBidding();
    } else if (!id) {
      this.setData({ loading: false, error: '竞价ID无效' });
    }
  },

  onShow() {
    this.checkToken();
    if (this.data.hasToken && this.data.biddingId) {
      this.loadBidding(this.data.bidding ? 'silent' : false);
    }
  },

  onUnload() {
    if (this._timer) clearInterval(this._timer);
  },

  checkToken() {
    const hasToken = !!getToken();
    this.setData({ hasToken });
  },

  async loadBidding(silent) {
    const { biddingId } = this.data;
    if (!biddingId || !getToken()) return;
    if (!silent) this.setData({ loading: true, error: '' });
    try {
      const bidding = await getBiddingDetail(biddingId);
      const isInsurance = bidding.insurance_info && bidding.insurance_info.is_insurance;
      const sortType = isInsurance ? 'default' : 'price_asc';
      this.setData({ bidding, sortType, loading: false });
      this.startCountdown();
      this.loadQuotes(sortType);
    } catch (err) {
      logger.error('加载竞价失败', err);
      this.setData({ loading: false, error: err.message || '加载失败' });
    }
  },

  async loadQuotes(sortType) {
    const { biddingId } = this.data;
    if (!biddingId || !getToken()) return;
    try {
      const app = getApp();
      let lat = 0, lng = 0;
      const cached = app.getCachedLocation();
      if (cached) {
        lat = cached.latitude || 0;
        lng = cached.longitude || 0;
      }
      const res = await getBiddingQuotes(biddingId, {
        sort_type: sortType,
        latitude: lat,
        longitude: lng
      });
      const list = (res.list || []).map((q, idx) => {
        const rating = parseFloat(q.rating) || 5;
        const starFull = Math.floor(rating);
        const amountText = formatAmount(q.amount);
        return {
          ...q,
          amountText,
          starsFull: '★'.repeat(starFull),
          starsEmpty: '☆'.repeat(5 - starFull),
          rating: rating.toFixed(1),
          saveText: ''
        };
      });
      if (sortType === 'price_asc' && list.length > 1) {
        const maxAmount = Math.max(...list.map((q) => parseFloat(q.amount)));
        list.forEach((q) => {
          const save = maxAmount - parseFloat(q.amount);
          if (save > 0) q.saveText = '省' + formatAmount(save) + '元';
        });
      }
      this.setData({ quotes: list });
    } catch (err) {
      logger.error('加载报价失败', err);
      ui.showError(err.message || '加载报价失败');
    }
  },

  startCountdown() {
    if (this._timer) clearInterval(this._timer);
    const { bidding } = this.data;
    if (!bidding || !bidding.expire_at) return;
    const tick = () => {
      const text = formatCountdown(bidding.expire_at);
      const expired = text === '已结束';
      this.setData({ countdownText: text, countdownExpired: expired });
      if (expired && this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
    };
    tick();
    this._timer = setInterval(tick, 1000);
  },

  toggleReport() {
    this.setData({ reportExpanded: !this.data.reportExpanded });
  },

  onToggleQuoteItems(e) {
    const quoteId = e.currentTarget.dataset.quoteId;
    const next = this.data.expandedQuoteId === quoteId ? '' : quoteId;
    this.setData({ expandedQuoteId: next });
  },

  onSelectTap(e) {
    const idx = e.currentTarget.dataset.index;
    const quote = (this.data.quotes || [])[idx];
    if (!quote) return;
    this.setData({ showConfirm: true, confirmQuote: quote });
  },

  onCloseConfirm() {
    this.setData({ showConfirm: false, confirmQuote: null });
  },

  async onConfirmSelect() {
    const { biddingId, confirmQuote } = this.data;
    if (!confirmQuote || this.data.selecting) return;
    this.setData({ selecting: true, selectedShopId: confirmQuote.shop_id });
    try {
      const res = await selectBiddingShop(biddingId, { shop_id: confirmQuote.shop_id });
      ui.showSuccess('选择成功');
      this.onCloseConfirm();
      navigation.navigateTo('/pages/order/detail/index', { id: res.order_id });
    } catch (err) {
      logger.error('选择维修厂失败', err);
      ui.showError(err.message || '选择失败');
    } finally {
      this.setData({ selecting: false, selectedShopId: '' });
    }
  },

  onBack() {
    wx.navigateBack();
  },

  async onSeedDevQuotes() {
    const { biddingId } = this.data;
    if (!biddingId) return;
    wx.showLoading({ title: '生成中...' });
    try {
      await seedDevQuotes(biddingId);
      wx.hideLoading();
      wx.showToast({ title: '已生成测试报价', icon: 'success' });
      this.loadQuotes(this.data.sortType);
      this.loadBidding();
    } catch (err) {
      wx.hideLoading();
      ui.showError(err.message || '生成失败（仅开发环境可用）');
    }
  }
});
