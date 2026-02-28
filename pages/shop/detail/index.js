// 维修厂详情页 - 04-维修厂详情页
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const { getShopDetail, getShopReviews, reportReviewReading, likeReview } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

const logger = getLogger('ShopDetail');

// 有效阅读：单次最多 180 秒，总最多 300 秒
const MAX_SESSION_SEC = 180;
const MAX_TOTAL_SEC = 300;

function getDeviationClass(rate) {
  const r = parseFloat(rate) || 0;
  if (r < 10) return 'deviation-low';
  if (r < 20) return 'deviation-mid';
  return 'deviation-high';
}

Page({
  data: {
    shopId: '',
    scrollHeight: 600,
    scrollStyle: 'height: 600px',
    shop: null,
    reviews: [],
    reviewPage: 1,
    reviewTotal: 0,
    hasMoreReviews: true,
    loading: true,
    loadingReviews: false,
    favored: false,
    pageRootStyle: 'padding-top: 88px',
    _readingTimers: {}, // reviewId -> { intervalId, sawAt, sessionSec, totalReported }
  },

  onLoad(options) {
    const id = (options.id || options.shop_id || '').trim();
    if (!id) {
      ui.showError('缺少维修厂信息');
      setTimeout(() => navigation.navigateBack(), 1500);
      return;
    }
    const navH = getNavBarHeight();
    this.setData({ shopId: id, pageRootStyle: 'padding-top: ' + navH + 'px' });
    this.initScrollHeight(navH);
    logger.info('进入维修厂详情', { id });
    this.loadDetail();
  },

  initScrollHeight(navBarHeight) {
    try {
      const sys = wx.getSystemInfoSync();
      const h = sys.windowHeight - (navBarHeight || getNavBarHeight());
      this.setData({ scrollHeight: h, scrollStyle: 'height: ' + h + 'px' });
    } catch (e) {
      logger.warn('获取窗口高度失败', e);
    }
  },

  async loadDetail() {
    this.setData({ loading: true });
    try {
      const shop = await getShopDetail(this.data.shopId);
      const stats = shop.review_stats || {};
      const deviationRate = parseFloat(shop.deviation_rate) || 0;
      const deviationClass = getDeviationClass(deviationRate);
      const avgRating = parseFloat(stats.avg_rating) || parseFloat(shop.rating) || 5;
      const starFull = Math.floor(avgRating);

      this.setData({
        shop: {
          ...shop,
          logo: shop.logo || '/images/logo/logo_white.png',
          categories: shop.categories || [],
          certifications: shop.certifications || [],
          services: shop.services || [],
          deviationRate: deviationRate.toFixed(1),
          deviationClass,
          avgRating: avgRating.toFixed(1),
          starsFull: '★'.repeat(starFull),
          starsEmpty: '☆'.repeat(5 - starFull),
          totalReviews: stats.total_reviews || 0
        },
        loading: false
      });

      wx.setNavigationBarTitle({ title: shop.name || '维修厂详情' });
      this.loadReviews();
    } catch (err) {
      logger.error('加载维修厂详情失败', err);
      ui.showError(err.message || '加载失败');
      this.setData({ loading: false });
      setTimeout(() => navigation.navigateBack(), 1500);
    }
  },

  async loadReviews() {
    const { shopId, reviews, reviewPage, hasMoreReviews, loadingReviews } = this.data;
    if (!hasMoreReviews || loadingReviews) return;

    this.setData({ loadingReviews: true });
    try {
      const res = await getShopReviews(shopId, { page: reviewPage, limit: 10, sort: 'completeness' });
      const list = res?.list || [];
      const total = res?.total || 0;

      const mapped = list.map((r) => {
        const rating = parseFloat(r.rating) || 0;
        const content = r.content || '';
        return {
          ...r,
          contentPreview: content.length > 60 ? content.slice(0, 60) + '...' : content,
          expanded: false,
          liked: false,
          ratingText: '★'.repeat(Math.floor(rating)) + '☆'.repeat(5 - Math.floor(rating)),
          dateText: formatDate(r.created_at),
          isLowRating: rating > 0 && rating < 4
        };
      });

      this.setData({
        reviews: [...reviews, ...mapped],
        reviewPage: reviewPage + 1,
        reviewTotal: total,
        hasMoreReviews: reviews.length + list.length < total,
        loadingReviews: false
      });
    } catch (err) {
      logger.error('加载评价失败', err);
      this.setData({ loadingReviews: false });
    }
  },

  onCall() {
    const phone = this.data.shop?.phone;
    if (!phone) {
      ui.showWarning('暂无联系电话');
      return;
    }
    wx.makePhoneCall({ phoneNumber: phone });
  },

  onNavigate() {
    const shop = this.data.shop;
    if (!shop || !shop.latitude || !shop.longitude) {
      ui.showWarning('暂无位置信息');
      return;
    }
    wx.openLocation({
      latitude: parseFloat(shop.latitude),
      longitude: parseFloat(shop.longitude),
      name: shop.name || '维修厂',
      address: shop.address || ''
    });
  },

  onBook() {
    navigation.navigateTo('/pages/shop/book/index', { id: this.data.shopId });
  },

  onFavorite() {
    this.setData({ favored: !this.data.favored });
    ui.showSuccess(this.data.favored ? '已收藏' : '已取消收藏');
  },

  onExpandReview(e) {
    const idx = e.currentTarget.dataset.index;
    const reviews = [...this.data.reviews];
    if (!reviews[idx]) return;
    reviews[idx].expanded = true;
    this.setData({ reviews });
    setTimeout(() => this.startReadingObserver(reviews[idx].review_id), 100);
  },

  startReadingObserver(reviewId) {
    const timers = this.data._readingTimers || {};
    if (timers[reviewId]) return;
    const state = { sawAt: null, sessionSec: 0, totalReported: 0, intervalId: null, observer: null };
    timers[reviewId] = state;
    this.setData({ _readingTimers: timers });

    const observer = this.createIntersectionObserver({ observeAll: false });
    observer.relativeToViewport({ bottom: 0 }).observe('#review-' + reviewId, (res) => {
      const ratio = res.intersectionRatio || 0;
      if (ratio >= 0.5) {
        if (!state.intervalId) {
          state.intervalId = setInterval(() => {
            if (!state.sawAt) state.sawAt = new Date(); // ≥1秒视为「看到了」
            state.sessionSec += 1;
            if (state.sessionSec >= MAX_SESSION_SEC || state.totalReported + state.sessionSec >= MAX_TOTAL_SEC) {
              this.reportAndStopReading(reviewId);
            }
          }, 1000);
        }
      } else {
        if (state.intervalId) {
          this.reportAndStopReading(reviewId);
        }
      }
    });
    state.observer = observer;
  },

  async reportAndStopReading(reviewId) {
    const timers = this.data._readingTimers || {};
    const t = timers[reviewId];
    if (!t) return;
    if (t.intervalId) clearInterval(t.intervalId);
    t.intervalId = null;
    if (t.observer) t.observer.disconnect();
    t.observer = null;
    const sec = Math.min(Math.max(0, t.sessionSec), MAX_SESSION_SEC, MAX_TOTAL_SEC - t.totalReported);
    delete timers[reviewId];
    this.setData({ _readingTimers: timers });
    if (sec <= 0) return;
    try {
      await reportReviewReading(reviewId, {
        effective_seconds: sec,
        saw_at: (t.sawAt || new Date()).toISOString()
      });
    } catch (err) {
      logger.warn('上报阅读失败', { reviewId, err: err.message });
    }
  },

  onLikeReview(e) {
    const idx = e.currentTarget.dataset.index;
    const reviewId = e.currentTarget.dataset.reviewId;
    const reviews = [...this.data.reviews];
    if (!reviews[idx] || reviews[idx].liked) return;
    likeReview(reviewId).then((res) => {
      reviews[idx].liked = true;
      reviews[idx].like_count = (reviews[idx].like_count || 0) + 1;
      this.setData({ reviews });
      ui.showSuccess(res?.message || '点赞成功');
    }).catch((err) => {
      ui.showError(err.message || '点赞失败');
    });
  },

  onUnload() {
    const timers = this.data._readingTimers || {};
    Object.keys(timers).forEach((reviewId) => {
      const t = timers[reviewId];
      if (t?.intervalId) clearInterval(t.intervalId);
    });
  }
});

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  const now = new Date();
  const diff = now - d;
  if (diff < 86400000) return '今天';
  if (diff < 172800000) return '昨天';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
