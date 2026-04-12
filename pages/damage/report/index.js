// 定损报告详情（从历史进入）
const { getDamageReport } = require('../../../utils/api');
const { getNavBarHeight, getSystemInfo } = require('../../../utils/util');

function mergeHumanDisplay(ar) {
  const empty = { obvious_damage: [], possible_damage: [], repair_advice: [] };
  if (!ar || typeof ar !== 'object') return empty;
  const vi = Array.isArray(ar.vehicle_info) ? ar.vehicle_info : [];
  if (vi.length === 0) {
    const h = ar.human_display;
    if (h && typeof h === 'object') {
      return {
        obvious_damage: Array.isArray(h.obvious_damage) ? h.obvious_damage : [],
        possible_damage: Array.isArray(h.possible_damage) ? h.possible_damage : [],
        repair_advice: Array.isArray(h.repair_advice) ? h.repair_advice : []
      };
    }
    return empty;
  }
  const o = [];
  const p = [];
  const r = [];
  const multi = vi.length > 1;
  for (const v of vi) {
    const h = v.human_display;
    if (!h || typeof h !== 'object') continue;
    const vid = (v.vehicleId || '').trim();
    const prefix = multi && vid ? `（${vid}）` : '';
    (h.obvious_damage || []).forEach((t) => o.push(prefix + t));
    (h.possible_damage || []).forEach((t) => p.push(prefix + t));
    (h.repair_advice || []).forEach((t) => r.push(prefix + t));
  }
  return { obvious_damage: o, possible_damage: p, repair_advice: r };
}

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
    const sys = getSystemInfo();
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
        repair_suggestions: ar.repair_suggestions || [],
        human_display: mergeHumanDisplay(ar)
      };
      this.setData({ report, reportId: id, loading: false });
    } catch (err) {
      console.error('加载报告失败', err);
      this.setData({ loading: false, error: err.message || '加载失败' });
    }
  }
});
