// 评价聚合页 - 全平台评价流，按等级+时间排序，支持时间/距离，新鲜度3天不重复
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const {
  getReviewFeed,
  reportReviewReading,
  recordReviewViewed,
  likeReview,
  dislikeReview
} = require('../../../utils/api');
const { getNavBarHeight, getSystemInfo } = require('../../../utils/util');
const { fetchAndApplyUnreadBadge } = require('../../../utils/message-badge');
const { getToken } = require('../../../utils/api');

const logger = getLogger('ReviewFeed');

const MAX_SESSION_SEC = 180;
const MAX_TOTAL_SEC = 300;

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  const now = new Date();
  const diff = now - d;
  if (diff < 86400000) return '今天';
  if (diff < 172800000) return '昨天';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

Page({
  data: {
    loading: false,
    reviews: [],
    page: 1,
    total: 0,
    hasMore: true,
    loadingMore: false,
    sort: 'quality',
    scrollHeight: 600,
    scrollStyle: 'height: 600px',
    pageRootStyle: 'padding-top: 88px',
    _readingTimers: {},
    _viewedIds: {}
  },

  onLoad() {
    const navH = getNavBarHeight();
    this.setData({ pageRootStyle: 'padding-top: ' + navH + 'px' });
    this.initScrollHeight(navH);
    this.loadList(true);
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 });
    }
    fetchAndApplyUnreadBadge();
  },

  onPullDownRefresh() {
    this.loadList(true).finally(() => wx.stopPullDownRefresh());
  },

  initScrollHeight(navBarHeight) {
    try {
      const sys = getSystemInfo();
      const h = sys.windowHeight - (navBarHeight || getNavBarHeight());
      this.setData({ scrollHeight: h, scrollStyle: 'height: ' + h + 'px' });
    } catch (e) {
      logger.warn('获取窗口高度失败', e);
    }
  },

  async loadList(refresh) {
    if (this.data.loading && refresh) return;
    if (this.data.loadingMore && !refresh) return;
    const page = refresh ? 1 : this.data.page;
    if (!refresh && !this.data.hasMore) return;

    if (refresh) this.setData({ loading: true });
    else this.setData({ loadingMore: true });

    try {
      const params = { page, limit: 20, sort: this.data.sort };
      const app = getApp();
      const cached = app.getCachedLocation && app.getCachedLocation();
      if (cached && cached.latitude && cached.longitude && this.data.sort === 'distance') {
        params.latitude = cached.latitude;
        params.longitude = cached.longitude;
      }
      const stored = wx.getStorageSync('user_chosen_location');
      if (stored && stored.latitude && stored.longitude && this.data.sort === 'distance') {
        params.latitude = stored.latitude;
        params.longitude = stored.longitude;
      }

      const res = await getReviewFeed(params);
      const rawList = res?.list || [];
      const total = res?.total || 0;

      const mapped = rawList.map((r) => {
        const rating = parseFloat(r.rating) || 0;
        const content = r.content || '';
        const amt = r.amount;
        const amountText = amt != null ? (Number.isInteger(amt) ? String(amt) : amt.toFixed(2)) : '';
        return {
          ...r,
          contentPreview: content.length > 60 ? content.slice(0, 60) + '...' : content,
          expanded: false,
          liked: !!r.is_liked,
          disliked: !!r.is_disliked,
          dislike_count: r.dislike_count ?? 0,
          ratingText: '★'.repeat(Math.floor(rating)) + '☆'.repeat(5 - Math.floor(rating)),
          dateText: formatDate(r.created_at),
          amountText,
          isLowRating: rating > 0 && rating < 4
        };
      });

      const prevList = refresh ? [] : this.data.reviews;
      const newList = [...prevList, ...mapped];

      this.setData({
        reviews: newList,
        page,
        total,
        hasMore: newList.length < total,
        loading: false,
        loadingMore: false
      });

      mapped.forEach((r) => this.startReadingObserver(r.review_id));
    } catch (err) {
      logger.error('加载评价流失败', err);
      ui.showError(err.message || '加载失败');
      this.setData({ loading: false, loadingMore: false });
    }
  },

  onSortChange(e) {
    const sort = e.currentTarget.dataset.sort || 'quality';
    if (sort === this.data.sort) return;
    this.setData({
      sort,
      reviews: [],
      page: 1,
      hasMore: true
    }, () => this.loadList(true));
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.loadList(false);
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
    observer.relativeToViewport({ bottom: 0 }).observe('#feed-review-' + reviewId, (res) => {
      const ratio = res.intersectionRatio || 0;
      if (ratio >= 0.3) {
        if (!state.sawAt) {
          state.sawAt = new Date();
          this.recordViewed(reviewId);
        }
        if (!state.intervalId) {
          state.intervalId = setInterval(() => {
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

  async recordViewed(reviewId) {
    if (!getToken()) return;
    const viewed = this.data._viewedIds || {};
    if (viewed[reviewId]) return;
    viewed[reviewId] = true;
    this.setData({ _viewedIds: viewed });
    try {
      await recordReviewViewed(reviewId);
    } catch (err) {
      logger.warn('记录浏览失败', { reviewId, err: err.message });
    }
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

  async onDislikeReview(e) {
    const idx = e.currentTarget.dataset.index;
    const reviewId = e.currentTarget.dataset.reviewId;
    const reviews = [...this.data.reviews];
    if (!reviews[idx] || reviews[idx].disliked || reviews[idx].liked) return;
    try {
      await dislikeReview(reviewId);
      reviews[idx].disliked = true;
      reviews[idx].dislike_count = (reviews[idx].dislike_count || 0) + 1;
      this.setData({ reviews });
      ui.showSuccess('已踩');
    } catch (err) {
      ui.showError(err.message || '操作失败');
    }
  },

  onShopTap(e) {
    const shopId = e.currentTarget.dataset.shopId;
    if (shopId) {
      navigation.navigateTo('/pages/shop/detail/index', { id: shopId });
    }
  },

  onAppealTap(e) {
    const orderId = e.currentTarget.dataset.orderId;
    if (orderId) navigation.navigateTo('/pages/order/detail/index', { id: orderId });
  },

  onUnload() {
    const timers = this.data._readingTimers || {};
    Object.keys(timers).forEach((reviewId) => {
      const t = timers[reviewId];
      if (t?.intervalId) clearInterval(t.intervalId);
    });
  }
});
