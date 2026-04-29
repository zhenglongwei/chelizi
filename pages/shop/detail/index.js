// 维修厂详情页 - 04-维修厂详情页
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const {
  getShopDetail,
  getShopReviews,
  reportReviewReading,
  likeReview,
  getShopBookingOptions
} = require('../../../utils/api');
const { runUserBookingFlow } = require('../../../utils/user-booking-flow');
const { getNavBarHeight, getSystemInfo } = require('../../../utils/util');
const { buildQuoteProposalDisplayList, buildQuoteJourneySummary } = require('../../../utils/quote-proposal-display');
const {
  parseObjectiveBool,
  buildObjectiveSummary,
  computeTotalImageCount,
  isObjectiveAnswersV3,
  buildV3ObjectiveSummary
} = require('../../../utils/review-public-display');
const { formatMethodsSummary } = require('../../../utils/parts-verification-labels');
const { enrichReviewV3PublicCard } = require('../../../utils/review-v3-public-display');

const logger = getLogger('ShopDetail');
const { buildReferralSharePath, SHARE_TITLES } = require('../../../utils/referral-share');
const { showWechatShareMenu } = require('../../../utils/show-share-menu');
const { buildOwnerSideScoreRow, INSUFFICIENT_SAMPLE_HINT, getShopOrderCount } = require('../../../utils/shop-public-score');

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
    repairProjectKeys: [],
    repairProjectKey: '',
    favored: false,
    pageRootStyle: 'padding-top: 88px',
    scrollIntoReview: '',
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
    const highlightReview = String(options.review_id || '').trim();
    if (highlightReview) this._pendingHighlightReviewId = highlightReview;
    logger.info('进入维修厂详情', { id, review_id: highlightReview || undefined });
    this.loadDetail();
  },

  onShow() {
    showWechatShareMenu();
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

  async loadDetail() {
    this.setData({ loading: true });
    try {
      const shop = await getShopDetail(this.data.shopId);
      const stats = shop.review_stats || {};
      const deviationRate = parseFloat(shop.deviation_rate) || 0;
      const deviationClass = getDeviationClass(deviationRate);
      const { scoreToStarDisplay } = require('../../../utils/shop-score-display');
      const scoreRow = buildOwnerSideScoreRow(shop);
      const starDisplay = scoreToStarDisplay(shop.shop_score, shop.rating);

      const products = (shop.products || []).map((p) => {
        const imgs = p.images || [];
        return {
          ...p,
          cover: imgs[0] || '',
          priceText: (parseFloat(p.price) || 0).toFixed(2)
        };
      });

      const orderN = getShopOrderCount(shop);
      const insufficientRatingLine =
        orderN > 0 ? INSUFFICIENT_SAMPLE_HINT + ' · ' + orderN + '单' : INSUFFICIENT_SAMPLE_HINT;

      this.setData({
        shop: {
          ...shop,
          logo: shop.logo || '/images/brand/brand-app-icon-zhejian.png',
          categories: shop.categories || [],
          certifications: shop.certifications || [],
          services: shop.services || [],
          products,
          deviationRate: deviationRate.toFixed(1),
          deviationClass,
          showPublicScore: scoreRow.showPublicScore,
          avgRating: starDisplay.scoreText,
          starsDisplay: starDisplay.stars,
          totalReviews: stats.total_reviews || 0,
          total_orders: orderN,
          insufficientRatingLine
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
    const { shopId, reviews, reviewPage, hasMoreReviews, loadingReviews, repairProjectKey } = this.data;
    if (!hasMoreReviews || loadingReviews) return;

    this.setData({ loadingReviews: true });
    try {
      const params = { page: reviewPage, limit: 10, sort: 'completeness' };
      if (repairProjectKey) params.repair_project_item = repairProjectKey;
      const res = await getShopReviews(shopId, params);
      const list = res?.list || [];
      const total = res?.total || 0;
      const keys = res?.repair_project_keys || [];

      const mapped = list.map((r) => {
        const rating = parseFloat(r.rating) || 0;
        const content = r.content || '';
        const amt = r.amount;
        const amountText = amt != null ? (Number.isInteger(amt) ? String(amt) : amt.toFixed(2)) : '';
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
          contentPreview: content.length > 60 ? content.slice(0, 60) + '...' : content,
          expanded: false,
          liked: !!r.is_liked,
          disliked: !!r.is_disliked,
          dislike_count: r.dislike_count ?? 0,
          order_id: r.order_id,
          is_my_review: !!r.is_my_review,
          ratingText: '★'.repeat(Math.floor(rating)) + '☆'.repeat(5 - Math.floor(rating)),
          dateText: formatDate(r.created_at),
          isLowRating: rating > 0 && rating < 4,
          amountText,
          objQ1,
          objQ2,
          objQ3,
          hasObjectives,
          objectiveSummary,
          reviewFormVersion3,
          systemChecks,
          partsMerchantVerifyLine,
        });
      });

      const merged = reviewPage === 1 ? mapped : [...reviews, ...mapped];
      const updates = {
        reviews: merged,
        reviewPage: reviewPage + 1,
        reviewTotal: total,
        hasMoreReviews: merged.length < total,
        loadingReviews: false
      };
      if (reviewPage === 1 && keys.length > 0) updates.repairProjectKeys = keys;
      this.setData(updates, () => this._maybeScrollToHighlightReview());
    } catch (err) {
      logger.error('加载评价失败', err);
      this.setData({ loadingReviews: false });
    }
  },

  onRepairProjectFilter(e) {
    const key = e.currentTarget.dataset.key || '';
    const cur = this.data.repairProjectKey;
    if (key === cur) return;
    this._pendingHighlightReviewId = '';
    this.setData({
      repairProjectKey: key,
      reviews: [],
      reviewPage: 1,
      hasMoreReviews: true
    }, () => this.loadReviews());
  },

  /** 分享落地含 review_id 时，分页加载后滚到对应评价 */
  _maybeScrollToHighlightReview() {
    const tid = this._pendingHighlightReviewId;
    if (!tid || this.data.loadingReviews) return;
    const list = this.data.reviews || [];
    const found = list.some((r) => r && r.review_id === tid);
    if (!found) {
      if (this.data.hasMoreReviews) {
        this.loadReviews();
      } else {
        this._pendingHighlightReviewId = '';
      }
      return;
    }
    this._pendingHighlightReviewId = '';
    const into = 'review-' + tid;
    this.setData({ scrollIntoReview: into }, () => {
      setTimeout(() => this.setData({ scrollIntoReview: '' }), 900);
    });
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

  async onBook() {
    const shopId = this.data.shopId;
    await runUserBookingFlow({
      context: 'shop',
      shopId,
      fetchBookingOptions: () => getShopBookingOptions(shopId),
      getShopProducts: () => this.data.shop?.products || [],
      loginRedirect: '/pages/shop/detail/index?id=' + encodeURIComponent(shopId)
    });
  },

  onProductTap(e) {
    const id = (e.currentTarget.dataset.id || '').trim();
    if (!id) return;
    navigation.navigateTo('/pages/shop/product/confirm/index', {
      shop_id: this.data.shopId,
      product_id: id
    });
  },

  onFavorite() {
    this.setData({ favored: !this.data.favored });
    ui.showSuccess(this.data.favored ? '已收藏' : '已取消收藏');
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

  onToggleShopQuoteJourney(e) {
    const d = e.detail || {};
    let idx =
      d.index != null
        ? d.index
        : e.currentTarget.dataset.index != null
          ? e.currentTarget.dataset.index
          : e.currentTarget.dataset.ridx;
    idx = typeof idx === 'number' ? idx : parseInt(idx, 10);
    const reviews = [...this.data.reviews];
    if (Number.isNaN(idx) || !reviews[idx]) return;
    reviews[idx].quoteJourneyExpanded = !reviews[idx].quoteJourneyExpanded;
    this.setData({ reviews });
  },

  onToggleReviewImages(e) {
    const d = e.detail || {};
    let idx =
      d.index != null
        ? d.index
        : e.currentTarget.dataset.index != null
          ? e.currentTarget.dataset.index
          : e.currentTarget.dataset.ridx;
    idx = typeof idx === 'number' ? idx : parseInt(idx, 10);
    const reviews = [...this.data.reviews];
    if (Number.isNaN(idx) || !reviews[idx]) return;
    reviews[idx].showReviewImages = !reviews[idx].showReviewImages;
    this.setData({ reviews });
    if (reviews[idx].showReviewImages) {
      setTimeout(() => this.startReadingObserver(reviews[idx].review_id), 100);
    }
  },

  onTogglePubV3Expand(e) {
    const d = e.detail || {};
    let idx = d.index != null ? d.index : e.currentTarget.dataset.index;
    idx = typeof idx === 'number' ? idx : parseInt(idx, 10);
    const key = (d.key != null ? d.key : e.currentTarget.dataset.key) || '';
    const reviews = [...this.data.reviews];
    const r = reviews[idx];
    if (Number.isNaN(idx) || !r || !r.pubExpand || !key) return;
    const pe = { ...r.pubExpand, [key]: !r.pubExpand[key] };
    r.pubExpand = pe;
    this.setData({ reviews });
    if (pe[key]) {
      setTimeout(() => this.startReadingObserver(r.review_id), 100);
    }
  },

  onPreviewReviewImagesRow(e) {
    const d = e.detail || {};
    let idx =
      d.index != null
        ? d.index
        : e.currentTarget.dataset.index != null
          ? e.currentTarget.dataset.index
          : e.currentTarget.dataset.ridx;
    idx = typeof idx === 'number' ? idx : parseInt(idx, 10);
    const group = (d.group != null ? d.group : e.currentTarget.dataset.group) || '';
    const current = (d.current != null ? d.current : e.currentTarget.dataset.current) || '';
    const rev = this.data.reviews[idx];
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

  onPreviewShopQuotePhoto(e) {
    const d = e.detail || {};
    let idx =
      d.index != null
        ? d.index
        : e.currentTarget.dataset.index != null
          ? e.currentTarget.dataset.index
          : e.currentTarget.dataset.ridx;
    idx = typeof idx === 'number' ? idx : parseInt(idx, 10);
    let qpidx = d.qpidx != null ? d.qpidx : e.currentTarget.dataset.qpidx;
    qpidx = typeof qpidx === 'number' ? qpidx : parseInt(qpidx, 10);
    const url = d.url != null ? d.url : e.currentTarget.dataset.url;
    const rev = this.data.reviews[idx];
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

  onAppealTap(e) {
    const orderId = e.currentTarget.dataset.orderId;
    if (orderId) navigation.navigateTo('/pages/order/detail/index', { id: orderId });
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

  /** 代理人分销：分享店铺或单条评价，路径带 ref */
  onShareAppMessage(res) {
    const sid = this.data.shopId;
    const shopName = this.data.shop && this.data.shop.name;
    if (res.from === 'button') {
      const ds = res.target && res.target.dataset;
      const rid = ds && ds.reviewId ? String(ds.reviewId).trim() : '';
      if (rid && sid) {
        return {
          title: SHARE_TITLES.review,
          path: buildReferralSharePath('/pages/shop/detail/index', { id: sid, review_id: rid })
        };
      }
    }
    return {
      title: shopName ? `辙见 · ${shopName}` : SHARE_TITLES.shop,
      path: buildReferralSharePath('/pages/shop/detail/index', { id: sid })
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

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  const now = new Date();
  const diff = now - d;
  if (diff < 86400000) return '今天';
  if (diff < 172800000) return '昨天';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
