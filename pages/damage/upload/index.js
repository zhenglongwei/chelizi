// 预报价页（原 AI定损）- 02-AI定损页
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const { getToken, getUserId, uploadImage, analyzeDamage, createDamageReport, createBidding, getDamageReport, updateUserProfile, getUserProfile, getDamageDailyQuota, getUserVehicles, createDamageReportShareToken, getLeadDamageReport, claimDamageReportByToken } = require('../../../utils/api');
// 注：本页已改为系统导航栏，滚动高度使用 flex 布局撑满；不再依赖自定义导航栏高度计算
const { fetchAndApplyUnreadBadge } = require('../../../utils/message-badge');
const { buildAccidentReportViewModel } = require('../../../utils/accident-report-presenter');

const logger = getLogger('DamageUpload');

/**
 * 已是服务端返回的可公网访问地址，无需再 uploadFile。
 * 注意：微信本地临时图在部分环境下会表现为 http://tmp/... ，虽以 http 开头但不是公网 URL，必须走 uploadImage。
 */
function isRemoteImageUrl(pathOrUrl) {
  const s = String(pathOrUrl || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  if (/^https?:\/\/tmp\//i.test(s) || /^https?:\/\/usr\//i.test(s)) return false;
  return true;
}

const ACCIDENT_TYPES = [
  { value: 'single', label: '单方事故', hint: '选自家的保险公司', needSelf: true, needOther: false },
  { value: 'self_fault', label: '己方全责', hint: '选自家的保险公司', needSelf: true, needOther: false },
  { value: 'other_fault', label: '对方全责', hint: '选对家的保险公司', needSelf: false, needOther: true },
  {
    value: 'equal_fault',
    label: '同等责任',
    hint: '须同时选择己方保险公司与对方保险公司',
    needSelf: true,
    needOther: true,
    mainNote: '同等责任'
  },
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
    userDescription: '',
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
    currentHumanDisplay: { obvious_damage: [], possible_damage: [], repair_advice: [] },
    currentRepairSuggestions: [],
    currentDamageLevel: '',
    reportVm: null,
    currentTotalEstimate: [0, 0],
    rangeKm: 5,
    /** 步骤 1/2 必选：'' | 'self' | 'insurance'，禁止默认自费 */
    insuranceChoice: '',
    accidentTypes: ACCIDENT_TYPES,
    accidentTypeIndex: 0,
    insuranceCompanies: INSURANCE_COMPANIES,
    insuranceCompanyIndex: 0,
    insuranceCompanyOtherIndex: 0,
    submitting: false,
    locationAddress: '',
    locationLat: null,
    locationLng: null,
    pageRootStyle: '',
    dailyQuota: { remaining: 3, used: 0, limit: 3 },
    /** 资料中绑定车牌（去重），供聚焦车牌输入时选择填入，非 AI 识别 */
    boundPlateList: [],
    verifiedPlateMismatchHint: '',
    /** 用户在上传/报告 meta 中声明的车牌（发起竞价以该为准，可与 AI 识别不一致） */
    userDeclaredPlate: '',
    /** AI 多车车牌均与用户声明不一致时的强提示 */
    userDeclaredPlateHint: '',
    /** 入口 A 进入 step2 但用户尚未声明车牌时的引导文案 */
    declarePlatePromptHint: '',
    /** AI 识别到的全部车辆（折叠态时仅在 vehiclesList 暴露主车） */
    vehiclesListAll: [],
    /** 全量车辆数量；> 1 且处于折叠态时显示「查看其它车辆」 */
    vehiclesAllCount: 0,
    /** 是否展开全部车辆；命中 focus 时默认 false */
    expandedAllVehicles: true,
    /** 是否折叠到主车（vehiclesAllCount > 1 且 vehiclesList.length === 1） */
    collapsedToFocus: false,
    /** 主车 vehicleId（折叠/展开切换依据） */
    focusVehicleId: '',
    /** 聚焦车牌输入时展示绑定车牌快捷选择 */
    plateSuggestionVisible: false,
    shareToken: '',
    leadToken: ''
  },

  onPromptChip(e) {
    const text = (e.currentTarget.dataset.text || '').trim();
    if (!text) return;
    this.setData({ userDescription: text });
  },

  onLoad(options) {
    /** 用于作废「加载历史报告」的异步请求，避免与「新照片重新定损」竞态覆盖结果 */
    this._reportLoadToken = 0;
    // 预报价页已使用系统导航栏（非 custom-nav-bar），滚动区域用 flex 布局撑满，无需手动计算高度
    this.setData({ pageRootStyle: '', scrollStyle: '' });
    this.checkToken();
    if (getToken()) this._loadDailyQuota();
    const reportId = options.id || options.report_id;
    const leadToken = (options.lead_token || options.leadToken || '').toString().trim();
    if (leadToken) {
      try {
        wx.setStorageSync('pendingLeadToken', leadToken);
      } catch (_) {}
    }
    if (reportId && getToken()) {
      this.loadReportAndShowStep2(reportId);
    }
  },

  onShow() {
    this.checkToken();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    fetchAndApplyUnreadBadge();
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
      const recreateMode = wx.getStorageSync('pendingRecreateMode');
      if (recreateMode) {
        wx.removeStorageSync('pendingRecreateMode');
        // 重新竞价：回到步骤 1，预填历史材料，允许补充后再次提交（会重新入队 AI + 新竞价）
        this.loadReportForRecreate(pendingId);
      } else {
        // 历史报告：直接进入步骤 2，可直接发起竞价（不重复 AI 分析）
        this.loadReportAndShowStep2(pendingId);
      }
    }
    if (this.data.step === 1 && getToken()) this._loadDailyQuota();
    // 外部引流 token：先展示摘要；发起竞价时需登录后认领，否则引导重新上传
    const leadToken = wx.getStorageSync('pendingLeadToken');
    if (leadToken) {
      wx.removeStorageSync('pendingLeadToken');
      this.loadLeadReportByTokenAndShowStep2(leadToken);
    }
    if (this.data.step === 2 && getToken()) {
      this._loadBoundPlateList().then((list) => {
        if (this.data.step !== 2) return;
        const hint = this._computeVerifiedPlateMismatchHint(this.data.vehiclesList, this.data.selectedVehicleIndex, list);
        const all = (this.data.vehiclesListAll && this.data.vehiclesListAll.length) ? this.data.vehiclesListAll : this.data.vehiclesList;
        const userDeclaredPlateHint = this._computeUserDeclaredPlateHint(this.data.userDeclaredPlate, all);
        this.setData({ boundPlateList: list, verifiedPlateMismatchHint: hint, userDeclaredPlateHint });
      });
    }
  },

  async loadLeadReportByTokenAndShowStep2(token) {
    const t = String(token || '').trim();
    if (!t) return;
    const loadToken = ++this._reportLoadToken;
    try {
      const res = await getLeadDamageReport(t);
      if (loadToken !== this._reportLoadToken) return;
      const ar = res.analysis_result || {};
      const viMeta = res.vehicle_info && typeof res.vehicle_info === 'object' ? res.vehicle_info : {};
      const userDeclaredPlate = String(viMeta.plate_number || '').trim();
      const focusFromMeta = String(viMeta.analysis_focus_vehicle_id || '').trim();
      const vehiclesListAll = this._normalizeVehiclesList(ar.vehicle_info, { analysis_result: ar, vehicle_info: res.vehicle_info });
      const focusVehicleId = this._pickFocusVehicleId(vehiclesListAll, userDeclaredPlate, focusFromMeta);
      const shouldCollapse = !!focusVehicleId && vehiclesListAll.length > 1;
      const vehiclesList = shouldCollapse
        ? vehiclesListAll.filter((v) => String(v.vehicleId || '').trim() === focusVehicleId)
        : vehiclesListAll;
      const selectedVehicleIndex = shouldCollapse
        ? 0
        : this._pickInitialVehicleIndex(vehiclesList, userDeclaredPlate);
      const vehicleEdits = {};
      if (userDeclaredPlate && vehiclesList.length) {
        vehicleEdits[selectedVehicleIndex] = { plate_number: userDeclaredPlate };
      }
      const boundPlateList = getToken() ? await this._loadBoundPlateList() : [];
      const verifiedPlateMismatchHint = this._computeVerifiedPlateMismatchHint(vehiclesList, selectedVehicleIndex, boundPlateList);
      const userDeclaredPlateHint = this._computeUserDeclaredPlateHint(userDeclaredPlate, vehiclesListAll);
      const declarePlatePromptHint = !userDeclaredPlate && vehiclesListAll.length > 1
        ? '请先在下方填写您的车牌，以锁定您的车辆，否则可能误锁他人车辆。'
        : '';
      const damages = ar.damages || [];
      const totalEst = ar.total_estimate || [0, 0];
      const report = {
        report_id: res.report_id,
        damages,
        damage_level: ar.damage_level,
        warranty: ar.warranty,
        total_estimate: totalEst,
        repair_suggestions: ar.repair_suggestions || []
      };
      this.setData({
        reportId: res.report_id,
        report,
        vehiclesList,
        vehiclesListAll,
        vehiclesAllCount: vehiclesListAll.length,
        expandedAllVehicles: !shouldCollapse,
        collapsedToFocus: shouldCollapse,
        focusVehicleId,
        selectedVehicleIndex,
        vehicleEdits,
        userDeclaredPlate,
        userDeclaredPlateHint,
        declarePlatePromptHint,
        insuranceChoice: '',
        boundPlateList,
        verifiedPlateMismatchHint,
        plateSuggestionVisible: false,
        images: [],
        imageUrls: [],
        step: 2,
        shareToken: '',
        leadToken: t,
      }, () => {
        this._updateVehicleDisplay(selectedVehicleIndex);
        this._loadBiddingLocation();
      });
    } catch (err) {
      ui.showError(err.message || '加载失败');
    }
  },

  /**
   * 重新竞价：用历史报告预填「照片/描述/车辆信息」，回到步骤 1 允许补充后重新提交
   * - 重新提交会创建新 report 并入队 AI，再创建新竞价进入分发
   */
  async loadReportForRecreate(reportId) {
    const token = ++this._reportLoadToken;
    try {
      const res = await getDamageReport(reportId);
      if (token !== this._reportLoadToken) return;

      let images = [];
      try {
        images = Array.isArray(res.images) ? res.images : JSON.parse(res.images || '[]');
      } catch (_) {
        images = [];
      }
    
      const imageUrls = images.filter(Boolean);

      const vi = (res && res.vehicle_info && typeof res.vehicle_info === 'object') ? res.vehicle_info : {};
      const vehicleInfo = {
        plate_number: String(vi.plate_number || '').trim(),
        brand: String(vi.brand || '').trim(),
        model: String(vi.model || '').trim(),
      };

      this.setData({
        step: 1,
        report: null,
        reportId: '',
        vehiclesList: [],
        vehiclesListAll: [],
        vehiclesAllCount: 0,
        expandedAllVehicles: true,
        collapsedToFocus: false,
        focusVehicleId: '',
        selectedVehicleIndex: 0,
        vehicleEdits: {},
        plateMatchInput: '',
        currentDamages: [],
        currentRepairSuggestions: [],
        submitting: false,
        analyzing: false,
        analyzeProgress: 0,
        progressStyle: 'width: 0%',
        images: imageUrls,
        imageUrls,
        userDescription: (res.user_description || '').trim(),
        vehicleInfo,
        userDeclaredPlate: '',
        userDeclaredPlateHint: '',
        declarePlatePromptHint: '',
        insuranceChoice: '',
      });
      ui.showSuccess('已带入历史材料，可补充后重新提交');
      this._loadDailyQuota();
    } catch (err) {
      logger.error('加载报告用于重新竞价失败', err);
      ui.showError(err.message || '加载历史材料失败');
    }
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

  onDescInput(e) {
    // 不在输入过程中 trim，避免中文输入法/换行体验被截断；提交前再统一 trim
    this.setData({ userDescription: e.detail.value || '' });
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
  

  async onSubmitPreQuote() {
    const { images, analyzing } = this.data;
    if (analyzing) return;
    if (!images || images.length < 1) {
      ui.showWarning('请至少上传 1 张事故照片');
      return;
    }
    if (!getToken()) {
      ui.showWarning('请先登录');
      return;
    }
    const plate = String(this.data.vehicleInfo?.plate_number || '').trim();
    if (!plate) {
      ui.showWarning('请先填写车牌号');
      return;
    }
    const insBuilt = this._buildInsuranceInfoFromForm();
    if (insBuilt.error) {
      ui.showWarning(insBuilt.error);
      return;
    }
    this.setData({ analyzing: true, analyzeProgress: 0, progressStyle: 'width: 0%' });
    try {
      const progressStep = 60 / images.length;
      const imageUrls = [];
      for (let i = 0; i < images.length; i++) {
        const raw = images[i];
        const url = isRemoteImageUrl(raw) ? raw : await uploadImage(raw);
        imageUrls.push(url);
        const p = Math.round(20 + progressStep * (i + 1));
        this.setData({ analyzeProgress: p, progressStyle: 'width: ' + p + '%', imageUrls });
      }
      this.setData({ analyzeProgress: 85, progressStyle: 'width: 85%' });

      const res = await createDamageReport({
        images: imageUrls,
        user_description: (this.data.userDescription || '').trim() || undefined,
        vehicle_info: {
          plate_number: plate,
          brand: String(this.data.vehicleInfo?.brand || '').trim() || undefined,
          model: String(this.data.vehicleInfo?.model || '').trim() || undefined,
        },
        // 与「独立 AI 分析报告」分流：预报价仅后台排队，worker 空闲时处理即可
        analysis_queue: 'background',
      });
      // 创建竞价：定损异步执行（pending），待 worker 判断 relevant 后自动分发
      const { locationLat, locationLng } = this.data;
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
        } catch (_) {}
      }
      if (latitude == null || longitude == null) {
        this.setData({ analyzing: false, analyzeProgress: 0, progressStyle: 'width: 0%' });
        ui.showWarning('请先选择询价位置，附近服务商才能收到您的询价');
        return;
      }

      const biddingRes = await createBidding({
        report_id: res.report_id,
        range: 5,
        insurance_info: insBuilt.info,
        vehicle_info: {
          plate_number: plate,
          brand: String(this.data.vehicleInfo?.brand || '').trim() || undefined,
          model: String(this.data.vehicleInfo?.model || '').trim() || undefined,
        },
        latitude,
        longitude,
      });

      this.setData({ analyzing: false, analyzeProgress: 100, progressStyle: 'width: 100%' });
      ui.showSuccess('已提交，正在分发');
      navigation.redirectTo('/pages/bidding/wait/index', { id: biddingRes?.bidding_id });
    } catch (err) {
      logger.error('跳过分析失败', err);
      ui.showError(err.message || '提交失败');
      this.setData({ analyzing: false, analyzeProgress: 0, progressStyle: 'width: 0%' });
    }
  },

  onRangeTap(e) {
    const v = parseInt(e.currentTarget.dataset.value, 10);
    this.setData({ rangeKm: isNaN(v) ? 0 : v });
  },

  onInsuranceChoiceTap(e) {
    const c = String(e.currentTarget.dataset.choice || '').trim();
    if (c !== 'self' && c !== 'insurance') return;
    this.setData({ insuranceChoice: c });
  },

  /**
   * 构建竞价 insurance_info；未选自费/保险或走保险但保险公司未选全时返回 error。
   */
  _buildInsuranceInfoFromForm() {
    const {
      insuranceChoice,
      accidentTypes,
      accidentTypeIndex,
      insuranceCompanies,
      insuranceCompanyIndex,
      insuranceCompanyOtherIndex
    } = this.data;
    if (insuranceChoice !== 'self' && insuranceChoice !== 'insurance') {
      return { error: '请选择「自费」或「走保险」' };
    }
    if (insuranceChoice === 'self') {
      return { info: { is_insurance: false } };
    }
    const accType = accidentTypes[accidentTypeIndex];
    const selfOk = !accType?.needSelf || insuranceCompanyIndex > 0;
    const otherOk = !accType?.needOther || insuranceCompanyOtherIndex > 0;
    if (!selfOk || !otherOk) {
      return { error: '请选择对应的保险公司' };
    }
    const selfCompany = insuranceCompanyIndex > 0 ? insuranceCompanies[insuranceCompanyIndex] : '';
    const otherCompany = insuranceCompanyOtherIndex > 0 ? insuranceCompanies[insuranceCompanyOtherIndex] : '';
    const needBoth = accType?.needSelf && accType?.needOther;
    return {
      info: {
        is_insurance: true,
        accident_type: accType?.value || 'single',
        insurance_company: accType?.needSelf ? selfCompany : otherCompany,
        insurance_company_other: needBoth ? (accType?.needSelf ? otherCompany : selfCompany) : undefined,
        main_responsible: accType?.mainNote || undefined
      }
    };
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
    const idx = parseInt(e.currentTarget.dataset.index, 10) || 0;
    this._onSelectVehicleIndex(idx);
  },



  _normalizePlate(s) {
    return (s || '').replace(/[\s·\-]/g, '').toUpperCase();
  },

  async _getBoundPlates() {
    try {
      const res = await getUserVehicles();
      return (res?.list || []).map((r) => r.plate_number).filter(Boolean);
    } catch (_) {
      return [];
    }
  },

  /**
   * 拉取绑定车辆车牌列表（与接口顺序一致，按归一化车牌去重，保留首次出现写法）。
   */
  async _loadBoundPlateList() {
    try {
      const res = await getUserVehicles();
      const raw = (res?.list || []).map((r) => String(r.plate_number || '').trim()).filter(Boolean);
      const seen = new Set();
      const list = [];
      for (let i = 0; i < raw.length; i++) {
        const p = raw[i];
        const n = this._normalizePlate(p);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        list.push(p);
      }
      return list;
    } catch (_) {
      return [];
    }
  },

  /**
   * AI 识别到车牌且与任一绑定车牌均不一致时提示；不拦截、不自动改 AI 结果。
   */
  _computeVerifiedPlateMismatchHint(vehiclesList, selectedIndex, boundPlateList) {
    const plates = Array.isArray(boundPlateList) ? boundPlateList.filter((p) => String(p || '').trim()) : [];
    if (!plates.length || !vehiclesList || !vehiclesList.length) return '';
    const v = vehiclesList[selectedIndex];
    if (!v) return '';
    const aiP = String(v.plateNumber || '').trim();
    if (!aiP) return '';
    const aiNorm = this._normalizePlate(aiP);
    if (plates.some((p) => this._normalizePlate(p) === aiNorm)) return '';
    const show = plates.length <= 3 ? plates.join('、') : plates.slice(0, 3).join('、') + ' 等';
    const vid = v.vehicleId ? `（${v.vehicleId}）` : '';
    return `您资料中绑定车牌含 ${show}，AI 识别${vid}为 ${aiP}，请核对。`;
  },

  _onSelectVehicleIndex(idx, extra = {}) {
    if (this._plateBlurTimer) {
      clearTimeout(this._plateBlurTimer);
      this._plateBlurTimer = null;
    }
    this._updateVehicleDisplay(idx);
    const userPlate = String(this.data.userDeclaredPlate || '').trim();
    const vehicleEdits = { ...this.data.vehicleEdits };
    if (userPlate) {
      vehicleEdits[idx] = { ...(vehicleEdits[idx] || {}), plate_number: userPlate };
    }
    const hint = this._computeVerifiedPlateMismatchHint(this.data.vehiclesList, idx, this.data.boundPlateList);
    const userDeclaredPlateHint = this._computeUserDeclaredPlateHint(this.data.userDeclaredPlate, this.data.vehiclesListAll || this.data.vehiclesList);
    this.setData({
      selectedVehicleIndex: idx,
      vehicleEdits,
      verifiedPlateMismatchHint: hint,
      userDeclaredPlateHint,
      plateSuggestionVisible: false,
      ...extra
    });
  },

  /** 折叠 ↔ 展开 step2 的全部车辆 */
  onToggleAllVehicles() {
    const { expandedAllVehicles, focusVehicleId, vehiclesListAll, vehicleEdits, userDeclaredPlate } = this.data;
    if (!Array.isArray(vehiclesListAll) || vehiclesListAll.length <= 1) return;
    if (expandedAllVehicles) {
      // 展开 → 折叠：仅保留主车
      if (!focusVehicleId) return;
      const matchedIdx = vehiclesListAll.findIndex((v) => String(v.vehicleId || '').trim() === focusVehicleId);
      if (matchedIdx < 0) return;
      const collapsedList = [vehiclesListAll[matchedIdx]];
      const newEdits = {};
      const userPlate = String(userDeclaredPlate || '').trim();
      const prevEdit = vehicleEdits && vehicleEdits[matchedIdx] ? vehicleEdits[matchedIdx] : {};
      newEdits[0] = { ...prevEdit };
      if (userPlate) newEdits[0].plate_number = userPlate;
      this.setData({
        vehiclesList: collapsedList,
        selectedVehicleIndex: 0,
        vehicleEdits: newEdits,
        expandedAllVehicles: false,
        collapsedToFocus: true,
      }, () => {
        this._updateVehicleDisplay(0);
      });
    } else {
      // 折叠 → 展开：恢复全量
      const matchedIdx = vehiclesListAll.findIndex((v) => String(v.vehicleId || '').trim() === focusVehicleId);
      const restoredIdx = matchedIdx >= 0 ? matchedIdx : 0;
      // 把折叠态对主车的编辑迁移到展开态对应索引
      const newEdits = {};
      const collapsedEdit = vehicleEdits && vehicleEdits[0] ? vehicleEdits[0] : {};
      if (collapsedEdit && Object.keys(collapsedEdit).length) {
        newEdits[restoredIdx] = { ...collapsedEdit };
      }
      this.setData({
        vehiclesList: vehiclesListAll,
        selectedVehicleIndex: restoredIdx,
        vehicleEdits: newEdits,
        expandedAllVehicles: true,
        collapsedToFocus: false,
      }, () => {
        this._updateVehicleDisplay(restoredIdx);
      });
    }
  },

  onReportPlateFocus() {
    if (this._plateBlurTimer) {
      clearTimeout(this._plateBlurTimer);
      this._plateBlurTimer = null;
    }
    const { boundPlateList } = this.data;
    if (!boundPlateList || !boundPlateList.length) return;
    this.setData({ plateSuggestionVisible: true });
  },

  onReportPlateBlur() {
    this._plateBlurTimer = setTimeout(() => {
      this.setData({ plateSuggestionVisible: false });
      this._plateBlurTimer = null;
    }, 280);
  },

  onPickBoundPlate(e) {
    if (this._plateBlurTimer) {
      clearTimeout(this._plateBlurTimer);
      this._plateBlurTimer = null;
    }
    const plate = String(e.currentTarget.dataset.plate || '').trim();
    const idx = this.data.selectedVehicleIndex;
    if (!plate || idx == null) return;
    const key = 'vehicleEdits.' + idx + '.plate_number';
    this.setData({
      [key]: plate,
      plateSuggestionVisible: false
    });
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

  /** 多车时优先选中与用户声明车牌完全一致的车辆，否则尝试模糊匹配，再否则 0 */
  _pickInitialVehicleIndex(vehiclesList, userPlate) {
    const list = vehiclesList || [];
    if (!list.length) return 0;
    const norm = this._normalizePlate(userPlate);
    if (norm) {
      for (let i = 0; i < list.length; i++) {
        const vp = this._normalizePlate(list[i].plateNumber || list[i].plate_number);
        if (vp && vp === norm) return i;
      }
    }
    const fuzzy = this._matchVehicleByInput(userPlate, list);
    return fuzzy >= 0 ? fuzzy : 0;
  },

  /**
   * 计算 focus vehicleId：优先 analysis_focus_vehicle_id（已落库）→ userDeclaredPlate 精确匹配 → 否则空。
   * 入参 vehiclesList 应为「全量」识别结果。
   */
  _pickFocusVehicleId(vehiclesListAll, userDeclaredPlate, focusFromMeta) {
    const list = Array.isArray(vehiclesListAll) ? vehiclesListAll : [];
    if (!list.length) return '';
    const fid = String(focusFromMeta || '').trim();
    if (fid) {
      const ok = list.some((v) => String(v && v.vehicleId ? v.vehicleId : '').trim() === fid);
      if (ok) return fid;
    }
    const un = this._normalizePlate(userDeclaredPlate);
    if (un) {
      for (const v of list) {
        const vp = this._normalizePlate(v && (v.plateNumber || v.plate_number));
        if (vp && vp === un) return String(v.vehicleId || '').trim();
      }
    }
    return '';
  },

  /** 用户声明车牌与 AI 返回的各车车牌均不一致时提示核对 */
  _computeUserDeclaredPlateHint(userDeclaredPlate, vehiclesList) {
    const u = String(userDeclaredPlate || '').trim();
    if (!u || !vehiclesList || !vehiclesList.length) return '';
    const un = this._normalizePlate(u);
    if (!un) return '';
    const anyMatch = vehiclesList.some((v) => {
      const vp = this._normalizePlate(v.plateNumber || v.plate_number || '');
      return vp && vp === un;
    });
    if (anyMatch) return '';
    return `您填写的车牌为「${u}」，AI 识别结果中的车牌均不一致，请人工选择对应车辆；发起竞价将以您填写的车牌为准，可在下方修改。`;
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
          vehicle_price_tier: v.vehicle_price_tier ?? null,
          vehicle_price_max: v.vehicle_price_max ?? null,
          damagedParts: v.damagedParts || [],
          damageTypes: v.damageTypes || [],
          overallSeverity: sev,
          damageSummary: v.damageSummary || '',
          damage_level: damageLevel,
          total_estimate: [estMin, estMax],
          human_display: v.human_display && typeof v.human_display === 'object'
            ? v.human_display
            : { obvious_damage: [], possible_damage: [], repair_advice: [] }
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
          vehicle_price_tier: v.vehicle_price_tier ?? null,
          vehicle_price_max: v.vehicle_price_max ?? null,
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
    const { report, vehiclesList, vehiclesListAll } = this.data;
    if (!report || !vehiclesList.length) return;
    const v = vehiclesList[selectedIndex];
    const vehicleId = v?.vehicleId || '车辆' + (selectedIndex + 1);
    // 折叠态时 vehiclesList.length === 1 但全量 > 1，仍需按 vehicleId 过滤损伤
    const fullLen = (vehiclesListAll && vehiclesListAll.length) ? vehiclesListAll.length : vehiclesList.length;
    const isMulti = fullLen > 1;
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
    const hd = v?.human_display;
    const currentHumanDisplay =
      hd && typeof hd === 'object'
        ? {
            obvious_damage: Array.isArray(hd.obvious_damage) ? hd.obvious_damage : [],
            possible_damage: Array.isArray(hd.possible_damage) ? hd.possible_damage : [],
            repair_advice: Array.isArray(hd.repair_advice) ? hd.repair_advice : []
          }
        : { obvious_damage: [], possible_damage: [], repair_advice: [] };
    this.setData({
      currentDamages: damages,
      currentHumanDisplay,
      currentRepairSuggestions: repairSuggestions,
      currentDamageLevel: damageLevel,
      currentTotalEstimate,
      reportVm: buildAccidentReportViewModel({ mode: 'miniapp', human_display: currentHumanDisplay })
    });
  },

  onReportPlateInput(e) {
    const { index } = e.currentTarget.dataset;
    const idx = Number(index);
    const value = (e.detail.value || '').trim();
    const key = 'vehicleEdits.' + idx + '.plate_number';
    const patch = { [key]: value };
    // 实时把当前 tab 的车牌同步为 userDeclaredPlate（入口 A 在 step2 才形成「用户声明车牌」）
    const all = Array.isArray(this.data.vehiclesListAll) && this.data.vehiclesListAll.length
      ? this.data.vehiclesListAll
      : this.data.vehiclesList;
    if (idx === this.data.selectedVehicleIndex) {
      patch.userDeclaredPlate = value;
      patch.userDeclaredPlateHint = this._computeUserDeclaredPlateHint(value, all);
      // 重新挑选 focus 候选（不强制折叠，避免打断输入）
      const focus = this._pickFocusVehicleId(all, value, '');
      patch.focusVehicleId = focus;
      // 已声明则清掉 declarePlatePromptHint（折叠按钮的可点性由 focusVehicleId + 全量长度共同决定）
      if (value) patch.declarePlatePromptHint = '';
      else if ((all || []).length > 1) patch.declarePlatePromptHint = '请先在下方填写您的车牌，以锁定您的车辆，否则可能误锁他人车辆。';
    }
    this.setData(patch);
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
    const token = ++this._reportLoadToken;
    try {
      const res = await getDamageReport(reportId);
      if (token !== this._reportLoadToken) {
        return;
      }
      const ar = res.analysis_result || {};
      const metaVehicleInfo = (res && res.vehicle_info && typeof res.vehicle_info === 'object') ? res.vehicle_info : {};
      const focusFromMeta = String(metaVehicleInfo.analysis_focus_vehicle_id || '').trim();
      const userDeclaredPlate = String(metaVehicleInfo.plate_number || '').trim();

      const vehiclesListAll = this._normalizeVehiclesList(ar.vehicle_info, { analysis_result: ar, vehicle_info: res.vehicle_info });
      const focusVehicleId = this._pickFocusVehicleId(vehiclesListAll, userDeclaredPlate, focusFromMeta);
      const shouldCollapse = !!focusVehicleId && vehiclesListAll.length > 1;
      const vehiclesList = shouldCollapse
        ? vehiclesListAll.filter((v) => String(v.vehicleId || '').trim() === focusVehicleId)
        : vehiclesListAll;
      let selectedVehicleIndex = 0;
      if (!shouldCollapse && vehiclesList.length > 1) {
        selectedVehicleIndex = this._pickInitialVehicleIndex(vehiclesList, userDeclaredPlate);
      }
      const vehicleEdits = {};
      if (userDeclaredPlate && vehiclesList.length) {
        vehicleEdits[selectedVehicleIndex] = { plate_number: userDeclaredPlate };
      }
      const userDeclaredPlateHint = this._computeUserDeclaredPlateHint(userDeclaredPlate, vehiclesListAll);
      const declarePlatePromptHint = !userDeclaredPlate && vehiclesListAll.length > 1
        ? '请先在下方填写您的车牌，以锁定您的车辆，否则可能误锁他人车辆。'
        : '';
      const boundPlateList = await this._loadBoundPlateList();
      const verifiedPlateMismatchHint = this._computeVerifiedPlateMismatchHint(vehiclesList, selectedVehicleIndex, boundPlateList);
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
      // 历史报告的 res.images 为网络 URL，勿写入 images：images 仅用于本地上传路径，否则关闭报告回到步骤 1 后会误用 uploadFile 导致 file not found
      this.setData({
        reportId: res.report_id,
        report,
        vehiclesList,
        vehiclesListAll,
        vehiclesAllCount: vehiclesListAll.length,
        expandedAllVehicles: !shouldCollapse,
        collapsedToFocus: shouldCollapse,
        focusVehicleId,
        selectedVehicleIndex,
        vehicleEdits,
        userDeclaredPlate,
        userDeclaredPlateHint,
        declarePlatePromptHint,
        insuranceChoice: '',
        boundPlateList,
        plateSuggestionVisible: false,
        verifiedPlateMismatchHint,
        images: [],
        imageUrls: [],
        step: 2,
        shareToken: ''
      }, () => {
        this._updateVehicleDisplay(selectedVehicleIndex);
        this._loadBiddingLocation();
        this.ensureShareTokenSilent(res.report_id);
      });
    } catch (err) {
      logger.error('加载报告失败', err);
      ui.showError(err.message || '加载报告失败');
    }
  },

  onCloseReport() {
    // 关闭后可能立即选新图定损，作废尚未返回的历史报告请求
    this._reportLoadToken = (this._reportLoadToken || 0) + 1;
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
      submitting: false,
      images: [],
      imageUrls: [],
      analyzeProgress: 0,
      progressStyle: 'width: 0%',
      vehicleInfo: { plate_number: '', brand: '', model: '' },
      boundPlateList: [],
      verifiedPlateMismatchHint: '',
      userDeclaredPlate: '',
      userDeclaredPlateHint: '',
      declarePlatePromptHint: '',
      vehiclesListAll: [],
      vehiclesAllCount: 0,
      expandedAllVehicles: true,
      collapsedToFocus: false,
      focusVehicleId: '',
      insuranceChoice: '',
      plateSuggestionVisible: false,
      leadToken: ''
    });
    this._loadDailyQuota();
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
      ui.showSuccess('可点击转发');
    } catch (err) {
      wx.hideLoading();
      ui.showError(err.message || '分享暂不可用');
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
  },

  async onCreateBidding() {
    const { reportId, report, vehicleInfo, vehiclesList, selectedVehicleIndex, vehicleEdits, rangeKm, submitting, locationLat, locationLng, leadToken } = this.data;
    if (!reportId || submitting) return;

    if (!getToken()) {
      ui.showWarning('请先登录');
      return;
    }

    let effectiveReportId = reportId;
    // 外部引流：先认领 token，确保该报告归属到当前用户；若已被他人使用，则引导重新上传
    if (leadToken) {
      try {
        const claimed = await claimDamageReportByToken(leadToken);
        if (claimed && claimed.report_id) {
          effectiveReportId = claimed.report_id;
          this.setData({ reportId: claimed.report_id });
        }
      } catch (e) {
        wx.showModal({
          title: '无法继续',
          content: e.message || '该报告已被他人使用，请重新上传照片分析',
          confirmText: '重新上传',
          showCancel: false,
          success: () => {
            this.onCloseReport();
          }
        });
        return;
      }
    }

    const insBuilt = this._buildInsuranceInfoFromForm();
    if (insBuilt.error) {
      ui.showWarning(insBuilt.error);
      return;
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
    const userDeclared = String(this.data.userDeclaredPlate || '').trim();
    let plateSrc = edits.plate_number;
    if (plateSrc === undefined) {
      plateSrc = userDeclared || v?.plateNumber || vehicleInfo.plate_number || '';
    }
    const bidVehicleInfo = {
      plate_number: String(plateSrc || '').trim(),
      brand: edits.brand !== undefined ? edits.brand : (v?.brand || ''),
      model: edits.model !== undefined ? edits.model : (v?.model || vehicleInfo.model || ''),
      vehicle_price_tier: v?.vehicle_price_tier ?? undefined,
      vehicle_price_max: v?.vehicle_price_max ?? undefined
    };

    if (!bidVehicleInfo.plate_number) {
      ui.showWarning('请填写车牌号');
      return;
    }

    // 与已绑定车辆比对：若不同则提醒
    const boundPlates = await this._getBoundPlates();
    if (boundPlates.length > 0) {
      const currentPlate = this._normalizePlate(bidVehicleInfo.plate_number);
      const isBound = boundPlates.some((p) => this._normalizePlate(p) === currentPlate);
      if (!isBound) {
        const ok = await new Promise((resolve) => {
          wx.showModal({
            title: '车辆提醒',
            content: `您上传的车辆（${bidVehicleInfo.plate_number}）与已绑定车辆不一致，是否继续？`,
            confirmText: '继续',
            cancelText: '取消',
            success: (res) => resolve(res.confirm)
          });
        });
        if (!ok) return;
      }
    }

    this.setData({ submitting: true });
    try {
      const insurance_info = insBuilt.info;

      const rangeToSend = rangeKm === 0 ? 999 : (rangeKm || 5);
      // 折叠态：vehiclesList 仅 1 辆但全量 > 1，需把 focus id 显式传给后端落库；
      // 展开态多车：取当前选中 tab 的 vehicleId。
      const allCount = (this.data.vehiclesListAll || this.data.vehiclesList || []).length;
      let focusAiVehicleId = '';
      if (this.data.collapsedToFocus && this.data.focusVehicleId) {
        focusAiVehicleId = this.data.focusVehicleId;
      } else if ((this.data.vehiclesList || []).length > 1) {
        focusAiVehicleId = (v && v.vehicleId) || '车辆' + (selectedVehicleIndex + 1);
      } else if (allCount > 1 && v && v.vehicleId) {
        focusAiVehicleId = v.vehicleId;
      }
      const res = await createBidding({
        report_id: effectiveReportId,
        range: rangeToSend,
        insurance_info,
        vehicle_info: {
          plate_number: bidVehicleInfo.plate_number || undefined,
          brand: bidVehicleInfo.brand || undefined,
          model: bidVehicleInfo.model || undefined,
          vehicle_price_tier: bidVehicleInfo.vehicle_price_tier,
          vehicle_price_max: bidVehicleInfo.vehicle_price_max
        },
        latitude,
        longitude,
        ...(focusAiVehicleId ? { analysis_focus_vehicle_id: focusAiVehicleId } : {})
      });

      ui.showSuccess(res.duplicate ? '该预报价已发起竞价，正在跳转' : '已提交，正在分发');
      this.setData({ submitting: false });
      navigation.navigateTo('/pages/bidding/wait/index', { id: res.bidding_id });
    } catch (err) {
      logger.error('发起竞价失败', err);
      ui.showError(err.message || '发起失败');
      this.setData({ submitting: false });
    }
  }
});
