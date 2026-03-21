/**
 * 店铺综合得分星级展示（05-店铺综合评价体系 四、星级转换规则）
 * shop_score 为 100 分制；无 shop_score 时可用 rating×20 近似
 */

/**
 * 综合得分转星级展示
 * @param {number} score - 0-100 分制，或 null 时用 rating×20
 * @param {number} [rating] - 0-5 星制，score 为空时使用
 * @returns {{ stars: string, scoreText: string, score: number }}
 */
function scoreToStarDisplay(score, rating) {
  const s = score != null ? parseFloat(score) : (rating != null ? parseFloat(rating) * 20 : 50);
  const scoreNum = Math.max(0, Math.min(100, s));
  let stars;
  if (scoreNum >= 90) stars = '★★★★★';
  else if (scoreNum >= 80) stars = '★★★★☆';
  else if (scoreNum >= 70) stars = '★★★★';
  else if (scoreNum >= 60) stars = '★★★☆';
  else stars = '★★★及以下';
  return {
    stars,
    scoreText: scoreNum.toFixed(1) + '分',
    score: scoreNum
  };
}

module.exports = { scoreToStarDisplay };
