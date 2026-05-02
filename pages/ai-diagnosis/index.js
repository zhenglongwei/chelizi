// AI分析页（独立入口）：登录后使用，不采集车牌等身份资料
const { getLogger } = require('../../utils/logger');
const ui = require('../../utils/ui');
const navigation = require('../../utils/navigation');
const { getToken, uploadImage, createDamageReport } = require('../../utils/api');
const logger = getLogger('AiDiagnosis');

function isRemoteImageUrl(pathOrUrl) {
  const s = String(pathOrUrl || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  if (/^https?:\/\/tmp\//i.test(s) || /^https?:\/\/usr\//i.test(s)) return false;
  return true;
}

Page({
  data: {
    images: [],
    imageUrls: [],
    userDescription: '',
    submitting: false,
    step: 'idle',
    analyzeProgress: 0,
    progressStyle: 'width: 0%',
    reportId: '',
    _lastCopiedText: ''
  },

  onShow() {
    if (!getToken()) {
      ui.showWarning('请先登录');
      navigation.redirectTo('/pages/auth/login/index', { redirect: '/pages/ai-diagnosis/index' });
    }
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
  },

  onPromptChip(e) {
    const text = (e.currentTarget.dataset.text || '').trim();
    if (!text) return;
    this.setData({ userDescription: text });
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
        this.setData({ images: [...this.data.images, ...newPaths] });
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
    this.setData({ userDescription: e.detail.value || '' });
  },

  async onStartAnalyze() {
    const { images, submitting } = this.data;
    if (submitting) return;
    if (!getToken()) {
      ui.showWarning('请先登录');
      navigation.navigateTo('/pages/auth/login/index', { redirect: '/pages/ai-diagnosis/index' });
      return;
    }
    const desc = String(this.data.userDescription || '').trim();
    const hasImg = images && images.length > 0;
    const hasText = desc.length >= 4;
    if (!hasImg && !hasText) {
      ui.showWarning('请上传照片，或写下至少 4 个字的描述');
      return;
    }

    this.setData({ submitting: true, step: 'pending', analyzeProgress: 0, progressStyle: 'width: 0%' });
    try {
      const imageUrls = [];
      if (hasImg) {
        const progressStep = 60 / images.length;
        for (let i = 0; i < images.length; i++) {
          const raw = images[i];
          const url = isRemoteImageUrl(raw) ? raw : await uploadImage(raw);
          imageUrls.push(url);
          const p = Math.round(20 + progressStep * (i + 1));
          this.setData({ analyzeProgress: p, progressStyle: 'width: ' + p + '%', imageUrls });
        }
      } else {
        this.setData({ analyzeProgress: 50, progressStyle: 'width: 50%', imageUrls: [] });
      }
      this.setData({ analyzeProgress: 85, progressStyle: 'width: 85%' });

      const created = await createDamageReport({
        images: imageUrls,
        user_description: desc || undefined,
        queue_priority: 100,
      });
      const reportId = created && created.report_id ? String(created.report_id) : '';
      if (!reportId) throw new Error('创建报告失败');
      // 不在本页等待轮询，直接跳转报告详情页（报告页会自行轮询刷新）
      this.setData({
        reportId,
        step: 'idle',
        analyzeProgress: 0,
        progressStyle: 'width: 0%',
        submitting: false
      });
      wx.navigateTo({ url: '/pages/damage/report/index?id=' + encodeURIComponent(reportId) });
    } catch (err) {
      logger.error('AI分析失败', err);
      ui.showError(err.message || '分析失败');
      this.setData({ submitting: false, step: 'idle', analyzeProgress: 0, progressStyle: 'width: 0%' });
    }
  },

});

