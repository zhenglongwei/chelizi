// 首页 - 以《设计规范.md》、docs/pages/01-首页.md 为准
const { getLogger } = require('../../utils/logger');
const ui = require('../../utils/ui');
const navigation = require('../../utils/navigation');
const { getShopsNearby, getToken } = require('../../utils/api');
const { fetchAndApplyUnreadBadge } = require('../../utils/message-badge');
const { getNavBarHeight, getSystemInfo } = require('../../utils/util');
const { showWechatShareMenu } = require('../../utils/show-share-menu');

const logger = getLogger('Index');

const AI_ENTRY_REDIRECT = '/pages/ai-diagnosis/index';

// 快捷入口
const QUICK_ENTRIES = [
  { id: 1, name: '钣金喷漆', icon: '🎨', category: '钣金喷漆' },
  { id: 2, name: '发动机维修', icon: '⚙️', category: '发动机维修' },
  { id: 3, name: '电路维修', icon: '⚡', category: '电路维修' },
  { id: 4, name: '保养服务', icon: '🔧', category: '保养服务' }
];

const { buildOwnerSideScoreRow } = require('../../utils/shop-public-score');

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

function shopToAdSlide(s, idx) {
  return {
    id: 'shop-' + s.shop_id,
    type: 'shop',
    shop_id: s.shop_id,
    name: s.name,
    logo: s.logo || '/images/brand/brand-app-icon-zhejian.png',
    rating: s.rating,
    starsDisplay: s.starsDisplay,
    orderCount: s.orderCount,
    bgStyle: 'background: linear-gradient(135deg, #1E293B 0%, #334155 100%)'
  };
}

Page({
  data: {
    loading: false,
    quickEntries: QUICK_ENTRIES,
    nearbyGoodShops: [],
    locationDenied: false,
    scrollHeight: 600,
    scrollStyle: 'height: 600px',
    refreshing: false,
    pageRootStyle: 'padding-top: 88px'
  },

  onLoad() {
    logger.info('首页加载');
    const navH = getNavBarHeight();
    this.setData({ pageRootStyle: 'padding-top: ' + navH + 'px' });
    this.initScrollHeight(navH);
    this.loadData();
  },

  onShow() {
    logger.debug('首页显示');
    showWechatShareMenu();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    fetchAndApplyUnreadBadge();
  },

  onPullDownRefresh() {
    this.loadData().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  onPullRefresh() {
    this.setData({ refreshing: true });
    this.loadData().finally(() => {
      this.setData({ refreshing: false });
    });
  },

  initScrollHeight(navBarHeight) {
    try {
      const sys = getSystemInfo();
      const adHeightPx = (300 * sys.windowWidth) / 750;
      const h = sys.windowHeight - (navBarHeight || getNavBarHeight()) - adHeightPx;
      this.setData({ scrollHeight: h, scrollStyle: 'height: ' + h + 'px' });
    } catch (e) {
      logger.warn('获取窗口高度失败', e);
    }
  },

  async loadData() {
    this.setData({ loading: true });
    try {
      await this.fetchNearbyGoodShops();
    } catch (err) {
      logger.error('首页数据加载失败', err);
      ui.showError(err.message || '加载失败，请重试');
      this.setData({ nearbyGoodShops: [] });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 附近好店：5km 内口碑排行前 10，无则 10km，无则提示「附近暂无店铺」 */
  async fetchNearbyGoodShops() {
    try {
      const app = getApp();
      const cached = app.getCachedLocation();
      if (!cached) {
        this.setData({ nearbyGoodShops: [], locationDenied: true });
        this.showLocationGuideIfFirst();
        return;
      }
      const lat = cached.latitude;
      const lng = cached.longitude;
      this.setData({ locationDenied: false });
      // 先试 5km，口碑排行前 10；无则 10km
      for (const maxKm of [5, 10]) {
        const params = { limit: 10, latitude: lat, longitude: lng, max_km: maxKm, sort: 'default' };
        const res = await getShopsNearby(params);
        const rawList = res?.list || [];
        if (rawList.length > 0) {
          const list = rawList.map((s, idx) => mapShopItem(s, idx));
          this.setData({ nearbyGoodShops: list });
          logger.info('[首页-附近好店] 加载', { maxKm, count: list.length });
          return;
        }
      }
      this.setData({ nearbyGoodShops: [] });
      logger.info('[首页-附近好店] 5km/10km 内均无店铺');
    } catch (err) {
      logger.error('附近好店加载失败', err);
      this.setData({ nearbyGoodShops: [] });
      if (err && err.domainBlocked && err.userHint) {
        ui.showError(err.userHint, 4000);
      }
    }
  },

  // 首次无位置时弹窗说明
  showLocationGuideIfFirst() {
    const shown = wx.getStorageSync('index_location_guide_shown');
    if (shown) return;
    wx.setStorageSync('index_location_guide_shown', true);
    ui.showConfirm({
      title: '选择位置',
      content: '选择您的位置后，可查看附近的维修厂，获得更精准的推荐。',
      confirmText: '去选择',
      cancelText: '暂不',
      success: (res) => {
        if (res.confirm) this.onChooseLocation();
      }
    });
  },

  // 打开地图选择位置（不依赖 getLocation 授权）
  onChooseLocation() {
    logger.info('用户点击选择位置');
    const app = getApp();
    app.chooseLocation()
      .then(() => {
        this.setData({ locationDenied: false });
        this.loadData();
        ui.showSuccess('已选择位置');
        logger.info('位置选择成功，已重新加载');
      })
      .catch((err) => {
        if (err.errMsg && !err.errMsg.includes('cancel')) {
          ui.showError('选择位置失败');
        }
      });
  },

  onAiEntryTap() {
    logger.info('点击 AI 分析入口（登录后进入独立页面）');
    if (!getToken()) {
      navigation.navigateTo('/pages/auth/login/index', { redirect: AI_ENTRY_REDIRECT });
      return;
    }
    navigation.navigateTo(AI_ENTRY_REDIRECT);
  },

  onSearchTap() {
    navigation.navigateTo('/pages/search/list/index');
  },

  onQuickEntryTap(e) {
    const item = e.currentTarget.dataset.item;
    logger.info('点击快捷入口', item?.name);
    navigation.navigateTo('/pages/search/list/index', { category: item?.category || '' });
  },

  goToMoreShops() {
    navigation.navigateTo('/pages/search/list/index');
  },

  goToShopDetail(e) {
    const shopId = e.currentTarget.dataset.id;
    if (!shopId) return;
    logger.info('点击维修厂', shopId);
    navigation.navigateTo('/pages/shop/detail/index', { id: shopId });
  },

  /** 代理人分销：分享小程序首页，路径带 ref（登录用户为推荐人） */
  onShareAppMessage() {
    const { buildReferralSharePath, SHARE_TITLES } = require('../../utils/referral-share');
    return {
      title: SHARE_TITLES.home,
      path: buildReferralSharePath('/pages/index/index')
    };
  }
});
