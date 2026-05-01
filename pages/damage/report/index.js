// 定损报告详情（从历史进入）
const { getDamageReport, createDamageReportShareToken, getCapabilities } = require('../../../utils/api');
const { getNavBarHeight, getSystemInfo } = require('../../../utils/util');
const { buildAccidentReportViewModel } = require('../../../utils/accident-report-presenter');
const navigation = require('../../../utils/navigation');

Page({
  data: {
    scrollStyle: 'height: 600px',
    reportId: '',
    report: null,
    reportVm: null,
    loading: true,
    error: '',
    pageRootStyle: 'padding-top: 88px',
    shareToken: '',
    caps: null
  },

  onLoad(options) {
    const id = options.id || options.report_id || '';
    const navH = getNavBarHeight();
    const sys = getSystemInfo();
    this.setData({ reportId: id, pageRootStyle: 'padding-top: ' + navH + 'px', scrollStyle: 'height: ' + (sys.windowHeight - navH - 20) + 'px' });
    if (id) {
      this.loadReport(id);
      this.loadCapabilities();
    } else {
      this.setData({ loading: false, error: '报告ID无效' });
    }
  },

  async loadCapabilities() {
    try {
      const caps = await getCapabilities();
      this.setData({ caps });
    } catch (_) {
      this.setData({ caps: null });
    }
  },

  async loadReport(id) {
    this.setData({ loading: true, error: '' });
    try {
      const res = await getDamageReport(id);
      const ar = res.analysis_result || res;
      const viMeta = res.vehicle_info && typeof res.vehicle_info === 'object' ? res.vehicle_info : {};
      const focusId = viMeta.analysis_focus_vehicle_id || '';
      const report = {
        report_id: res.report_id,
        status: res.status != null ? res.status : 0,
        damage_level: ar.damage_level,
        total_estimate: ar.total_estimate || res.total_estimate,
        warranty: ar.warranty,
        damages: ar.damages || [],
        repair_suggestions: ar.repair_suggestions || [],
      };
      let reportVm = null;
      if (res.display_vm && typeof res.display_vm === 'object' && Array.isArray(res.display_vm.sections)) {
        reportVm = {
          mode: 'miniapp',
          sections: res.display_vm.sections,
          disclaimer: res.display_vm.disclaimer || '',
        };
      } else {
        reportVm = buildAccidentReportViewModel({
          mode: 'miniapp',
          analysis_result: ar,
          analysis_focus_vehicle_id: focusId,
        });
      }
      this.setData({ report, reportVm, reportId: id, loading: false });
      // 预生成分享 token，避免用户分享时落到 fallback 路径
      this.ensureShareTokenSilent(id);
    } catch (err) {
      console.error('加载报告失败', err);
      this.setData({ loading: false, error: err.message || '加载失败' });
    }
  }
  ,

  /** 历史报告：直接进入发起竞价（不重复 AI） */
  onGoBidding() {
    const reportId = this.data.reportId;
    if (!reportId) return;
    try {
      wx.setStorageSync('pendingReportId', reportId);
      wx.removeStorageSync('pendingRecreateMode');
    } catch (_) {}
    navigation.switchTab('/pages/damage/upload/index');
  },

  async onPrepareShare() {
    const reportId = this.data.reportId;
    if (!reportId) return;
    try {
      wx.showLoading({ title: '生成分享链接…' });
      const res = await createDamageReportShareToken(reportId);
      const token = res && res.token ? res.token : '';
      if (!token) throw new Error('分享生成失败');
      this.setData({ shareToken: token });
      wx.hideLoading();
      wx.showToast({ title: '可点击右上角转发', icon: 'none', duration: 1800 });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: err.message || '分享暂不可用', icon: 'none' });
    }
  },

  async ensureShareTokenSilent(reportId) {
    const rid = String(reportId || this.data.reportId || '').trim();
    if (!rid || this.data.shareToken) return;
    try {
      const res = await createDamageReportShareToken(rid);
      const token = res && res.token ? res.token : '';
      if (token) this.setData({ shareToken: token });
    } catch (_) {}
  },

  onShareAppMessage() {
    const token = this.data.shareToken;
    if (token) {
      return {
        title: '损失报告（AI）摘要（仅供参考）',
        path: '/pages/damage/share/index?token=' + encodeURIComponent(token),
      };
    }
    return {
      title: '事故车预报价（仅供参考）',
      path: '/pages/index/index',
    };
  }
});
