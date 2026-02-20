// 服务商注册 - M02
const { getLogger } = require('../../utils/logger');
const ui = require('../../utils/ui');
const { getNavBarHeight, compressImageForUpload } = require('../../utils/util');
const { merchantRegister, uploadImage, ocrBusinessLicense, setMerchantToken, setMerchantUser } = require('../../utils/api');

const logger = getLogger('MerchantRegister');

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    name: '',
    licenseID: '',
    legalRepresentative: '',
    contact: '',
    address: '',
    locationName: '',
    latitude: null,
    longitude: null,
    phone: '',
    password: '',
    confirmPassword: '',
    licenseUrl: '',
    licensePath: '',
    ocrLoading: false,
    ocrSuccess: false,
    loading: false,
    submitting: false,
    qualification_ai_recognized: '',
    qualification_ai_result: ''
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
  },

  onNameInput(e) {
    this.setData({ name: (e.detail.value || '').trim() });
  },
  onLicenseIDInput(e) {
    this.setData({ licenseID: (e.detail.value || '').trim() });
  },
  onLegalRepresentativeInput(e) {
    this.setData({ legalRepresentative: (e.detail.value || '').trim() });
  },
  onContactInput(e) {
    this.setData({ contact: (e.detail.value || '').trim() });
  },

  onChooseLocation() {
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

  onPasswordInput(e) {
    this.setData({ password: e.detail.value || '' });
  },

  onConfirmPasswordInput(e) {
    this.setData({ confirmPassword: e.detail.value || '' });
  },

  onChooseLicense() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        try {
          ui.showLoading('处理中');
          const toUpload = await compressImageForUpload(file.tempFilePath);
          ui.showLoading('上传中');
          const url = await uploadImage(toUpload);
          this.setData({ licensePath: toUpload, licenseUrl: url, ocrSuccess: false });
          ui.showLoading('识别中');
          this.setData({ ocrLoading: true });
          const ocr = await ocrBusinessLicense(url);
          wx.hideLoading();
          const qual = ocr.qualification_level || '';
          this.setData({
            ocrLoading: false,
            ocrSuccess: true,
            name: ocr.enterprise_name || this.data.name,
            licenseID: ocr.license_number || this.data.licenseID,
            legalRepresentative: ocr.legal_representative || this.data.legalRepresentative,
            qualification_ai_recognized: qual || '',
            qualification_ai_result: ocr.qualification_ai_result || ''
          });
          ui.showSuccess('识别完成，请核对信息');
        } catch (err) {
          wx.hideLoading();
          this.setData({ ocrLoading: false });
          logger.error('营业执照上传或识别失败', err);
          this.setData({ licensePath: file.tempFilePath });
          ui.showError(err.message || '识别失败，请手动填写');
        }
      },
      fail: (err) => {
        if (err.errMsg && !err.errMsg.includes('cancel')) ui.showError('选择图片失败');
      }
    });
  },

  onDelLicense() {
    this.setData({
      licensePath: '',
      licenseUrl: '',
      ocrSuccess: false,
      qualification_ai_recognized: '',
      qualification_ai_result: ''
    });
  },

  async onSubmit() {
    const { name, licenseID, legalRepresentative, contact, address, latitude, longitude, phone, password, confirmPassword, licenseUrl, submitting } = this.data;
    if (!name || !licenseID || !legalRepresentative || !contact || !address || !phone || !password) {
      ui.showWarning('请填写企业名称、营业执照号码、法定代表人、联系人、店铺地址、手机号、密码');
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
    if (password.length < 6) {
      ui.showWarning('密码至少 6 位');
      return;
    }
    if (password !== confirmPassword) {
      ui.showWarning('两次密码不一致');
      return;
    }
    if (submitting) return;

    this.setData({ submitting: true });
    try {
      const res = await merchantRegister({
        name,
        license_id: licenseID,
        legal_representative: legalRepresentative,
        contact,
        address,
        latitude,
        longitude,
        phone,
        password,
        license_url: licenseUrl || undefined,
        qualification_ai_recognized: this.data.qualification_ai_recognized || undefined,
        qualification_ai_result: this.data.qualification_ai_result || undefined
      });
      this.setData({ submitting: false });
      setMerchantToken(res.token);
      if (res.user) setMerchantUser(res.user);
      ui.showSuccess('注册成功，请补充资质信息');
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/merchant/shop/profile/index' });
      }, 1000);
    } catch (err) {
      logger.error('服务商注册失败', err);
      ui.showError(err.message || '注册失败');
      this.setData({ submitting: false });
    }
  },

  onToLogin() {
    wx.navigateTo({ url: '/pages/merchant/login' });
  }
});
