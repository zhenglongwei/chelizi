// 店铺综合得分：单维度规则与行动
const ui = require('../../../../utils/ui');
const { getMerchantToken, getMerchantDashboard } = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');
const { getDimensionConfig, isValidDimensionKey } = require('../score-dimension-config');

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    title: '',
    rulesParagraphs: [],
    actions: [],
    currentLines: []
  },

  onLoad(options) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    const key = (options.key || '').trim();
    if (!isValidDimensionKey(key)) {
      ui.showWarning('参数错误');
      setTimeout(() => wx.navigateBack(), 400);
      return;
    }
    this.dimensionKey = key;
    const cfg = getDimensionConfig(key);
    this.setData({
      title: cfg.title,
      rulesParagraphs: cfg.rulesParagraphs,
      actions: cfg.actions
    });
  },

  onShow() {
    if (!getMerchantToken()) {
      wx.redirectTo({
        url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/score/dimension/index?key=' + (this.dimensionKey || ''))
      });
      return;
    }
    if (this.dimensionKey) this.loadCurrentSnapshot();
  },

  async loadCurrentSnapshot() {
    const key = this.dimensionKey;
    try {
      const res = await getMerchantDashboard();
      const d = res.shop_score_detail;
      const lines = [];
      if (!d) {
        this.setData({ currentLines: [{ label: '说明', value: '暂无得分数据' }] });
        return;
      }
      if (key === 'base_reputation') {
        lines.push({
          label: '口碑基础分',
          value: (d.base_score != null ? d.base_score : '—') + ' 分'
        });
        if (d.effective_review_count != null) {
          lines.push({
            label: '计入得分的有效评价条数',
            value: String(d.effective_review_count)
          });
        }
        if (d.star_display) {
          lines.push({ label: '对应展示星级', value: d.star_display + '（' + (d.star_short || '') + '）' });
        }
      } else {
        const item = (d.hard_items || []).find((x) => x.key === key);
        if (item) {
          lines.push({
            label: '本项得分影响',
            value: (Number(item.value) > 0 ? '+' : '') + item.value + ' 分'
          });
          if (item.hint) {
            lines.push({ label: '系统说明', value: item.hint });
          }
        } else {
          lines.push({ label: '说明', value: '暂无该项明细或当前不适用' });
        }
      }
      this.setData({ currentLines: lines });
    } catch (_) {
      this.setData({ currentLines: [{ label: '说明', value: '加载当前数据失败，请返回重试' }] });
    }
  },

  onActionTap(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.navigateTo({ url });
  }
});
