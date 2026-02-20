// 维修厂搜索列表页 - 10-维修厂搜索列表页
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const { getShopsSearch } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

const logger = getLogger('SearchList');

const CATEGORIES = ['钣金喷漆', '发动机维修', '电路维修', '保养服务'];
const SORT_OPTIONS = [
  { value: 'default', label: '综合排序' },
  { value: 'compliance_rate', label: '合规率优先' },
  { value: 'complaint_rate', label: '投诉率低' },
  { value: 'distance', label: '距离优先' },
  { value: 'orders', label: '订单量优先' }
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

Page({
  data: {
    keyword: '',
    category: '',
    categories: CATEGORIES,
    sortIndex: 0,
    sortLabels: SORT_OPTIONS,
    list: [],
    page: 1,
    limit: 10,
    hasMore: true,
    loading: false,
    loadingMore: false,
    refreshing: false,
    searchFocused: false,
    scrollHeight: 500,
    scrollStyle: 'height: 500px',
    emptyTip: '请输入关键词或选择分类搜索',
    pageRootStyle: 'padding-top: 88px'
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
  },

  onLoad(options) {
    const keyword = (options.keyword || '').trim();
    const category = options.category || '';
    let sortIndex = 0;
    if (options.sort) {
      const idx = SORT_OPTIONS.findIndex((o) => o.value === options.sort);
      if (idx >= 0) sortIndex = idx;
    }
    const navH = getNavBarHeight();
    this.setData({ keyword, category, sortIndex, pageRootStyle: 'padding-top: ' + navH + 'px' });
    this.initScrollHeight(navH);
    logger.info('进入搜索列表', { keyword, category });
    this.search();
  },

  initScrollHeight(navBarHeight) {
    try {
      const sys = wx.getSystemInfoSync();
      const headerPx = (220 * sys.windowWidth) / 750;
      const h = sys.windowHeight - (navBarHeight || getNavBarHeight()) - headerPx;
      this.setData({ scrollHeight: h, scrollStyle: 'height: ' + h + 'px' });
    } catch (e) {
      logger.warn('获取窗口高度失败', e);
    }
  },

  focusSearch() {
    this.setData({ searchFocused: true });
  },

  onKeywordInput(e) {
    const keyword = (e.detail.value || '').trim();
    this.setData({ keyword });
    this.searchDebounced();
  },

  onSearchConfirm() {
    this.search();
  },

  clearKeyword() {
    this.setData({ keyword: '' });
    this.search();
  },

  searchDebounced() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.search(), 400);
  },

  async search() {
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
    this.setData({ page: 1, hasMore: true });
    await this.fetchList(true);
  },

  onCategoryTap(e) {
    const category = e.currentTarget.dataset.category || '';
    this.setData({ category });
    this.search();
  },

  onSortChange(e) {
    const idx = parseInt(e.detail.value, 10) || 0;
    this.setData({ sortIndex: idx });
    this.search();
  },

  async fetchList(isRefresh = false) {
    const { keyword, category, sortIndex, page, limit, list, hasMore } = this.data;
    if (!hasMore && !isRefresh) return;

    if (isRefresh) {
      this.setData({ loading: true });
    } else {
      this.setData({ loadingMore: true });
    }

    try {
      const app = getApp();
      let lat = null,
        lng = null;
      const cached = app.getCachedLocation();
      if (cached) {
        lat = cached.latitude;
        lng = cached.longitude;
      }

      const params = {
        page,
        limit,
        sort: SORT_OPTIONS[sortIndex].value
      };
      if (keyword) params.keyword = keyword;
      if (category) params.category = category;
      if (lat && lng) {
        params.latitude = lat;
        params.longitude = lng;
      }

      const res = await getShopsSearch(params);
      const rawList = res?.list || [];
      const mapped = rawList.map((s, i) => mapShopItem(s, i));

      const newList = isRefresh ? mapped : [...list, ...mapped];
      const hasMoreNew = rawList.length >= limit;

      this.setData({
        list: newList,
        hasMore: hasMoreNew,
        page: page + 1,
        emptyTip: newList.length === 0 ? (keyword || category ? '暂无匹配的维修厂' : '请输入关键词或选择分类搜索') : ''
      });

      logger.info('搜索列表加载', { count: mapped.length, total: newList.length });
    } catch (err) {
      logger.error('搜索维修厂失败', err);
      ui.showError(err.message || '加载失败，请重试');
      if (isRefresh) this.setData({ list: [] });
    } finally {
      this.setData({ loading: false, loadingMore: false });
    }
  },

  onPullDownRefresh() {
    this.search().finally(() => wx.stopPullDownRefresh());
  },

  onPullRefresh() {
    this.setData({ refreshing: true });
    this.search().finally(() => this.setData({ refreshing: false }));
  },

  onReachBottom() {
    this.fetchList(false);
  },

  goToDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    logger.info('点击维修厂', id);
    navigation.navigateTo('/pages/shop/detail/index', { id });
  }
});
