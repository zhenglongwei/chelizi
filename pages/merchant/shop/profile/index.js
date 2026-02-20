// 维修厂信息 - M08
const { getLogger } = require('../../../../utils/logger');
const ui = require('../../../../utils/ui');
const { getMerchantToken, getMerchantShop, updateMerchantShop, withdrawMerchantQualification, merchantUploadImage, merchantAnalyzeTechnicianCert, merchantAnalyzeQualificationCert, ocrBusinessLicense } = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');
const { BUSINESS_HOURS_OPTIONS, QUALIFICATION_LEVEL_OPTIONS, TECHNICIAN_LEVEL_OPTIONS } = require('../../../../utils/shop-profile-constants');

const logger = getLogger('MerchantShopProfile');

// 规范化技师数据：兼容旧格式（字符串数组）与新格式（对象数组）
// 有证书按证书等级，无证书默认普通技工
function normalizeTechnicians(certs) {
  if (!certs || !Array.isArray(certs)) return [];
  return certs.map((item, i) => {
    if (typeof item === 'object' && item !== null) {
      const level = item.certificate_url ? (item.level || '普通技工') : '普通技工';
      return {
        id: item.id || 't' + i,
        avatar_url: item.avatar_url,
        name: item.name,
        level,
        years: item.years,
        certificate_url: item.certificate_url,
        ai_recognized_level: item.ai_recognized_level,
        occupation_name: item.occupation_name,
        job_direction: item.job_direction,
        certificate_no: item.certificate_no
      };
    }
    return { id: 't' + i, avatar_url: null, name: null, level: '普通技工', years: null, certificate_url: null };
  });
}

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    shop: null,
    qualificationStatus: 0,
    qualificationSubmitted: false,
    qualificationWithdrawn: false,
    name: '',
    address: '',
    locationName: '',
    latitude: null,
    longitude: null,
    phone: '',
    business_hours: '',
    businessHoursOptions: BUSINESS_HOURS_OPTIONS,
    businessHoursIndex: -1,
    qualification_level: '',
    qualificationLevelOptions: QUALIFICATION_LEVEL_OPTIONS,
    qualificationLevelIndex: -1,
    qualificationLevelLabel: '',
    shop_images: [],
    technicians: [],
    certifications: [],
    qualificationAuditReason: '',
    qualification_ai_recognized: '',
    qualification_ai_result: '',
    qualificationCertImage: '',
    technicianLevelOptions: TECHNICIAN_LEVEL_OPTIONS,
    technicianLevelIndex: -1,
    technicianLevelLabel: '',
    technicianModalVisible: false,
    technicianEditIndex: -1,
    technicianForm: { avatar_url: '', name: '', level: '普通技工', years: '', certificate_url: '', ai_recognized_level: '', occupation_name: '', job_direction: '', certificate_no: '' },
    saving: false
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    if (!getMerchantToken()) {
      wx.redirectTo({ url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/shop/profile/index') });
      return;
    }
    this.loadShop();
  },

  async loadShop() {
    try {
      const res = await getMerchantShop();
      const certs = res.technician_certs;
      const technicians = normalizeTechnicians(Array.isArray(certs) ? certs : (certs ? [certs] : []));
      const shopImages = Array.isArray(res.shop_images) ? res.shop_images : (res.shop_images ? [res.shop_images] : []);
      const bhIdx = BUSINESS_HOURS_OPTIONS.indexOf(res.business_hours || '');
      const qualVal = res.qualification_level || res.qualification_ai_recognized || '';
      const qlOpt = QUALIFICATION_LEVEL_OPTIONS.find(o => o.value === qualVal);
      const qlIdx = qlOpt ? QUALIFICATION_LEVEL_OPTIONS.indexOf(qlOpt) : -1;
      const submitted = !!(res.qualification_level && String(res.qualification_level).trim()) || !!(res.technician_certs && (Array.isArray(res.technician_certs) ? res.technician_certs.length : res.technician_certs));
      const withdrawn = (res.qualification_withdrawn === 1 || res.qualification_withdrawn === '1');
      this.setData({
        shop: res,
        qualificationStatus: res.qualification_status != null ? res.qualification_status : 0,
        qualificationSubmitted: submitted,
        qualificationWithdrawn: withdrawn,
        qualificationAuditReason: res.qualification_audit_reason || '',
        name: res.name || '',
        address: res.address || '',
        locationName: res.address ? '已定位' : '',
        latitude: res.latitude != null ? res.latitude : null,
        longitude: res.longitude != null ? res.longitude : null,
        phone: res.phone || '',
        business_hours: res.business_hours || '',
        businessHoursIndex: bhIdx >= 0 ? bhIdx : -1,
        qualification_level: res.qualification_level || res.qualification_ai_recognized || '',
        qualificationLevelIndex: qlIdx,
        qualificationLevelLabel: qlOpt ? qlOpt.label : '',
        shop_images: shopImages,
        technicians,
        certifications: Array.isArray(res.certifications) ? res.certifications : [],
        qualification_ai_recognized: res.qualification_ai_recognized || '',
        qualification_ai_result: res.qualification_ai_result || '',
        qualificationCertImage: (Array.isArray(res.certifications) ? res.certifications : []).find(c => c.type === 'qualification_cert')?.image || ''
      });
    } catch (err) {
      logger.error('加载店铺信息失败', err);
      ui.showError(err.message || '加载失败');
    }
  },

  onNameInput(e) {
    this.setData({ name: (e.detail.value || '').trim() });
  },

  _isAuditingLocked() {
    return this.data.qualificationStatus === 0 && this.data.qualificationSubmitted && !this.data.qualificationWithdrawn;
  },

  onChooseLocation() {
    if (this._isAuditingLocked()) return;
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          address: res.address || '',
          locationName: res.name || '',
          latitude: res.latitude,
          longitude: res.longitude
        });
        ui.showSuccess('已选择位置');
      },
      fail: (err) => {
        if (err.errMsg && !err.errMsg.includes('cancel')) {
          logger.error('选择位置失败', err);
          ui.showError(err.errMsg || '选择位置失败');
        }
      }
    });
  },

  onPhoneInput(e) {
    this.setData({ phone: (e.detail.value || '').trim() });
  },

  onBusinessHoursChange(e) {
    const idx = parseInt(e.detail.value, 10);
    const val = BUSINESS_HOURS_OPTIONS[idx] || '';
    this.setData({ businessHoursIndex: idx, business_hours: val });
  },

  onQualificationLevelChange(e) {
    const idx = parseInt(e.detail.value, 10);
    const opt = QUALIFICATION_LEVEL_OPTIONS[idx];
    const val = opt ? opt.value : '';
    const label = opt ? opt.label : '';
    this.setData({ qualificationLevelIndex: idx, qualification_level: val, qualificationLevelLabel: label });
  },

  async onQualificationFromLicense() {
    if (this._isAuditingLocked()) return;
    const certs = this.data.certifications || [];
    const license = certs.find(c => (c.type === '营业执照' || c.type === 'license' || (c.name && c.name.includes('营业执照'))) && c.image);
    if (!license || !license.image) {
      ui.showWarning('请先在注册时上传营业执照');
      return;
    }
    try {
      ui.showLoading('识别中...');
      const res = await ocrBusinessLicense(license.image);
      ui.hideLoading();
      const qual = res.qualification_level || null;
      const opt = qual ? QUALIFICATION_LEVEL_OPTIONS.find(o => o.value === qual) : null;
      const idx = opt ? QUALIFICATION_LEVEL_OPTIONS.indexOf(opt) : -1;
      this.setData({
        qualification_level: qual || '',
        qualificationLevelIndex: idx >= 0 ? idx : -1,
        qualificationLevelLabel: opt ? opt.label : '',
        qualification_ai_recognized: qual || '',
        qualification_ai_result: res.qualification_ai_result || ''
      });
      if (qual) {
        ui.showSuccess('已识别：' + qual);
      } else {
        ui.showWarning('未识别到资质，可手动选择（将提交人工审核）');
      }
    } catch (err) {
      ui.hideLoading();
      logger.error('营业执照识别失败', err);
      this.setData({ qualification_ai_result: 'recognition_failed' });
      ui.showError(err.message || '识别失败，可手动选择');
    }
  },

  async onQualificationCertUpload() {
    if (this._isAuditingLocked()) return;
    let url;
    try {
      const files = await new Promise((resolve, reject) => {
        wx.chooseMedia({ count: 1, mediaType: ['image'], success: (r) => resolve(r.tempFiles || []), fail: reject });
      });
      if (!files || !files.length) return;
      ui.showLoading('上传中...');
      url = await merchantUploadImage(files[0].tempFilePath);
      if (!url) {
        ui.hideLoading();
        return;
      }
      const certs = [...(this.data.certifications || [])];
      const existingCert = certs.findIndex(c => c.type === 'qualification_cert');
      const qualCert = { type: 'qualification_cert', name: '维修资质证明', image: url };
      if (existingCert >= 0) certs[existingCert] = qualCert;
      else certs.push(qualCert);

      ui.showLoading('AI 识别中...');
      const res = await merchantAnalyzeQualificationCert(url);
      ui.hideLoading();
      const qual = res.qualification_level || null;
      const opt = qual ? QUALIFICATION_LEVEL_OPTIONS.find(o => o.value === qual) : null;
      const idx = opt ? QUALIFICATION_LEVEL_OPTIONS.indexOf(opt) : -1;
      this.setData({
        certifications: certs,
        qualificationCertImage: url,
        qualification_level: qual || '',
        qualificationLevelIndex: idx >= 0 ? idx : -1,
        qualificationLevelLabel: opt ? opt.label : '',
        qualification_ai_recognized: qual || '',
        qualification_ai_result: res.qualification_ai_result || ''
      });
      if (qual) {
        ui.showSuccess('已识别：' + qual);
      } else {
        ui.showWarning('未识别到资质，可手动选择（将提交人工审核）');
      }
    } catch (err) {
      ui.hideLoading();
      logger.error('资质证明识别失败', err);
      if (url) {
        const certs = [...(this.data.certifications || [])];
        const existingCert = certs.findIndex(c => c.type === 'qualification_cert');
        const qualCert = { type: 'qualification_cert', name: '维修资质证明', image: url };
        if (existingCert >= 0) certs[existingCert] = qualCert;
        else certs.push(qualCert);
        this.setData({ certifications: certs, qualificationCertImage: url, qualification_ai_result: 'recognition_failed' });
      }
      ui.showError(err.message || '识别失败，可手动选择');
    }
  },

  async onAddShopImage() {
    if (this._isAuditingLocked()) return;
    try {
      const files = await new Promise((resolve, reject) => {
        wx.chooseMedia({
          count: 6 - this.data.shop_images.length,
          mediaType: ['image'],
          success: (res) => resolve(res.tempFiles || []),
          fail: reject
        });
      });
      if (!files || !files.length) return;
      ui.showLoading('上传中...');
      const urls = [];
      for (const f of files) {
        const url = await merchantUploadImage(f.tempFilePath);
        if (url) urls.push(url);
      }
      ui.hideLoading();
      if (!urls.length) return;
      const imgs = [...this.data.shop_images, ...urls];
      this.setData({ shop_images: imgs });
    } catch (err) {
      logger.error('上传照片失败', err);
      ui.showError(err.message || '上传失败');
    }
  },

  onDelShopImage(e) {
    if (this._isAuditingLocked()) return;
    const idx = parseInt(e.currentTarget.dataset.index, 10);
    const imgs = this.data.shop_images.filter((_, i) => i !== idx);
    this.setData({ shop_images: imgs });
  },

  onAddTechnician() {
    if (this._isAuditingLocked()) return;
    this.setData({
      technicianModalVisible: true,
      technicianEditIndex: -1,
      technicianForm: { avatar_url: '', name: '', level: '普通技工', years: '', certificate_url: '', ai_recognized_level: '', occupation_name: '', job_direction: '', certificate_no: '' },
      technicianLevelIndex: 0,
      technicianLevelLabel: '普通技工（无证书时默认）'
    });
  },

  onEditTechnician(e) {
    if (this._isAuditingLocked()) return;
    const idx = parseInt(e.currentTarget.dataset.index, 10);
    const t = this.data.technicians[idx] || {};
    const levelOpt = TECHNICIAN_LEVEL_OPTIONS.find(o => o.value === (t.level || '普通技工'));
    const levelIdx = levelOpt ? TECHNICIAN_LEVEL_OPTIONS.indexOf(levelOpt) : 0;
    this.setData({
      technicianModalVisible: true,
      technicianEditIndex: idx,
      technicianForm: {
        avatar_url: t.avatar_url || '',
        name: t.name || '',
        level: t.level || '普通技工',
        years: t.years != null ? String(t.years) : '',
        certificate_url: t.certificate_url || '',
        ai_recognized_level: t.ai_recognized_level || '',
        occupation_name: t.occupation_name || '',
        job_direction: t.job_direction || '',
        certificate_no: t.certificate_no || ''
      },
      technicianLevelIndex: levelIdx,
      technicianLevelLabel: levelOpt ? levelOpt.label : '普通技工（无证书时默认）'
    });
  },

  onDelTechnician(e) {
    if (this._isAuditingLocked()) return;
    const idx = parseInt(e.currentTarget.dataset.index, 10);
    const list = this.data.technicians.filter((_, i) => i !== idx);
    this.setData({ technicians: list });
  },

  async onWithdrawQualification() {
    const { qualificationStatus, qualificationSubmitted, qualificationWithdrawn } = this.data;
    if (qualificationStatus !== 0 || !qualificationSubmitted || qualificationWithdrawn) return;
    try {
      ui.showLoading('撤回中...');
      await withdrawMerchantQualification();
      ui.hideLoading();
      ui.showSuccess('已撤回，可修改后重新提交');
      this.loadShop();
    } catch (err) {
      ui.hideLoading();
      logger.error('撤回失败', err);
      ui.showError(err.message || '撤回失败');
    }
  },

  onCloseTechnicianModal() {
    this.setData({ technicianModalVisible: false });
  },

  onTechnicianNameInput(e) {
    this.setData({ 'technicianForm.name': (e.detail.value || '').trim() });
  },

  onTechnicianYearsInput(e) {
    const v = (e.detail.value || '').trim();
    this.setData({ 'technicianForm.years': v === '' ? '' : (isNaN(parseInt(v, 10)) ? v : parseInt(v, 10)) });
  },

  onTechnicianLevelChange(e) {
    const idx = parseInt(e.detail.value, 10);
    const opt = TECHNICIAN_LEVEL_OPTIONS[idx];
    const val = opt ? opt.value : '';
    const label = opt ? opt.label : '';
    this.setData({ technicianLevelIndex: idx, 'technicianForm.level': val, technicianLevelLabel: label });
    // ai_recognized_level 保持不变，用于后端判断用户是否修改了等级
  },

  async onTechnicianCertTap() {
    try {
      const files = await new Promise((resolve, reject) => {
        wx.chooseMedia({ count: 1, mediaType: ['image'], success: (r) => resolve(r.tempFiles || []), fail: reject });
      });
      if (!files || !files.length) return;
      ui.showLoading('上传中...');
      const url = await merchantUploadImage(files[0].tempFilePath);
      if (!url) {
        ui.hideLoading();
        return;
      }
      ui.showLoading('AI 识别中...');
      const ai = await merchantAnalyzeTechnicianCert(url);
      ui.hideLoading();
      const level = ai.skill_level || '普通技工';
      const levelOpt = TECHNICIAN_LEVEL_OPTIONS.find(o => o.value === level);
      const levelIdx = levelOpt ? TECHNICIAN_LEVEL_OPTIONS.indexOf(levelOpt) : 0;
      this.setData({
        'technicianForm.certificate_url': url,
        'technicianForm.name': ai.name || this.data.technicianForm.name,
        'technicianForm.occupation_name': ai.occupation_name || '',
        'technicianForm.job_direction': ai.job_direction || '',
        'technicianForm.certificate_no': ai.certificate_no || '',
        'technicianForm.level': level,
        'technicianForm.ai_recognized_level': ai.recognition_failed ? null : level,
        technicianLevelIndex: levelIdx,
        technicianLevelLabel: levelOpt ? levelOpt.label : TECHNICIAN_LEVEL_OPTIONS[0].label
      });
      if (ai.recognition_failed) {
        ui.showWarning('未识别到职业证书，请上传证书照片或手动选择等级');
      }
    } catch (err) {
      ui.hideLoading();
      logger.error('上传/识别证书失败', err);
      ui.showError(err.message || '上传或识别失败');
    }
  },

  async onTechnicianAvatarTap() {
    try {
      const files = await new Promise((resolve, reject) => {
        wx.chooseMedia({ count: 1, mediaType: ['image'], success: (r) => resolve(r.tempFiles || []), fail: reject });
      });
      if (!files || !files.length) return;
      ui.showLoading('上传中...');
      const url = await merchantUploadImage(files[0].tempFilePath);
      ui.hideLoading();
      if (url) this.setData({ 'technicianForm.avatar_url': url });
    } catch (err) {
      logger.error('上传头像失败', err);
      ui.showError(err.message || '上传失败');
    }
  },

  onConfirmTechnician() {
    const { technicianForm, technicianEditIndex, technicians } = this.data;
    const years = technicianForm.years === '' ? null : (parseInt(technicianForm.years, 10) || null);
    const certUrl = technicianForm.certificate_url || null;
    const level = certUrl ? (technicianForm.level || '普通技工') : '普通技工';
    const item = {
      id: technicianEditIndex >= 0 ? technicians[technicianEditIndex].id : 't' + Date.now(),
      avatar_url: technicianForm.avatar_url || null,
      name: technicianForm.name || null,
      level,
      years,
      certificate_url: certUrl,
      ai_recognized_level: certUrl ? (technicianForm.ai_recognized_level || null) : null,
      occupation_name: technicianForm.occupation_name || null,
      job_direction: technicianForm.job_direction || null,
      certificate_no: technicianForm.certificate_no || null
    };
    let list;
    if (technicianEditIndex >= 0) {
      list = technicians.map((t, i) => (i === technicianEditIndex ? item : t));
    } else {
      list = [...technicians, item];
    }
    this.setData({ technicians: list, technicianModalVisible: false });
  },

  async onSave() {
    const { name, address, latitude, longitude, phone, saving } = this.data;
    if (!name || !address || !phone) {
      ui.showWarning('请填写名称、地址、电话');
      return;
    }
    if (latitude == null || longitude == null) {
      ui.showWarning('请在地图上选择店铺位置以获取精准坐标');
      return;
    }
    if (!/^1\d{10}$/.test(phone)) {
      ui.showWarning('手机号格式不正确');
      return;
    }
    if (saving) return;

    this.setData({ saving: true });
    try {
      const technicians = this.data.technicians.map(t => ({
        avatar_url: t.avatar_url || null,
        name: t.name || null,
        level: t.level || null,
        years: t.years != null ? t.years : null,
        certificate_url: t.certificate_url || null,
        ai_recognized_level: t.ai_recognized_level || null,
        occupation_name: t.occupation_name || null,
        job_direction: t.job_direction || null,
        certificate_no: t.certificate_no || null
      }));
      await updateMerchantShop({
        name,
        address,
        latitude,
        longitude,
        phone,
        business_hours: this.data.business_hours || null,
        qualification_level: this.data.qualification_level || null,
        qualification_ai_recognized: this.data.qualification_ai_recognized || null,
        qualification_ai_result: this.data.qualification_ai_result || null,
        certifications: this.data.certifications && this.data.certifications.length ? this.data.certifications : null,
        shop_images: this.data.shop_images.length ? this.data.shop_images : null,
        technician_certs: technicians.length ? technicians : null
      });
      ui.showSuccess('保存成功');
      this.loadShop();
    } catch (err) {
      logger.error('保存失败', err);
      ui.showError(err.message || '保存失败');
    }
    this.setData({ saving: false });
  }
});
