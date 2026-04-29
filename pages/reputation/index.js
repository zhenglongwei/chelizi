// 口碑页：店铺列表 + 全平台评价流（原独立「评价」tab 合并至此）
const { getLogger } = require('../../utils/logger');
const ui = require('../../utils/ui');
const navigation = require('../../utils/navigation');
const {
  getShopsSearch,
  getReviewFeed,
  reportReviewReading,
  recordReviewViewed,
  likeReview,
  getToken
} = require('../../utils/api');
const { fetchAndApplyUnreadBadge } = require('../../utils/message-badge');
const { getNavBarHeight, getSystemInfo } = require('../../utils/util');
const { showWechatShareMenu } = require('../../utils/show-share-menu');
const { buildOwnerSideScoreRow } = require('../../utils/shop-public-score');
const { buildQuoteProposalDisplayList, buildQuoteJourneySummary } = require('../../utils/quote-proposal-display');
const {
  parseObjectiveBool,
  buildObjectiveSummary,
  computeTotalImageCount,
  isObjectiveAnswersV3,
  buildV3ObjectiveSummary
} = require('../../utils/review-public-display');
const { formatMethodsSummary } = require('../../utils/parts-verification-labels');
const { enrichReviewV3PublicCard } = require('../../utils/review-v3-public-display');

const logger = getLogger('Reputation');
const MAX_SESSION_SEC = 180;
const MAX_TOTAL_SEC = 300;

function mapShopItem(s, idx) {
  const scoreRow = buildOwnerSideScoreRow(s);
  let badgeText = '';
  let badgeClass = '';
  let locationText = s.district || s.address || '—';
  if (idx === 0 && s.distance != null) {
    badgeText = '离我最近 ' + s.distance + 'km';
    badgeClass = 'badge-nearest';
  } else if (s.is_certified) {
    badgeText = '官方认证';
    badgeClass = 'badge-cert';
    locationText = s.distance != null ? s.distance + 'km' : locationText;
  } else if (s.distance != null) {
    badgeText = s.distance + 'km';
    badgeClass = 'badge-distance';
  }
  const ratingLine = scoreRow.showPublicScore
    ? scoreRow.rating + ' | ' + scoreRow.orderCount + '单'
    : scoreRow.orderCount > 0
      ? scoreRow.rating + ' · ' + scoreRow.orderCount + '单'
      : scoreRow.rating;
  return {
    shop_id: s.shop_id,
    name: s.name,
    logo: s.logo || '/images/brand/brand-app-icon-zhejian.png',
    showPublicScore: scoreRow.showPublicScore,
    rating: scoreRow.rating,
    ratingLine,
    starsDisplay: scoreRow.starsDisplay,
    scoreNum: scoreRow.scoreNum,
    orderCount: scoreRow.orderCount,
    is_certified: s.is_certified,
    badgeText,
    badgeClass,
    locationText,
    latestReviewSummary: s.latest_review_summary || null,
    latestReviewNegative: !!s.latest_review_negative,
    productSnippetText: s.product_snippet_text || null
  };
}

function buildPartsMerchantVerifyLine(pd) {
  if (!pd || typeof pd !== 'object') return '';
  const methods = Array.isArray(pd.merchant_methods) ? pd.merchant_methods : [];
  const note = pd.merchant_verify_note != null ? String(pd.merchant_verify_note).trim() : '';
  if (!methods.length && !note) return '';
  let line = '';
  if (methods.length) line = '店方验真方式：' + formatMethodsSummary(methods);
  if (note) line += (line ? ' ' : '') + '（' + note.slice(0, 120) + '）';
  return line;
}

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
    mainTab: 'shop',
    shopListLoading: false,
    reputationShops: [],
    scrollHeight: 500,
    scrollStyle: 'height: 500px',
    pageRootStyle: 'padding-top: 88px',
    refreshing: false,
    loading: false,
    reviews: [],
    page: 1,
    total: 0,
    hasMore: true,
    loadingMore: false,
    sort: 'quality',
    _readingTimers: {},
    _viewedIds: {}
  },

  onLoad(options) {
    logger.info('口碑页加载');
    let mainTab = 'shop';
    if (options && options.tab === 'reviews') {
      mainTab = 'reviews';
    } else {
      try {
        const app = getApp();
        if (app && app.globalData && app.globalData.reputationSubTab === 'reviews') {
          mainTab = 'reviews';
          app.globalData.reputationSubTab = null;
        }
      } catch (_) {}
    }
    const navH = getNavBarHeight();
    this.setData({ mainTab, pageRootStyle: 'padding-top: ' + navH + 'px' });
    this.initScrollHeight(navH);
    if (mainTab === 'shop') {
      this.loadData();
    } else {
      this.loadList(true);
    }
  },

  onShow() {
    showWechatShareMenu();
    try {
      const app = getApp();
      if (app && app.globalData && app.globalData.reputationSubTab === 'reviews') {
        app.globalData.reputationSubTab = null;
        this.setData({ mainTab: 'reviews' }, () => {
          this.initScrollHeight(getNavBarHeight());
          if (!this.data.reviews.length && !this.data.loading && !this.data.loadingMore) {
            this.loadList(true);
          }
        });
      }
    } catch (_) {}
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    fetchAndApplyUnreadBadge();
  },

  onPullDownRefresh() {
    const finish = () => wx.stopPullDownRefresh();
    if (this.data.mainTab === 'shop') {
      this.loadData().finally(finish);
    } else {
      this.loadList(true).finally(finish);
    }
  },

  onMainTabChange(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.mainTab) return;
    this.setData({ mainTab: tab }, () => {
      this.initScrollHeight(getNavBarHeight());
      if (tab === 'reviews' && !this.data.reviews.length && !this.data.loading && !this.data.loadingMore) {
        this.loadList(true);
      }
      if (tab === 'shop' && !this.data.reputationShops.length && !this.data.shopListLoading) {
        this.loadData();
      }
    });
  },

  onPullRefresh() {
    this.setData({ refreshing: true });
    this.loadData().finally(() => this.setData({ refreshing: false }));
  },

  initScrollHeight(navBarHeight) {
    try {
      const sys = getSystemInfo();
      const nav = navBarHeight || getNavBarHeight();
      const rpxToPx = (rpx) => (rpx * sys.windowWidth) / 750;
      const headerRpx = this.data.mainTab === 'shop' ? 232 : 184;
      const h = sys.windowHeight - nav - rpxToPx(headerRpx);
      this.setData({ scrollHeight: h, scrollStyle: 'height: ' + h + 'px' });
    } catch (e) {
      logger.warn('获取窗口高度失败', e);
    }
  },

  async loadData() {
    this.setData({ shopListLoading: true });
    try {
      const app = getApp();
      let lat = null;
      let lng = null;
      const cached = app.getCachedLocation();
      if (cached) {
        lat = cached.latitude;
        lng = cached.longitude;
      }
      const params = { limit: 10, sort: 'score' };
      if (lat && lng) {
        params.latitude = lat;
        params.longitude = lng;
      }
      const res = await getShopsSearch(params);
      const rawList = res?.list || [];
      const list = rawList.map((s, idx) => mapShopItem(s, idx));
      this.setData({ reputationShops: list });
      logger.info('口碑好店加载', { count: list.length });
    } catch (err) {
      logger.error('口碑好店加载失败', err);
      ui.showError(err.message || '加载失败，请重试');
      this.setData({ reputationShops: [] });
    } finally {
      this.setData({ shopListLoading: false });
    }
  },

  onSearchTap() {
    navigation.navigateTo('/pages/search/list/index');
  },

  goToShopDetail(e) {
    const shopId = e.currentTarget.dataset.id;
    if (!shopId) return;
    logger.info('点击维修厂', shopId);
    navigation.navigateTo('/pages/shop/detail/index', { id: shopId });
  },

  goToMoreShops() {
    navigation.navigateTo('/pages/search/list/index');
  },

  async loadList(refresh) {
    if (this.data.loading && refresh) return;
    if (this.data.loadingMore && !refresh) return;
    const requestPage = refresh ? 1 : this.data.page + 1;
    if (!refresh && !this.data.hasMore) return;

    if (refresh) this.setData({ loading: true });
    else this.setData({ loadingMore: true });

    try {
      const params = { page: requestPage, limit: 20, sort: this.data.sort };
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
        const repairItems = Array.isArray(r.repair_items) ? r.repair_items : [];
        const partPromiseLines = Array.isArray(r.part_promise_lines) ? r.part_promise_lines : [];
        const materialPhotos = Array.isArray(r.material_photos) ? r.material_photos : [];
        const beforeImgs = (() => {
          try {
            return typeof r.before_images === 'string' ? JSON.parse(r.before_images || '[]') : (r.before_images || []);
          } catch (_) {
            return [];
          }
        })();
        const afterImgs = (() => {
          try {
            return typeof r.after_images === 'string' ? JSON.parse(r.after_images || '[]') : (r.after_images || []);
          } catch (_) {
            return [];
          }
        })();
        const completionImgs = (() => {
          try {
            return typeof r.completion_images === 'string' ? JSON.parse(r.completion_images || '[]') : (r.completion_images || []);
          } catch (_) {
            return [];
          }
        })();
        const oa = r.objective_answers || {};
        const reviewFormVersion3 = isObjectiveAnswersV3(oa);
        let objQ1;
        let objQ2;
        let objQ3;
        let hasObjectives;
        let objectiveSummary;
        if (reviewFormVersion3) {
          objQ1 = null;
          objQ2 = null;
          objQ3 = null;
          hasObjectives = true;
          objectiveSummary = buildV3ObjectiveSummary(oa);
        } else {
          objQ1 = parseObjectiveBool(oa.q1_progress_synced);
          objQ2 = parseObjectiveBool(oa.q2_parts_shown);
          objQ3 = parseObjectiveBool(oa.q3_fault_resolved);
          hasObjectives = objQ1 != null || objQ2 != null || objQ3 != null;
          objectiveSummary = hasObjectives ? buildObjectiveSummary(objQ1, objQ2, objQ3) : '';
        }
        const systemChecks = r.review_system_checks || null;
        const quoteProposalDisplay = buildQuoteProposalDisplayList(r.quote_proposal_history || []);
        const q0 = quoteProposalDisplay[0];
        const quoteJourneyNeedsToggle =
          quoteProposalDisplay.length > 1 ||
          !!(q0 && q0.photo_urls && q0.photo_urls.length > 0);
        const totalImageCount = computeTotalImageCount({
          before_images: beforeImgs,
          after_images: afterImgs,
          completion_images: completionImgs,
          material_photos: materialPhotos
        });
        const repairItemsLine = repairItems.length ? repairItems.join('、') : '';
        const partPromiseLineText = partPromiseLines.length ? partPromiseLines.join(' · ') : '';
        const hasSystemQuoteNodes = !!(
          systemChecks &&
          systemChecks.quote_flow &&
          Array.isArray(systemChecks.quote_flow.nodes) &&
          systemChecks.quote_flow.nodes.length
        );
        const partsMerchantVerifyLine = buildPartsMerchantVerifyLine(
          systemChecks && systemChecks.parts_delivery
        );
        let v3DualStars = false;
        let repairRatingText = '';
        let serviceRatingText = '';
        if (reviewFormVersion3) {
          const re = parseInt(oa.repair_effect_star, 10);
          const sv = parseInt(oa.service_experience_star, 10);
          if (!Number.isNaN(re) && re >= 1 && re <= 5 && !Number.isNaN(sv) && sv >= 1 && sv <= 5) {
            v3DualStars = true;
            repairRatingText = '★'.repeat(re) + '☆'.repeat(5 - re);
            serviceRatingText = '★'.repeat(sv) + '☆'.repeat(5 - sv);
          }
        }
        return enrichReviewV3PublicCard({
          ...r,
          before_images: beforeImgs,
          after_images: afterImgs,
          completion_images: completionImgs,
          repair_items: repairItems,
          part_promise_lines: partPromiseLines,
          material_photos: materialPhotos,
          quote_credential_urls: r.quote_credential_urls || [],
          contentPreview: content.length > 60 ? content.slice(0, 60) + '...' : content,
          expanded: false,
          liked: !!r.is_liked,
          disliked: !!r.is_disliked,
          dislike_count: r.dislike_count ?? 0,
          ratingText: '★'.repeat(Math.floor(rating)) + '☆'.repeat(5 - Math.floor(rating)),
          dateText: formatDate(r.created_at),
          amountText,
          isLowRating: rating > 0 && rating < 4,
          quoteProposalDisplay,
          quoteJourneySummary: buildQuoteJourneySummary(quoteProposalDisplay),
          quoteJourneyNeedsToggle,
          quoteJourneyExpanded: false,
          showReviewImages: false,
          repairItemsLine,
          partPromiseLineText,
          hasSystemQuoteNodes,
          v3DualStars,
          repairRatingText,
          serviceRatingText,
          totalImageCount,
          objQ1,
          objQ2,
          objQ3,
          hasObjectives,
          objectiveSummary,
          reviewFormVersion3,
          systemChecks,
          partsMerchantVerifyLine
        });
      });

      const prevList = refresh ? [] : this.data.reviews;
      const newList = [...prevList, ...mapped];

      this.setData({
        reviews: newList,
        page: requestPage,
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
    const d = e.detail || {};
    let idx = d.index != null ? d.index : e.currentTarget.dataset.index;
    if (idx == null || idx === '') return;
    idx = typeof idx === 'number' ? idx : parseInt(idx, 10);
    const reviews = [...this.data.reviews];
    if (Number.isNaN(idx) || !reviews[idx]) return;
    reviews[idx].expanded = true;
    this.setData({ reviews });
    setTimeout(() => this.startReadingObserver(reviews[idx].review_id), 100);
  },

  onToggleQuoteJourney(e) {
    const d = e.detail || {};
    let ridx =
      d.index != null
        ? d.index
        : e.currentTarget.dataset.ridx != null
          ? e.currentTarget.dataset.ridx
          : e.currentTarget.dataset.index;
    ridx = typeof ridx === 'number' ? ridx : parseInt(ridx, 10);
    const reviews = [...this.data.reviews];
    if (Number.isNaN(ridx) || !reviews[ridx]) return;
    reviews[ridx].quoteJourneyExpanded = !reviews[ridx].quoteJourneyExpanded;
    this.setData({ reviews });
  },

  onTogglePubV3Expand(e) {
    const d = e.detail || {};
    let idx = d.index != null ? d.index : e.currentTarget.dataset.index;
    idx = typeof idx === 'number' ? idx : parseInt(idx, 10);
    const key = (d.key != null ? d.key : e.currentTarget.dataset.key) || '';
    const reviews = [...this.data.reviews];
    const row = reviews[idx];
    if (Number.isNaN(idx) || !row || !row.pubExpand || !key) return;
    const pe = { ...row.pubExpand, [key]: !row.pubExpand[key] };
    row.pubExpand = pe;
    this.setData({ reviews });
    if (pe[key]) {
      setTimeout(() => this.startReadingObserver(row.review_id), 100);
    }
  },

  onToggleReviewImages(e) {
    const d = e.detail || {};
    let ridx =
      d.index != null
        ? d.index
        : e.currentTarget.dataset.ridx != null
          ? e.currentTarget.dataset.ridx
          : e.currentTarget.dataset.index;
    ridx = typeof ridx === 'number' ? ridx : parseInt(ridx, 10);
    const reviews = [...this.data.reviews];
    if (Number.isNaN(ridx) || !reviews[ridx]) return;
    reviews[ridx].showReviewImages = !reviews[ridx].showReviewImages;
    this.setData({ reviews });
    if (reviews[ridx].showReviewImages) {
      setTimeout(() => this.startReadingObserver(reviews[ridx].review_id), 100);
    }
  },

  onPreviewFeedReviewImagesRow(e) {
    const d = e.detail || {};
    let ridx =
      d.index != null
        ? d.index
        : e.currentTarget.dataset.ridx != null
          ? e.currentTarget.dataset.ridx
          : e.currentTarget.dataset.index;
    ridx = typeof ridx === 'number' ? ridx : parseInt(ridx, 10);
    const group = (d.group != null ? d.group : e.currentTarget.dataset.group) || '';
    const current = (d.current != null ? d.current : e.currentTarget.dataset.current) || '';
    const rev = this.data.reviews[ridx];
    if (!rev) return;
    let urls = [];
    if (group === 'before') urls = rev.before_images || [];
    else if (group === 'after') urls = rev.after_images || [];
    else if (group === 'completion') urls = rev.completion_images || [];
    else if (group === 'material') urls = rev.material_photos || [];
    else if (group === 'quoteCred') urls = rev.pubQuoteCredentialUrls || [];
    urls = (urls || []).filter(Boolean);
    if (!urls.length) return;
    wx.previewImage({ urls, current: current || urls[0] });
  },

  onPreviewFeedQuotePhoto(e) {
    const d = e.detail || {};
    let ridx =
      d.index != null
        ? d.index
        : e.currentTarget.dataset.ridx != null
          ? e.currentTarget.dataset.ridx
          : e.currentTarget.dataset.index;
    ridx = typeof ridx === 'number' ? ridx : parseInt(ridx, 10);
    let qpidx = d.qpidx != null ? d.qpidx : e.currentTarget.dataset.qpidx;
    qpidx = typeof qpidx === 'number' ? qpidx : parseInt(qpidx, 10);
    const url = d.url != null ? d.url : e.currentTarget.dataset.url;
    const rev = this.data.reviews[ridx];
    if (!rev || !rev.quoteProposalDisplay || Number.isNaN(qpidx) || !rev.quoteProposalDisplay[qpidx]) return;
    const urls = rev.quoteProposalDisplay[qpidx].photo_urls || [];
    if (urls.length) wx.previewImage({ urls, current: url || urls[0] });
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
      } else if (state.intervalId) {
        this.reportAndStopReading(reviewId);
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

  onAppealTap(e) {
    const orderId = e.currentTarget.dataset.orderId;
    if (orderId) navigation.navigateTo('/pages/order/detail/index', { id: orderId });
  },

  /** 代理人分销：分享口碑（店铺/评价流）或从评价卡片分享进店铺锚定评价 */
  onShareAppMessage(res) {
    const { buildReferralSharePath, SHARE_TITLES } = require('../../utils/referral-share');
    if (res.from === 'button') {
      const ds = res.target && res.target.dataset;
      const reviewId = ds && ds.reviewId ? String(ds.reviewId).trim() : '';
      const shopId = ds && ds.shopId ? String(ds.shopId).trim() : '';
      if (reviewId && shopId) {
        return {
          title: SHARE_TITLES.review,
          path: buildReferralSharePath('/pages/shop/detail/index', { id: shopId, review_id: reviewId })
        };
      }
    }
    if (this.data.mainTab === 'reviews') {
      return {
        title: SHARE_TITLES.reputationReviews,
        path: buildReferralSharePath('/pages/reputation/index', { tab: 'reviews' })
      };
    }
    return {
      title: SHARE_TITLES.reputationShop,
      path: buildReferralSharePath('/pages/reputation/index')
    };
  },

  onUnload() {
    const timers = this.data._readingTimers || {};
    Object.keys(timers).forEach((reviewId) => {
      const t = timers[reviewId];
      if (t?.intervalId) clearInterval(t.intervalId);
    });
  }
});
