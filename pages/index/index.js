// 首页 - 以《设计规范.md》、docs/pages/01-首页.md 为准
const { getLogger } = require('../../utils/logger');
const ui = require('../../utils/ui');
const navigation = require('../../utils/navigation');
const { getShopsNearby } = require('../../utils/api');
const { getNavBarHeight } = require('../../utils/util');

const logger = getLogger('Index');

// 平台简介轮播（广告区静态项，intro-2 点击进入定损页）
const INTRO_SLIDES = [
  { id: 'intro-1', type: 'intro', title: '事故车维修平台', desc: '专业维修 · 透明报价', bgStyle: 'background: linear-gradient(135deg, #2563EB 0%, #60A5FA 100%)' },
  { id: 'intro-2', type: 'intro', action: 'damage', title: 'AI 智能定损', desc: '上传事故照片，获取专业分析报告', bgStyle: 'background: linear-gradient(135deg, #3B82F6 0%, #93C5FD 100%)' }
];

// 快捷入口
const QUICK_ENTRIES = [
  { id: 1, name: '钣金喷漆', icon: '🎨', category: '钣金喷漆' },
  { id: 2, name: '发动机维修', icon: '⚙️', category: '发动机维修' },
  { id: 3, name: '电路维修', icon: '⚡', category: '电路维修' },
  { id: 4, name: '保养服务', icon: '🔧', category: '保养服务' }
];

function mapShopItem(s, idx) {
  const rating = parseFloat(s.rating) || 5;
  const starFull = Math.floor(rating);
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
    rating: rating.toFixed(1),
    starsFull: '★'.repeat(starFull),
    starsEmpty: '☆'.repeat(5 - starFull),
    orderCount: s.total_orders || s.rating_count || 0,
    is_certified: s.is_certified,
    badgeText,
    badgeClass,
    locationText
  };
}

function shopToAdSlide(s, idx) {
  return {
    id: 'shop-' + s.shop_id,
    type: 'shop',
    shop_id: s.shop_id,
    name: s.name,
    logo: s.logo || '/images/logo/logo_white1.png',
    rating: s.rating,
    starsFull: s.starsFull,
    starsEmpty: s.starsEmpty,
    orderCount: s.orderCount,
    bgStyle: 'background: linear-gradient(135deg, #1E293B 0%, #334155 100%)'
  };
}

Page({
  data: {
    loading: false,
    quickEntries: QUICK_ENTRIES,
    adSlides: [],
    nearbyShops: [],
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
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
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
      const sys = wx.getSystemInfoSync();
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
      await this.fetchNearbyShops();
      await this.fetchAdSlides();
    } catch (err) {
      logger.error('首页数据加载失败', err);
      ui.showError(err.message || '加载失败，请重试');
      this.setData({ nearbyShops: [], adSlides: [] });
    } finally {
      this.setData({ loading: false });
    }
  },

  async fetchNearbyShops() {
    try {
      const app = getApp();
      const cached = app.getCachedLocation();
      if (!cached) {
        this.setData({ nearbyShops: [], locationDenied: true });
        this.showLocationGuideIfFirst();
        return;
      }
      const lat = cached.latitude;
      const lng = cached.longitude;
      this.setData({ locationDenied: false });
      const params = { limit: 10, latitude: lat, longitude: lng };
      // max_km 由后台系统配置 nearby_max_km 控制
      logger.info('[首页-位置] 用户位置', { lat, lng, params });
      const res = await getShopsNearby(params);
      const rawList = res?.list || [];
      const list = rawList.map((s, idx) => mapShopItem(s, idx));
      this.setData({ nearbyShops: list });
      const preview = rawList.slice(0, 3).map(s => `${s.name}: ${s.distance != null ? s.distance + 'km' : '?'}`);
      logger.info('[首页-位置] 附近维修厂', { count: list.length, 前3条: preview.join(' | ') });
      if (list.length === 0) logger.warn('[首页-位置] 附近无维修厂，可尝试搜索或调整后台最大距离');
    } catch (err) {
      logger.error('获取附近维修厂失败', err);
      this.setData({ nearbyShops: [] });
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

  async fetchAdSlides() {
    try {
      const res = await getShopsNearby({ limit: 5 });
      const rawList = res?.list || [];
      const recommended = rawList
        .filter(s => s.is_certified || (parseFloat(s.rating) || 0) >= 4.5)
        .slice(0, 3)
        .map((s, idx) => mapShopItem(s, idx))
        .map(s => shopToAdSlide(s));
      const adSlides = [...INTRO_SLIDES, ...recommended];
      this.setData({ adSlides });
      logger.info('广告区轮播加载成功', { count: adSlides.length });
    } catch (err) {
      logger.error('获取广告区轮播失败', err);
      this.setData({ adSlides: INTRO_SLIDES });
    }
  },

  onAdSlideTap(e) {
    const { type, action, shopId } = e.currentTarget.dataset;
    if (type === 'shop' && shopId) {
      logger.info('点击推荐商家', shopId);
      navigation.navigateTo('/pages/shop/detail/index', { id: shopId });
    } else if (type === 'intro' && action === 'damage') {
      logger.info('点击 AI 定损入口');
      navigation.navigateTo('/pages/damage/upload/index');
    }
  },

  goToDamage() {
    logger.info('点击 AI 定损入口');
    navigation.navigateTo('/pages/damage/upload/index');
  },

  onSearchTap() {
    navigation.switchTab('/pages/search/list/index');
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
  }
});
