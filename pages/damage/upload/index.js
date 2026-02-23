// AI定损页 - 02-AI定损页
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const { getToken, getUserId, uploadImage, analyzeDamage, createBidding, getDamageReport, updateUserProfile, getUserProfile, getDamageDailyQuota } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

const logger = getLogger('DamageUpload');

const ACCIDENT_TYPES = [
  { value: 'single', label: '单方事故', hint: '选自家的保险公司', needSelf: true, needOther: false },
  { value: 'self_fault', label: '己方全责', hint: '选自家的保险公司', needSelf: true, needOther: false },
  { value: 'other_fault', label: '对方全责', hint: '选对家的保险公司', needSelf: false, needOther: true },
  { value: 'other_main', label: '对方主责', hint: '选对方和自己的保险公司都选上', needSelf: true, needOther: true, mainNote: '对方主责' },
  { value: 'self_main', label: '己方主责', hint: '选对方和自己的保险公司都选上', needSelf: true, needOther: true, mainNote: '己方主责' }
];

const INSURANCE_COMPANIES = [
  '请选择',
  '中国人民财产保险', '平安财产保险', '太平洋财产保险', '中国人寿财产保险',
  '阳光财产保险', '中国大地财产保险', '中华财险', '众安保险', '天安财产保险公司',
  '永安财产保险', '浙商财产保险', '永诚财产保险公司', '都邦财产保险', '太平财产保险公司',
  '利宝保险', '华泰财险', '中银保险', '鼎和财产保险', '渤海财产保险', '亚太财产保险',
  '华安财产保险', '英大泰和财产保险公司', '大家财险', '现代财产保险', '安盛天平财产保险',
  '紫金财产保险公司', '安诚财产保险', '国泰财产保险', '中意财产保险'
];

Page({
    data: {
    scrollHeight: 600,
    scrollStyle: 'height: 600px',
    hasToken: false,
    step: 1,
    images: [],
    imageUrls: [],
    vehicleInfo: { plate_number: '', brand: '', model: '' },
    analyzing: false,
    analyzeProgress: 0,
    progressStyle: 'width: 0%',
    reportId: '',
    report: null,
    vehiclesList: [],
    selectedVehicleIndex: 0,
    vehicleEdits: {},
    plateMatchInput: '',
    currentDamages: [],
    currentRepairSuggestions: [],
    currentDamageLevel: '',
    currentTotalEstimate: [0, 0],
    rangeKm: 5,
    isInsurance: false,
    accidentTypes: ACCIDENT_TYPES,
    accidentTypeIndex: 0,
    insuranceCompanies: INSURANCE_COMPANIES,
    insuranceCompanyIndex: 0,
    insuranceCompanyOtherIndex: 0,
    submitting: false,
    locationAddress: '',
    locationLat: null,
    locationLng: null,
    pageRootStyle: 'padding-top: 88px',
    dailyQuota: { remaining: 3, used: 0, limit: 3 }
  },

  onLoad(options) {
    const navH = getNavBarHeight();
    this.setData({ pageRootStyle: 'padding-top: ' + navH + 'px' });
    const sys = wx.getSystemInfoSync();
    const h = sys.windowHeight - navH - 140;
    this.setData({ scrollHeight: h, scrollStyle: 'height: ' + h + 'px' });
    this.checkToken();
    if (getToken()) this._loadDailyQuota();
    const reportId = options.id || options.report_id;
    if (reportId && getToken()) {
      this.loadReportAndShowStep2(reportId);
    }
  },

  onShow() {
    this.checkToken();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    // 返回页面时重置提交状态，避免从竞价详情返回后仍显示「提交中」
    if (this.data.step === 2 && this.data.submitting) {
      this.setData({ submitting: false });
    }
    // 每次显示时从统一缓存同步地址（首页选地址后切回定损页可带出）
    this._loadBiddingLocation();
    // 从定损历史跳转过来（tab 页无法传参，用 storage 传递 report id）
    const pendingId = wx.getStorageSync('pendingReportId');
    if (pendingId) {
      wx.removeStorageSync('pendingReportId');
      this.loadReportAndShowStep2(pendingId);
    }
    if (this.data.step === 1 && getToken()) this._loadDailyQuota();
  },

  async _loadDailyQuota() {
    if (!getToken()) return;
    try {
      const q = await getDamageDailyQuota();
      this.setData({ dailyQuota: { remaining: q.remaining, used: q.used, limit: q.limit } });
    } catch (err) {
      logger.warn('获取定损配额失败', err);
    }
  },

  checkToken() {
    const token = getToken();
    this.setData({ hasToken: !!token });
  },

  onChooseImage() {
    const remain = 8 - this.data.images.length;
    if (remain <= 0) {
      ui.showWarning('最多上传 8 张照片');
      return;
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = (res.tempFiles || []).slice(0, remain);
        const newPaths = files.map((f) => f.tempFilePath);
        const images = [...this.data.images, ...newPaths];
        this.setData({ images });
      },
      fail: (err) => {
        if (err.errMsg && !err.errMsg.includes('cancel')) {
          logger.error('选择图片失败', err);
          ui.showError('选择图片失败');
        }
      }
    });
  },

  onDelImage(e) {
    const idx = e.currentTarget.dataset.index;
    const images = [...this.data.images];
    images.splice(idx, 1);
    const imageUrls = [...this.data.imageUrls];
    imageUrls.splice(idx, 1);
    this.setData({ images, imageUrls });
  },

  onPlateInput(e) {
    this.setData({ 'vehicleInfo.plate_number': (e.detail.value || '').trim() });
  },
  onBrandInput(e) {
    this.setData({ 'vehicleInfo.brand': (e.detail.value || '').trim() });
  },
  onModelInput(e) {
    this.setData({ 'vehicleInfo.model': (e.detail.value || '').trim() });
  },
  

  async onStartAnalyze() {
    const { images, vehicleInfo, analyzing, hasToken, dailyQuota } = this.data;
    if (!hasToken) {
      ui.showWarning('请先登录');
      return;
    }
    if ((dailyQuota?.remaining ?? 1) <= 0) {
      ui.showWarning('今日定损次数已用完，请明日再试');
      return;
    }
    if (!images.length) {
      ui.showWarning('请上传事故照片');
      return;
    }
    if (images.length < 2) {
      ui.showWarning('请至少上传 2 张照片');
      return;
    }
    if (analyzing) return;

    this.setData({ analyzing: true, analyzeProgress: 0, progressStyle: 'width: 0%' });

    try {
      const progressStep = 60 / images.length;
      const imageUrls = [];

      for (let i = 0; i < images.length; i++) {
        const url = await uploadImage(images[i]);
        imageUrls.push(url);
        const p = Math.round(20 + progressStep * (i + 1));
        this.setData({
          analyzeProgress: p,
          progressStyle: 'width: ' + p + '%',
          imageUrls
        });
      }

      this.setData({ analyzeProgress: 85, progressStyle: 'width: 85%' });

      const result = await analyzeDamage({
        user_id: getUserId(),
        images: imageUrls,
        vehicle_info: {
          plate_number: vehicleInfo.plate_number || undefined,
          brand: vehicleInfo.brand || undefined,
          model: vehicleInfo.model || undefined,
        }
      });

      const vehiclesList = this._normalizeVehiclesList(result.vehicle_info, result);
      const quota = { remaining: result.remainingCount ?? 0, used: (result.maxCount ?? 3) - (result.remainingCount ?? 0), limit: result.maxCount ?? 3 };
      this.setData({
        analyzeProgress: 100,
        progressStyle: 'width: 100%',
        reportId: result.report_id,
        report: result,
        vehiclesList,
        selectedVehicleIndex: 0,
        vehicleEdits: {},
        step: 2,
        analyzing: false,
        dailyQuota: quota
      }, () => {
        this._updateVehicleDisplay(0);
      });
    } catch (err) {
      logger.error('AI 分析失败', err);
      ui.showError(err.message || '分析失败');
      this.setData({ analyzing: false, analyzeProgress: 0, progressStyle: 'width: 0%' });
    }
  },

  onRangeTap(e) {
    const v = parseInt(e.currentTarget.dataset.value, 10);
    this.setData({ rangeKm: isNaN(v) ? 0 : v });
  },

  onInsuranceTap(e) {
    const v = e.currentTarget.dataset.value;
    this.setData({ isInsurance: v === 'true' || v === true });
  },

  onAccidentChange(e) {
    const idx = parseInt(e.detail.value, 10) || 0;
    this.setData({ accidentTypeIndex: idx });
  },

  onInsuranceCompanyChange(e) {
    const idx = parseInt(e.detail.value, 10) || -1;
    this.setData({ insuranceCompanyIndex: idx });
  },

  onInsuranceCompanyOtherChange(e) {
    const idx = parseInt(e.detail.value, 10) || -1;
    this.setData({ insuranceCompanyOtherIndex: idx });
  },

  onVehicleTabTap(e) {
    const idx = e.currentTarget.dataset.index;
    this._updateVehicleDisplay(idx);
    this.setData({ selectedVehicleIndex: idx });
  },

  /** 根据车牌号、车型、颜色等匹配车辆索引（车牌可能识别错误，综合匹配） */
  onPlateMatchInput(e) {
    const input = (e.detail.value || '').trim();
    if (!input) return;
    const { vehiclesList } = this.data;
    const idx = this._matchVehicleByInput(input, vehiclesList);
    if (idx >= 0) {
      this._updateVehicleDisplay(idx);
      this.setData({ selectedVehicleIndex: idx, plateMatchInput: input });
    }
  },

  _normalizePlate(s) {
    return (s || '').replace(/[\s·\-]/g, '').toUpperCase();
  },

  _matchVehicleByInput(input, vehiclesList) {
    if (!vehiclesList || !vehiclesList.length) return -1;
    const norm = this._normalizePlate(input);
    const inputDesc = (input || '').replace(/[\s·\-]/g, '').toLowerCase();
    if (!norm && !inputDesc) return -1;
    for (let i = 0; i < vehiclesList.length; i++) {
      const v = vehiclesList[i];
      const vPlate = this._normalizePlate(v.plateNumber || v.plate_number);
      if (vPlate && norm && (vPlate.includes(norm) || norm.includes(vPlate))) return i;
      const vDesc = [v.brand, v.model, v.color].filter(Boolean).join('').toLowerCase();
      if (vDesc && inputDesc && (vDesc.includes(inputDesc) || inputDesc.includes(vDesc))) return i;
    }
    return -1;
  },

  _computePerVehicleEstimate(vehicleId, repairSuggestions) {
    const list = Array.isArray(repairSuggestions) ? repairSuggestions : [];
    let sumMin = 0, sumMax = 0;
    for (const r of list) {
      const item = (r.item || '').trim();
      if (!item.startsWith(vehicleId + '-') && !item.startsWith(vehicleId + '：')) continue;
      const pr = r.price_range;
      if (Array.isArray(pr) && pr.length >= 2) {
        sumMin += (parseFloat(pr[0]) || 0);
        sumMax += (parseFloat(pr[1]) || 0);
      }
    }
    return [sumMin, sumMax];
  },

  _normalizeVehiclesList(vehicleInfo, result) {
    const ar = result?.analysis_result || result || {};
    const damages = ar.damages || [];
    const repairSuggestions = ar.repair_suggestions || [];
    const arr = Array.isArray(vehicleInfo) ? vehicleInfo : [];
    if (arr.length > 0) {
      return arr.map((v, i) => {
        const vid = v.vehicleId || '车辆' + (i + 1);
        const vehicleDamages = damages.filter((d) => (d.vehicleId || '') === vid);
        const [estMin, estMax] = this._computePerVehicleEstimate(vid, repairSuggestions);
        const hasDamage = vehicleDamages.length > 0;
        const sev = v.overallSeverity || '中等';
        const damageLevel = !hasDamage ? '无伤' : (sev === '轻微' ? '一级' : sev === '严重' ? '三级' : '二级');
        return {
          vehicleId: vid,
          plateNumber: v.plate_number ?? v.plateNumber ?? '',
          brand: v.brand ?? '',
          model: v.model ?? '',
          color: v.color ?? '',
          damagedParts: v.damagedParts || [],
          damageTypes: v.damageTypes || [],
          overallSeverity: sev,
          damageSummary: v.damageSummary || '',
          damage_level: damageLevel,
          total_estimate: [estMin, estMax]
        };
      });
    }
    const single = vehicleInfo && typeof vehicleInfo === 'object' ? vehicleInfo : {};
    const vi = ar.vehicle_info;
    const arr2 = Array.isArray(vi) ? vi : [];
    if (arr2.length > 0) {
      return arr2.map((v, i) => {
        const vid = v.vehicleId || '车辆' + (i + 1);
        const vehicleDamages = damages.filter((d) => (d.vehicleId || '') === vid);
        const [estMin, estMax] = this._computePerVehicleEstimate(vid, repairSuggestions);
        const hasDamage = vehicleDamages.length > 0;
        const sev = v.overallSeverity || '中等';
        const damageLevel = !hasDamage ? '无伤' : (sev === '轻微' ? '一级' : sev === '严重' ? '三级' : '二级');
        return {
          vehicleId: vid,
          plateNumber: v.plate_number ?? v.plateNumber ?? '',
          brand: v.brand ?? '',
          model: v.model ?? '',
          color: v.color ?? '',
          damagedParts: v.damagedParts || [],
          damageTypes: v.damageTypes || [],
          overallSeverity: sev,
          damageSummary: v.damageSummary || '',
          damage_level: damageLevel,
          total_estimate: [estMin, estMax]
        };
      });
    }
    const totalEst = ar.total_estimate || [0, 0];
    const dLevel = ar.damage_level || '中等';
    return [{
      vehicleId: '车辆1',
      plateNumber: single.plate_number || single.plateNumber || '',
      brand: single.brand || '',
      model: single.model || '',
      color: single.color || '',
      damagedParts: [],
      damageTypes: [],
      overallSeverity: '中等',
      damageSummary: '',
      damage_level: dLevel === '无伤' ? '无伤' : (dLevel === '一级' ? '一级' : dLevel === '三级' ? '三级' : '二级'),
      total_estimate: Array.isArray(totalEst) && totalEst.length >= 2 ? totalEst : [0, 0]
    }];
  },

  _updateVehicleDisplay(selectedIndex) {
    const { report, vehiclesList } = this.data;
    if (!report || !vehiclesList.length) return;
    const v = vehiclesList[selectedIndex];
    const vehicleId = v?.vehicleId || '车辆' + (selectedIndex + 1);
    const isMulti = vehiclesList.length > 1;
    const ar = report?.analysis_result || report;
    const damages = (ar.damages || report?.damages || []).filter((d) => {
      if (!isMulti) return true;
      return (d.vehicleId || '') === vehicleId;
    });
    const repairSuggestions = (ar.repair_suggestions || report?.repair_suggestions || []).filter((r) => {
      if (!isMulti) return true;
      const item = r.item || '';
      return item.startsWith(vehicleId + '-') || item.startsWith(vehicleId + '：');
    });
    const damageLevel = v?.damage_level || ar.damage_level || report?.damage_level || '';
    const totalEst = v?.total_estimate || ar.total_estimate || report?.total_estimate || [0, 0];
    const currentTotalEstimate = Array.isArray(totalEst) && totalEst.length >= 2 ? totalEst : [0, 0];
    this.setData({
      currentDamages: damages,
      currentRepairSuggestions: repairSuggestions,
      currentDamageLevel: damageLevel,
      currentTotalEstimate
    });
  },

  onReportPlateInput(e) {
    const { index } = e.currentTarget.dataset;
    const key = 'vehicleEdits.' + index + '.plate_number';
    this.setData({ [key]: (e.detail.value || '').trim() });
  },
  onReportBrandInput(e) {
    const { index } = e.currentTarget.dataset;
    const key = 'vehicleEdits.' + index + '.brand';
    this.setData({ [key]: (e.detail.value || '').trim() });
  },
  onReportModelInput(e) {
    const { index } = e.currentTarget.dataset;
    const key = 'vehicleEdits.' + index + '.model';
    this.setData({ [key]: (e.detail.value || '').trim() });
  },

  /** 加载询价位置（统一缓存 user_chosen_location，无则从用户资料拉取并回填） */
  _loadBiddingLocation() {
    try {
      const stored = wx.getStorageSync('user_chosen_location');
      if (stored && stored.latitude != null && stored.longitude != null) {
        const addr = stored.address || stored.name || null;
        this.setData({
          locationAddress: addr || '已选择位置（点击查看地图）',
          locationLat: stored.latitude,
          locationLng: stored.longitude
        });
        return;
      }
      if (getToken()) {
        getUserProfile().then((p) => {
          if (p && p.location && p.location.latitude != null && p.location.longitude != null) {
            const addr = [p.location.province, p.location.city, p.location.district].filter(Boolean).join('') ||
              p.location.address || p.location.name || null;
            const loc = {
              latitude: p.location.latitude,
              longitude: p.location.longitude,
              address: addr || p.location.address,
              name: p.location.name
            };
            this.setData({
              locationAddress: addr || '已选择位置（点击查看地图）',
              locationLat: loc.latitude,
              locationLng: loc.longitude
            });
            try {
              wx.setStorageSync('user_chosen_location', loc);
            } catch (_) {}
          }
        }).catch(() => {});
      }
    } catch (_) {}
  },

  /** 点击询价位置：已选择则打开地图查看，未选择则打开选择 */
  onChooseBiddingLocation() {
    const { locationLat, locationLng } = this.data;
    if (locationLat != null && locationLng != null) {
      this._openLocationOnMap();
    } else {
      this._openChooseLocation();
    }
  },

  /** 打开地图查看已选位置 */
  _openLocationOnMap() {
    const { locationAddress, locationLat, locationLng } = this.data;
    if (locationLat == null || locationLng == null) return;
    wx.openLocation({
      latitude: locationLat,
      longitude: locationLng,
      name: locationAddress || '询价位置',
      address: locationAddress || '',
      scale: 18
    });
  },

  /** 重新选择询价位置 */
  async onRechooseBiddingLocation() {
    await this._openChooseLocation();
  },

  /** 打开地图选择位置 */
  async _openChooseLocation() {
    const app = getApp();
    try {
      const loc = await app.chooseLocation();
      if (!loc || loc.latitude == null || loc.longitude == null) return;
      const addr = loc.address || loc.name || '已选择位置';
      this.setData({
        locationAddress: addr,
        locationLat: loc.latitude,
        locationLng: loc.longitude
      });
      if (getToken()) {
        await updateUserProfile({ latitude: loc.latitude, longitude: loc.longitude });
      }
      ui.showSuccess('已选择位置');
    } catch (err) {
      if (err.errMsg && !err.errMsg.includes('cancel')) {
        logger.error('选择位置失败', err);
        ui.showError('选择位置失败');
      }
    }
  },

  async loadReportAndShowStep2(reportId) {
    try {
      const res = await getDamageReport(reportId);
      const ar = res.analysis_result || {};
      const vehiclesList = this._normalizeVehiclesList(ar.vehicle_info, { analysis_result: ar, vehicle_info: res.vehicle_info });
      const damages = ar.damages || [];
      const totalEst = ar.total_estimate || [0, 0];
      let damageLevel = ar.damage_level;
      if (damageLevel === '三级' && (!damages.length || (totalEst[0] === 0 && totalEst[1] === 0))) {
        damageLevel = '无伤';
      }
      const report = {
        report_id: res.report_id,
        damages,
        damage_level: damageLevel,
        warranty: damageLevel === '无伤' ? '经照片分析未发现明显损伤，建议实车查勘确认' : ar.warranty,
        total_estimate: totalEst,
        repair_suggestions: ar.repair_suggestions || []
      };
      this.setData({
        reportId: res.report_id,
        report,
        vehiclesList,
        selectedVehicleIndex: 0,
        vehicleEdits: {},
        images: (res.images || []).slice(0, 4),
        imageUrls: res.images || [],
        step: 2
      }, () => {
        this._updateVehicleDisplay(0);
        this._loadBiddingLocation();
      });
    } catch (err) {
      logger.error('加载报告失败', err);
      ui.showError(err.message || '加载报告失败');
    }
  },

  onCloseReport() {
    ui.showSuccess('已关闭，历史记录可查');
    this.setData({
      step: 1,
      report: null,
      reportId: '',
      vehiclesList: [],
      selectedVehicleIndex: 0,
      vehicleEdits: {},
      plateMatchInput: '',
      currentDamages: [],
      currentRepairSuggestions: [],
      submitting: false
    });
    this._loadDailyQuota();
  },

  async onCreateBidding() {
    const { reportId, report, vehicleInfo, vehiclesList, selectedVehicleIndex, vehicleEdits, rangeKm, isInsurance, accidentTypeIndex, insuranceCompanyIndex, insuranceCompanyOtherIndex, insuranceCompanies, accidentTypes, submitting, locationLat, locationLng } = this.data;
    if (!reportId || submitting) return;

    if (!getToken()) {
      ui.showWarning('请先登录');
      return;
    }

    if (isInsurance) {
      const accType = accidentTypes[accidentTypeIndex];
      const selfOk = !accType?.needSelf || insuranceCompanyIndex > 0;
      const otherOk = !accType?.needOther || insuranceCompanyOtherIndex > 0;
      if (!selfOk || !otherOk) {
        ui.showWarning('请选择对应的保险公司');
        return;
      }
    }

    // 位置必填：优先用已选位置，否则尝试实时定位
    let latitude = locationLat;
    let longitude = locationLng;
    if (latitude == null || longitude == null) {
      try {
        const loc = await new Promise((resolve, reject) => {
          wx.getLocation({ type: 'gcj02', success: resolve, fail: reject });
        });
        if (loc && loc.latitude != null && loc.longitude != null) {
          latitude = loc.latitude;
          longitude = loc.longitude;
        }
      } catch (locErr) {
        logger.warn('获取位置失败', locErr);
        ui.showWarning('请先选择询价位置，附近服务商才能收到您的询价');
        return;
      }
    }
    if (latitude == null || longitude == null) {
      ui.showWarning('请先选择询价位置，附近服务商才能收到您的询价');
      return;
    }

    const v = vehiclesList[selectedVehicleIndex];
    const edits = vehicleEdits[selectedVehicleIndex] || {};
    const bidVehicleInfo = {
      plate_number: (edits.plate_number !== undefined ? edits.plate_number : (v?.plateNumber || vehicleInfo.plate_number || '')).trim(),
      brand: edits.brand !== undefined ? edits.brand : (v?.brand || ''),
      model: edits.model !== undefined ? edits.model : (v?.model || vehicleInfo.model || '')
    };

    if (!bidVehicleInfo.plate_number) {
      ui.showWarning('请填写车牌号');
      return;
    }

    this.setData({ submitting: true });
    try {

      const accType = accidentTypes[accidentTypeIndex];
      const selfCompany = insuranceCompanyIndex > 0 ? insuranceCompanies[insuranceCompanyIndex] : '';
      const otherCompany = insuranceCompanyOtherIndex > 0 ? insuranceCompanies[insuranceCompanyOtherIndex] : '';
      const needBoth = accType?.needSelf && accType?.needOther;
      const insurance_info = isInsurance
        ? {
            is_insurance: true,
            accident_type: accType?.value || 'single',
            insurance_company: accType?.needSelf ? selfCompany : otherCompany,
            insurance_company_other: needBoth ? (accType?.needSelf ? otherCompany : selfCompany) : undefined,
            main_responsible: accType?.mainNote || undefined
          }
        : { is_insurance: false };

      const res = await createBidding({
        report_id: reportId,
        range: rangeKm === 0 ? 999 : (rangeKm || 5),
        insurance_info,
        vehicle_info: {
          plate_number: bidVehicleInfo.plate_number || undefined,
          brand: bidVehicleInfo.brand || undefined,
          model: bidVehicleInfo.model || undefined
        },
        latitude,
        longitude
      });

      ui.showSuccess(res.duplicate ? '该定损单已发起竞价，正在跳转' : '竞价发起成功');
      this.setData({ submitting: false });
      navigation.navigateTo('/pages/bidding/detail/index', { id: res.bidding_id });
    } catch (err) {
      logger.error('发起竞价失败', err);
      ui.showError(err.message || '发起失败');
      this.setData({ submitting: false });
    }
  }
});
