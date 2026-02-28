// 商户申诉提交 - M09
const { getLogger } = require('../../../../utils/logger');
const ui = require('../../../../utils/ui');
const { getMerchantToken, merchantUploadImage, submitMerchantAppeal } = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');

const logger = getLogger('MerchantAppealSubmit');

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    requestId: '',
    questionLabel: '',
    evidenceUrls: [],
    evidencePhotos: [],
    submitting: false
  },

  onLoad(options) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    const requestId = (options.requestId || '').trim();
    const questionLabel = decodeURIComponent(options.questionLabel || '');
    if (!requestId) {
      ui.showError('申诉请求无效');
      setTimeout(function() { wx.navigateBack(); }, 1500);
      return;
    }
    this.setData({ requestId, questionLabel });
    if (!getMerchantToken()) {
      wx.redirectTo({ url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/appeal/submit/index?requestId=' + requestId) });
      return;
    }
  },

  onChoosePhoto() {
    const remain = 10 - (this.data.evidenceUrls || []).length;
    if (remain <= 0) {
      ui.showWarning('最多上传 10 张');
      return;
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => {
        const files = (res.tempFiles || []).slice(0, remain);
        this._uploadFiles(files);
      }
    });
  },

  onDelPhoto(e) {
    const idx = parseInt(e.currentTarget.dataset.index, 10);
    const urls = [...(this.data.evidenceUrls || [])];
    const photos = [...(this.data.evidencePhotos || [])];
    urls.splice(idx, 1);
    photos.splice(idx, 1);
    this.setData({ evidenceUrls: urls, evidencePhotos: photos });
  },

  async _uploadFiles(files) {
    for (let i = 0; i < files.length; i++) {
      try {
        ui.showLoading('上传中...');
        const url = await merchantUploadImage(files[i].tempFilePath);
        ui.hideLoading();
        const urls = [...(this.data.evidenceUrls || []), url];
        const photos = [...(this.data.evidencePhotos || []), files[i].tempFilePath];
        this.setData({ evidenceUrls: urls, evidencePhotos: photos });
      } catch (e) {
        logger.error('上传失败', e);
        ui.hideLoading();
        ui.showError('上传失败');
      }
    }
  },

  onSubmit() {
    if (this.data.submitting) return;
    const evidenceUrls = this.data.evidenceUrls || [];
    const requestId = this.data.requestId;
    if (evidenceUrls.length < 1) {
      ui.showWarning('请上传至少 1 张申诉材料');
      return;
    }
    this.setData({ submitting: true });
    const that = this;
    submitMerchantAppeal(requestId, { evidence_urls: evidenceUrls })
      .then(function() {
        ui.showSuccess('申诉材料已提交');
        setTimeout(function() { wx.navigateBack(); }, 1200);
      })
      .catch(function(err) {
        logger.error('提交申诉失败', err);
        ui.showError(err.message || '提交失败');
        that.setData({ submitting: false });
      });
  }
});
