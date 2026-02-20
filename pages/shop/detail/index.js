// 维修厂详情页 - 04-维修厂详情页
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const { getShopDetail, getShopReviews } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

const logger = getLogger('ShopDetail');

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
    pageRootStyle: 'padding-top: 88px'
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
        return {
          ...r,
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
