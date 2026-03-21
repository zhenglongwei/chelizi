// 竞价报价页 - 03-竞价报价页
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const { getToken, getBiddingDetail, getBiddingQuotes, selectBiddingShop, seedDevQuotes } = require('../../../utils/api');
const { requestUserSubscribe } = require('../../../utils/subscribe');
const { getNavBarHeight, getSystemInfo } = require('../../../utils/util');

const logger = getLogger('BiddingDetail');

// 07 文档：用户可选排序
const SORT_OPTIONS = [
  { value: 'default', label: '综合推荐' },
  { value: 'price_asc', label: '价格从低到高' },
  { value: 'rating', label: '评价星级优先' },
  { value: 'good_rate', label: '好评率优先' },
  { value: 'bad_rate', label: '差评率低优先' },
  { value: 'distance', label: '距离从近到远' },
  { value: 'warranty', label: '质保从长到短' },
];

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
    sortIndex: 0,
    sortOptions: SORT_OPTIONS,
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
    showBadReviewPopup: false,
    badReviewPopupText: '',
    pageRootStyle: 'padding-top: 88px',
    scrollStyle: 'height: 600px',
    notifiedCount: 0
  },

  _timer: null,
  _notifiedTimer: null,

  onLoad(options) {
    const id = (options.id || options.bidding_id || '').trim();
    const navH = getNavBarHeight();
    const sys = getSystemInfo();
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
    if (this._notifiedTimer) clearInterval(this._notifiedTimer);
  },

  _calcNotifiedCount(bidding) {
    if (!bidding || !bidding.invited_count) return 0;
    const tier1EndsAt = bidding.tier1_window_ends_at ? new Date(bidding.tier1_window_ends_at).getTime() : 0;
    const now = Date.now();
    if (tier1EndsAt && now < tier1EndsAt) {
      return bidding.tier1_count || 0;
    }
    return bidding.invited_count || 0;
  },

  startNotifiedCountUpdate() {
    if (this._notifiedTimer) clearInterval(this._notifiedTimer);
    const { bidding } = this.data;
    if (!bidding || !bidding.tier1_window_ends_at || bidding.invited_count <= (bidding.tier1_count || 0)) return;
    const tier1EndsAt = new Date(bidding.tier1_window_ends_at).getTime();
    const tick = () => {
      const n = this._calcNotifiedCount(this.data.bidding);
      if (n !== this.data.notifiedCount) this.setData({ notifiedCount: n });
      if (Date.now() >= tier1EndsAt && this._notifiedTimer) {
        clearInterval(this._notifiedTimer);
        this._notifiedTimer = null;
      }
    };
    tick();
    this._notifiedTimer = setInterval(tick, 1000);
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
      const sortIndex = SORT_OPTIONS.findIndex((o) => o.value === sortType);
      const notifiedCount = this._calcNotifiedCount(bidding);
      this.setData({ bidding, sortType, sortIndex: sortIndex >= 0 ? sortIndex : 0, notifiedCount, loading: false });
      this.startCountdown();
      this.startNotifiedCountUpdate();
      this.loadQuotes(sortType);
      if (bidding.status === 0) requestUserSubscribe('bidding_quote');
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
      const { scoreToStarDisplay } = require('../../../utils/shop-score-display');
      const now = Date.now();
      const list = (res.list || []).map((q, idx) => {
        const starDisplay = scoreToStarDisplay(q.shop_score, q.rating);
        const amountText = formatAmount(q.amount);
        let validityText = '';
        if (q.quote_valid_until) {
          const end = new Date(q.quote_valid_until).getTime();
          if (now > end) validityText = '已过期';
          else {
            const days = Math.ceil((end - now) / (24 * 3600 * 1000));
            validityText = days > 1 ? `${days}天内有效` : '今日有效';
          }
        }
        return {
          ...q,
          amountText,
          starsDisplay: starDisplay.stars,
          rating: starDisplay.scoreText,
          scoreNum: starDisplay.score,
          goodRateText: q.good_rate != null ? q.good_rate + '%好评' : '',
          recentBadReviewSummary: q.recent_bad_review_summary || '',
          saveText: '',
          validityText
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

  onSortChange(e) {
    const idx = parseInt(e.detail.value, 10);
    if (isNaN(idx) || idx < 0 || idx >= SORT_OPTIONS.length) return;
    const sortType = SORT_OPTIONS[idx].value;
    this.setData({ sortIndex: idx, sortType });
    this.loadQuotes(sortType);
  },

  toggleReport() {
    this.setData({ reportExpanded: !this.data.reportExpanded });
  },

  onToggleQuoteItems(e) {
    const quoteId = e.currentTarget.dataset.quoteId;
    const next = this.data.expandedQuoteId === quoteId ? '' : quoteId;
    this.setData({ expandedQuoteId: next });
  },

  onQuoteLongPress(e) {
    const idx = e.currentTarget.dataset.index;
    const quote = (this.data.quotes || [])[idx];
    const text = quote?.recentBadReviewSummary;
    if (text) {
      this.setData({ showBadReviewPopup: true, badReviewPopupText: text });
    } else {
      ui.showWarning('近30天暂无差评');
    }
  },

  onCloseBadReviewPopup() {
    this.setData({ showBadReviewPopup: false, badReviewPopupText: '' });
  },

  onSelectTap(e) {
    const idx = e.currentTarget.dataset.index;
    const quote = (this.data.quotes || [])[idx];
    if (!quote) return;
    if (quote.is_expired) {
      ui.showWarning('该报价已过期');
      return;
    }
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
      await requestUserSubscribe('order_update');
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
  }
});
