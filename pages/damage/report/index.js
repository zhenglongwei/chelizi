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
    vehiclesTabs: [],
    selectedVehicleId: '',
    communicationScript: '',
    arrivalNotes: [],
    loading: true,
    error: '',
    pageRootStyle: 'padding-top: 88px',
    shareToken: '',
    caps: null,
    _polling: false,
    _pollCancelToken: 0,
    _rawAnalysisResult: null,
    _rawVehicles: [],
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
      const vehicles = Array.isArray(ar.vehicles) ? ar.vehicles : [];
      const tabs = this._buildVehicleTabs(vehicles, Array.isArray(ar.vehicle_info) ? ar.vehicle_info : []);
      const initialVehicleId = this.data.selectedVehicleId || focusId || (tabs[0] && tabs[0].vehicleId) || '';
      const report = {
        report_id: res.report_id,
        status: res.status != null ? res.status : 0,
        damage_level: ar.damage_level,
        total_estimate: ar.total_estimate || res.total_estimate,
        warranty: ar.warranty,
        damages: ar.damages || [],
        repair_suggestions: ar.repair_suggestions || [],
      };

      const vm = buildAccidentReportViewModel({
        mode: 'miniapp',
        analysis_result: ar,
        analysis_focus_vehicle_id: initialVehicleId || focusId,
      });
      const guidance = this._pickGuidanceForVehicle(vehicles, initialVehicleId);
      this.setData({
        report,
        reportVm: vm,
        vehiclesTabs: tabs,
        selectedVehicleId: initialVehicleId,
        communicationScript: guidance.communicationScript,
        arrivalNotes: guidance.arrivalNotes,
        reportId: id,
        loading: false,
        _rawAnalysisResult: ar,
        _rawVehicles: vehicles,
      });
      if (report.status === 0) this._pollUntilReady(id);
      // 预生成分享 token，避免用户分享时落到 fallback 路径
      this.ensureShareTokenSilent(id);
    } catch (err) {
      console.error('加载报告失败', err);
      this.setData({ loading: false, error: err.message || '加载失败' });
    }
  }
  ,

  _buildVehicleTabs(vehicles, vehicleInfoArray) {
    const out = [];
    const seen = new Set();
    const viArr = Array.isArray(vehicleInfoArray) ? vehicleInfoArray : [];
    const infoById = new Map();
    viArr.forEach((v, i) => {
      const id = String(v.vehicleId || `车辆${i + 1}`).trim() || `车辆${i + 1}`;
      infoById.set(id, v);
    });
    (Array.isArray(vehicles) ? vehicles : []).forEach((v, i) => {
      const id = String(v.vehicleId || `车辆${i + 1}`).trim() || `车辆${i + 1}`;
      if (seen.has(id)) return;
      seen.add(id);
      const meta = infoById.get(id) || v || {};
      const plate = String(meta.plateNumber || meta.plate_number || '').trim();
      const brand = String(meta.brand || '').trim();
      const model = String(meta.model || '').trim();
      const color = String(meta.color || '').trim();
      const title = plate || (brand && model ? `${brand} ${model}` : (brand || model || color || '车辆'));
      const subtitle = [plate, [brand, model].filter(Boolean).join(' '), color].filter(Boolean).join(' · ');
      out.push({ vehicleId: id, title, subtitle });
    });
    if (out.length === 0 && viArr.length) {
      viArr.forEach((v, i) => {
        const id = String(v.vehicleId || `车辆${i + 1}`).trim() || `车辆${i + 1}`;
        const plate = String(v.plateNumber || v.plate_number || '').trim();
        const brand = String(v.brand || '').trim();
        const model = String(v.model || '').trim();
        const color = String(v.color || '').trim();
        const title = plate || (brand && model ? `${brand} ${model}` : (brand || model || color || '车辆'));
        const subtitle = [plate, [brand, model].filter(Boolean).join(' '), color].filter(Boolean).join(' · ');
        out.push({ vehicleId: id, title, subtitle });
      });
    }
    return out;
  },

  _pickGuidanceForVehicle(vehicles, vehicleId) {
    const id = String(vehicleId || '').trim();
    const list = Array.isArray(vehicles) ? vehicles : [];
    const v = list.find((x) => String((x && x.vehicleId) || '').trim() === id) || null;
    const g = v && v.guidance && typeof v.guidance === 'object' ? v.guidance : {};
    const script = String(g.communication_script || '').trim();
    const notes = Array.isArray(g.arrival_notes) ? g.arrival_notes.map((x) => String(x || '').trim()).filter(Boolean) : [];
    return { communicationScript: script, arrivalNotes: notes };
  },

  onVehicleTabTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || id === this.data.selectedVehicleId) return;
    const ar = this.data._rawAnalysisResult;
    const vehicles = this.data._rawVehicles;
    const vm = ar
      ? buildAccidentReportViewModel({ mode: 'miniapp', analysis_result: ar, analysis_focus_vehicle_id: id })
      : this.data.reportVm;
    const guidance = this._pickGuidanceForVehicle(vehicles, id);
    this.setData({
      selectedVehicleId: id,
      reportVm: vm,
      communicationScript: guidance.communicationScript,
      arrivalNotes: guidance.arrivalNotes,
    });
  },

  async onCopyCommunication() {
    const text = String(this.data.communicationScript || '').trim();
    if (!text) {
      wx.showToast({ title: '暂无可复制话术', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' }),
    });
  },

  async _pollUntilReady(reportId) {
    if (this.data._polling) return;
    const token = this.data._pollCancelToken + 1;
    this.setData({ _pollCancelToken: token });
    this.setData({ _polling: true });
    let tries = 0;
    while (tries < 20) {
      tries++;
      await new Promise((r) => setTimeout(r, tries < 8 ? 1200 : 2000));
      if (token !== this.data._pollCancelToken) break;
      try {
        const res = await getDamageReport(reportId);
        const status = res && res.status != null ? res.status : 0;
        if (status !== 0) {
          this.setData({ _polling: false });
          await this.loadReport(reportId);
          return;
        }
      } catch (_) {}
    }
    this.setData({ _polling: false });
  },

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
