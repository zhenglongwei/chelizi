/**
 * 车主端公开展示店铺「综合得分/星级」的规则（与商户后台自见得分无关）。
 */

const { scoreToStarDisplay } = require('./shop-score-display');

/** 订单过少时的统一文案 */
const INSUFFICIENT_SAMPLE_HINT = '订单较少，尚无评分';

/**
 * 成单量达到该值后，才在列表/详情/竞价等处展示星级与分数，避免小样本失真（极高/极低分误导）。
 *
 * 参考（非强制标准，供产品运营取舍）：
 * - 点评/电商常见「有效评价 ≥5～15 条再展示均分」；
 * - 统计学上样本过小则均值方差大，公开展示意义弱。
 * - 辙见默认取 10 单：与详情页「评价排序」等提示（如 ≥5 条）同量级略严一档，可按运营改为远端配置。
 */
const MIN_ORDERS_FOR_PUBLIC_SHOP_SCORE = 10;

function getShopOrderCount(shop) {
  if (!shop || shop.total_orders == null) return 0;
  const n = parseInt(String(shop.total_orders), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function shouldShowPublicShopScore(shop) {
  return getShopOrderCount(shop) >= MIN_ORDERS_FOR_PUBLIC_SHOP_SCORE;
}

/**
 * 车主侧列表、卡片、报价行：星级 + 分数字符串 + 成单数
 * @returns {{ showPublicScore: boolean, starsDisplay: string, rating: string, scoreNum: number, orderCount: number }}
 */
function buildOwnerSideScoreRow(shop) {
  const orderCount = getShopOrderCount(shop);
  if (orderCount < MIN_ORDERS_FOR_PUBLIC_SHOP_SCORE) {
    return {
      showPublicScore: false,
      starsDisplay: '',
      rating: INSUFFICIENT_SAMPLE_HINT,
      scoreNum: 0,
      orderCount
    };
  }
  const starDisplay = scoreToStarDisplay(shop.shop_score, shop.rating);
  return {
    showPublicScore: true,
    starsDisplay: starDisplay.stars,
    rating: starDisplay.scoreText,
    scoreNum: starDisplay.score,
    orderCount
  };
}

module.exports = {
  MIN_ORDERS_FOR_PUBLIC_SHOP_SCORE,
  INSUFFICIENT_SAMPLE_HINT,
  getShopOrderCount,
  shouldShowPublicShopScore,
  buildOwnerSideScoreRow
};
