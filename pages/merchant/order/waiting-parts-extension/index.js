const ui = require('../../../../utils/ui');
const { getNavBarHeight } = require('../../../../utils/util');
const { merchantUploadImage, merchantWaitingPartsExtension } = require('../../../../utils/api');

Page({
  data: {
    orderId: '',
    pageRootStyle: 'padding-top: 88px',
    note: '',
    extendDays: 15,
    imageUrls: [],
    submitting: false,
  },

  onLoad(options) {
    const orderId = (options.id || options.order_id || '').trim();
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px', orderId });
    if (!orderId) ui.showError('订单ID无效');
  },

  onExtendDaysInput(e) {
    const v = parseInt(e.detail.value, 10);
    this.setData({ extendDays: Number.isNaN(v) ? 15 : v });
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value });
  },

  onChooseImages() {
    const remain = Math.max(0, 6 - (this.data.imageUrls || []).length);
    if (remain <= 0) return;
    wx.chooseImage({
      count: remain,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        const files = res.tempFilePaths || [];
        if (!files.length) return;
        ui.showLoading('上传中...');
        try {
          const uploaded = [];
          for (const p of files) {
            const url = await merchantUploadImage(p);
            if (url) uploaded.push(url);
          }
          const next = [...(this.data.imageUrls || []), ...uploaded].slice(0, 6);
          this.setData({ imageUrls: next });
        } catch (e) {
          ui.showError(e.message || '上传失败');
        } finally {
          ui.hideLoading();
        }
      }
    });
  },

  onRemoveImage(e) {
    const url = e.currentTarget.dataset.url;
    const next = (this.data.imageUrls || []).filter((u) => u !== url);
    this.setData({ imageUrls: next });
  },

  onPreviewImage(e) {
    const cur = e.currentTarget.dataset.url;
    const urls = this.data.imageUrls || [];
    if (!cur || !urls.length) return;
    wx.previewImage({ current: cur, urls });
  },

  async onSubmit() {
    const { orderId, imageUrls, submitting } = this.data;
    if (!orderId || submitting) return;
    if (!imageUrls || !imageUrls.length) {
      ui.showWarning('请至少上传 1 张凭证图片');
      return;
    }
    const daysRaw = parseInt(this.data.extendDays, 10);
    const extendDays = Number.isNaN(daysRaw) ? 15 : Math.min(30, Math.max(1, daysRaw));

    this.setData({ submitting: true });
    try {
      const note = (this.data.note || '').trim();
      await merchantWaitingPartsExtension(orderId, {
        note: note || null,
        extend_days: extendDays,
        proof_urls: imageUrls
      });
      ui.showSuccess('已提交');
      setTimeout(() => wx.navigateBack(), 400);
    } catch (e) {
      ui.showError(e.message || '提交失败');
    } finally {
      this.setData({ submitting: false });
    }
  }
});

