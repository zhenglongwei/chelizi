// 店铺综合得分构成列表
const ui = require('../../../utils/ui');
const { getMerchantToken, getMerchantDashboard } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

function mapValueClass(v) {
  const n = Number(v);
  if (n > 0) return 'merchant-score-val-pos';
  if (n < 0) return 'merchant-score-val-neg';
  return 'merchant-score-val-zero';
}

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    loading: true,
    summaryScore: 0,
    starDisplay: '',
    starShort: '',
    scoreRows: [],
    formulaHint: '',
    effectiveReviewCount: null
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
  },

  onShow() {
    if (!getMerchantToken()) {
      wx.redirectTo({
        url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/score/index')
      });
      return;
    }
    this.loadDetail();
  },

  async loadDetail() {
    this.setData({ loading: true });
    try {
      const res = await getMerchantDashboard();
      const d = res.shop_score_detail;
      if (!d) {
        this.setData({ loading: false });
        ui.showWarning('暂无得分数据');
        setTimeout(() => wx.navigateBack(), 400);
        return;
      }
      const rows = [
        {
          key: 'base_reputation',
          label: '口碑基础分',
          valueText: String(d.base_score != null ? d.base_score : '—'),
          subText: '分',
          hint: d.base_hint || '来自有效评价加权与时间衰减',
          valueClass: 'merchant-score-val-zero'
        }
      ];
      (d.hard_items || []).forEach((it) => {
        rows.push({
          key: it.key,
          label: it.label,
          valueText: (Number(it.value) > 0 ? '+' : '') + it.value,
          subText: '分',
          hint: it.hint || '',
          valueClass: mapValueClass(it.value)
        });
      });
      this.setData({
        loading: false,
        summaryScore: d.score,
        starDisplay: d.star_display || '',
        starShort: d.star_short || '',
        scoreRows: rows,
        formulaHint: d.formula_hint || '',
        effectiveReviewCount: d.effective_review_count != null ? d.effective_review_count : null
      });
    } catch (e) {
      this.setData({ loading: false });
      ui.showError((e && e.message) || '加载失败');
      setTimeout(() => wx.navigateBack(), 600);
    }
  },

  onRowTap(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    wx.navigateTo({ url: '/pages/merchant/score/dimension/index?key=' + encodeURIComponent(key) });
  }
});
