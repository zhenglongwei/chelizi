// 定损报告详情（从历史进入）
const { getDamageReport } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

Page({
  data: {
    scrollStyle: 'height: 600px',
    reportId: '',
    report: null,
    loading: true,
    error: '',
    pageRootStyle: 'padding-top: 88px'
  },

  onLoad(options) {
    const id = options.id || options.report_id || '';
    const navH = getNavBarHeight();
    const sys = wx.getSystemInfoSync();
    this.setData({ reportId: id, pageRootStyle: 'padding-top: ' + navH + 'px', scrollStyle: 'height: ' + (sys.windowHeight - navH - 20) + 'px' });
    if (id) {
      this.loadReport(id);
    } else {
      this.setData({ loading: false, error: '报告ID无效' });
    }
  },

  async loadReport(id) {
    this.setData({ loading: true, error: '' });
    try {
      const res = await getDamageReport(id);
      const ar = res.analysis_result || res;
      const report = {
        report_id: res.report_id,
        damage_level: ar.damage_level,
        total_estimate: ar.total_estimate || res.total_estimate,
        warranty: ar.warranty,
        damages: ar.damages || [],
        repair_suggestions: ar.repair_suggestions || []
      };
      this.setData({ report, reportId: id, loading: false });
    } catch (err) {
      console.error('加载报告失败', err);
      this.setData({ loading: false, error: err.message || '加载失败' });
    }
  }
});
