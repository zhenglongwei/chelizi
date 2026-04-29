// 口碑榜单页 - 价格最透明 TOP10、师傅最专业 TOP10
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const { getShopsRank } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

const logger = getLogger('ReputationRank');
const { buildOwnerSideScoreRow } = require('../../../utils/shop-public-score');

const DIMENSION_LABELS = {
  price: '价格最透明 TOP10',
  quality: '师傅最专业 TOP10'
};

function mapShopItem(s, idx) {
  const scoreRow = buildOwnerSideScoreRow(s);
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
    rank: idx + 1,
    productSnippetText: s.product_snippet_text || null
  };
}

Page({
  data: {
    loading: true,
    dimension: 'price',
    title: '价格最透明 TOP10',
    list: [],
    pageRootStyle: 'padding-top: 88px'
  },

  onLoad(options) {
    const dimension = options.dimension === 'quality' ? 'quality' : 'price';
    const navH = getNavBarHeight();
    this.setData({
      dimension,
      title: DIMENSION_LABELS[dimension],
      pageRootStyle: 'padding-top: ' + navH + 'px'
    });
    this.loadData();
  },

  async loadData() {
    this.setData({ loading: true });
    try {
      const { dimension } = this.data;
      const res = await getShopsRank({ dimension, limit: 10 });
      const rawList = res?.list || [];
      const list = rawList.map((s, idx) => mapShopItem(s, idx));
      this.setData({ list });
      logger.info('榜单加载', { dimension, count: list.length });
    } catch (err) {
      logger.error('榜单加载失败', err);
      ui.showError(err.message || '加载失败，请重试');
      this.setData({ list: [] });
    } finally {
      this.setData({ loading: false });
    }
  },

  goToShopDetail(e) {
    const shopId = e.currentTarget.dataset.id;
    if (!shopId) return;
    logger.info('点击维修厂', shopId);
    navigation.navigateTo('/pages/shop/detail/index', { id: shopId });
  }
});
