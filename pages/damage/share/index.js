const { getSharedDamageReport } = require('../../../utils/api');
const { getNavBarHeight, getSystemInfo } = require('../../../utils/util');
const { buildAccidentReportViewModel } = require('../../../utils/accident-report-presenter');

Page({
  data: {
    scrollStyle: 'height: 600px',
    token: '',
    report: null,
    loading: true,
    error: '',
    pageRootStyle: 'padding-top: 88px',
  },

  onLoad(options) {
    const token = options.token || '';
    const navH = getNavBarHeight();
    const sys = getSystemInfo();
    this.setData({
      token,
      pageRootStyle: 'padding-top: ' + navH + 'px',
      scrollStyle: 'height: ' + (sys.windowHeight - navH - 20) + 'px',
    });
    if (!token) {
      this.setData({ loading: false, error: '分享链接无效或已过期' });
      return;
    }
    this.loadReport(token);
  },

  async loadReport(token) {
    this.setData({ loading: true, error: '' });
    try {
      const res = await getSharedDamageReport(token);
      const ar = res.analysis_result || {};
      const viMeta = res.vehicle_info && typeof res.vehicle_info === 'object' ? res.vehicle_info : {};
      const focusId = viMeta.analysis_focus_vehicle_id || '';
      const report = {
        report_id: res.report_id,
        damage_level: ar.damage_level,
        total_estimate: ar.total_estimate,
        warranty: ar.warranty,
        damages: ar.damages || [],
        repair_suggestions: ar.repair_suggestions || [],
      };
      const reportVm = buildAccidentReportViewModel({
        mode: 'share',
        analysis_result: ar,
        analysis_focus_vehicle_id: focusId,
      });
      this.setData({ report, reportVm, loading: false });
    } catch (err) {
      this.setData({ loading: false, error: err.message || '加载失败' });
    }
  },

  onShareAppMessage() {
    const token = this.data.token || '';
    return {
      title: '损失报告（AI）摘要（仅供参考）',
      path: '/pages/damage/share/index?token=' + encodeURIComponent(token),
    };
  },
});

