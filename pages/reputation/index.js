// 口碑首页 - 口碑好店
const { getLogger } = require('../../utils/logger');
const ui = require('../../utils/ui');
const navigation = require('../../utils/navigation');
const { getShopsSearch } = require('../../utils/api');
const { fetchAndApplyUnreadBadge } = require('../../utils/message-badge');
const { getNavBarHeight, getSystemInfo } = require('../../utils/util');

const logger = getLogger('Reputation');
const { scoreToStarDisplay } = require('../../utils/shop-score-display');

function mapShopItem(s, idx) {
  const starDisplay = scoreToStarDisplay(s.shop_score, s.rating);
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
  return {
    shop_id: s.shop_id,
    name: s.name,
    logo: s.logo || '/images/logo/logo_white.png',
    rating: starDisplay.scoreText,
    starsDisplay: starDisplay.stars,
    scoreNum: starDisplay.score,
    orderCount: s.total_orders || s.rating_count || 0,
    is_certified: s.is_certified,
    badgeText,
    badgeClass,
    locationText,
    latestReviewSummary: s.latest_review_summary || null,
    latestReviewNegative: !!s.latest_review_negative
  };
}

Page({
  data: {
    loading: false,
    reputationShops: [],
    scrollHeight: 500,
    scrollStyle: 'height: 500px',
    pageRootStyle: 'padding-top: 88px',
    refreshing: false
  },

  onLoad() {
    logger.info('口碑页加载');
    const navH = getNavBarHeight();
    this.setData({ pageRootStyle: 'padding-top: ' + navH + 'px' });
    this.initScrollHeight(navH);
    this.loadData();
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    fetchAndApplyUnreadBadge();
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh());
  },

  onPullRefresh() {
    this.setData({ refreshing: true });
    this.loadData().finally(() => this.setData({ refreshing: false }));
  },

  initScrollHeight(navBarHeight) {
    try {
      const sys = getSystemInfo();
      const headerPx = (180 * sys.windowWidth) / 750;
      const h = sys.windowHeight - (navBarHeight || getNavBarHeight()) - headerPx;
      this.setData({ scrollHeight: h, scrollStyle: 'height: ' + h + 'px' });
    } catch (e) {
      logger.warn('获取窗口高度失败', e);
    }
  },

  async loadData() {
    this.setData({ loading: true });
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
      this.setData({ loading: false });
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
  }
});
