// AI分析页（独立入口）：登录后使用，不采集车牌等身份资料
const { getLogger } = require('../../utils/logger');
const ui = require('../../utils/ui');
const navigation = require('../../utils/navigation');
const { getToken, uploadImage, createDamageReport, getDamageReport } = require('../../utils/api');
const logger = getLogger('AiDiagnosis');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
    waitElapsedSec: 0,
    analyzePhaseText: '',
    _lastCopiedText: '',
    _pollCancelToken: 0,
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

  onUnload() {
    this._stopWaitPolling();
  },

  onPromptChip(e) {
    if (this.data.submitting) return;
    const text = (e.currentTarget.dataset.text || '').trim();
    if (!text) return;
    this.setData({ userDescription: text });
  },

  onChooseImage() {
    if (this.data.submitting) return;
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
    if (this.data.submitting) return;
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

  _stopWaitPolling() {
    const next = (this.data._pollCancelToken || 0) + 1;
    this.setData({ _pollCancelToken: next });
    if (this._elapsedTimerId) {
      try {
        clearInterval(this._elapsedTimerId);
      } catch (_) {}
      this._elapsedTimerId = null;
    }
  },

  /**
   * 创建报告后轮询直至服务端分析结束，再跳转详情（与预报价异步队列一致，此处优先队列）
   * @returns {Promise<'done'|'timeout'|'cancelled'>}
   */
  async _waitForReportReady(reportId) {
    const rid = String(reportId || '').trim();
    if (!rid) return 'cancelled';
    const token = (this.data._pollCancelToken || 0) + 1;
    this.setData({ _pollCancelToken: token, waitElapsedSec: 0, analyzePhaseText: '已提交，正在排队分析…' });
    if (this._elapsedTimerId) {
      try {
        clearInterval(this._elapsedTimerId);
      } catch (_) {}
    }
    this._elapsedTimerId = setInterval(() => {
      if (token !== this.data._pollCancelToken) return;
      this.setData({ waitElapsedSec: (this.data.waitElapsedSec || 0) + 1 });
    }, 1000);

    const maxTries = 120;
    try {
      for (let tries = 1; tries <= maxTries; tries++) {
        if (token !== this.data._pollCancelToken) return 'cancelled';
        const delay = tries <= 10 ? 1400 : tries <= 35 ? 2000 : 2500;
        await sleep(delay);
        if (token !== this.data._pollCancelToken) return 'cancelled';

        const prog = Math.min(99, 85 + Math.min(14, Math.floor(tries * 0.45)));
        const phase =
          tries <= 2
            ? '已提交，正在排队分析…'
            : '模型分析中，请稍候（通常约半分钟到数分钟）…';
        this.setData({
          analyzeProgress: prog,
          progressStyle: 'width: ' + prog + '%',
          analyzePhaseText: phase,
        });

        let res;
        try {
          res = await getDamageReport(rid);
        } catch (e) {
          logger.warn('轮询报告失败', e);
          continue;
        }
        const st = res && res.status != null ? Number(res.status) : 0;
        if (st === 0) continue;

        if (st === 1) {
          this.setData({ analyzeProgress: 100, progressStyle: 'width: 100%', analyzePhaseText: '分析完成，正在打开报告…' });
          return 'done';
        }
        if (st === 3) {
          const reason =
            res && res.analysis_result && res.analysis_result.repair_related_reason
              ? String(res.analysis_result.repair_related_reason).trim().slice(0, 120)
              : '';
          ui.showWarning(reason || '内容与车辆维修场景不符，已生成说明');
          return 'done';
        }
        if (st === 4) {
          ui.showWarning('分析需人工复核，已为你打开报告页查看进度');
          return 'done';
        }
        return 'done';
      }
      return 'timeout';
    } finally {
      if (this._elapsedTimerId) {
        try {
          clearInterval(this._elapsedTimerId);
        } catch (_) {}
        this._elapsedTimerId = null;
      }
    }
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

      this.setData({
        reportId,
        step: 'pending',
        analyzeProgress: 85,
        progressStyle: 'width: 85%',
        waitElapsedSec: 0,
        analyzePhaseText: '已提交，正在排队分析…',
      });

      const waitResult = await this._waitForReportReady(reportId);
      if (waitResult === 'cancelled') {
        this.setData({ submitting: false, step: 'idle', analyzeProgress: 0, progressStyle: 'width: 0%', waitElapsedSec: 0, analyzePhaseText: '' });
        return;
      }
      if (waitResult === 'timeout') {
        ui.showWarning('分析耗时较长，已打开报告页，请稍后下拉刷新');
      }

      this.setData({
        submitting: false,
        step: 'idle',
        analyzeProgress: 0,
        progressStyle: 'width: 0%',
        waitElapsedSec: 0,
        analyzePhaseText: '',
      });
      wx.navigateTo({ url: '/pages/damage/report/index?id=' + encodeURIComponent(reportId) });
    } catch (err) {
      logger.error('AI分析失败', err);
      this._stopWaitPolling();
      ui.showError(err.message || '分析失败');
      this.setData({ submitting: false, step: 'idle', analyzeProgress: 0, progressStyle: 'width: 0%', waitElapsedSec: 0, analyzePhaseText: '' });
    }
  },

});

