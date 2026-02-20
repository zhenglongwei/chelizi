// 追评弹窗 - 15-追评页（1 个月/3 个月，弹窗形式）
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const { getToken, getReviewDetail, getOrderFirstReview, submitFollowup, uploadImage } = require('../../../utils/api');
const { getNavBarHeight, formatRelativeTime } = require('../../../utils/util');

const logger = getLogger('ReviewFollowup');

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    reviewId: '',
    stage: '1m',
    isReturnVisit: false,
    orderTier: 1,
    info: null,
    loading: true,
    error: '',
    // 1m: 2 道客观题；3m: 3 道客观题
    q1_fault_recur: null,
    q2_new_abnormal: null,
    q2_parts_ok: null,
    q3_after_sales: null,
    content: '',
    images: [],
    imageUrls: [],
    submitting: false,
    submitted: false,
    rewardAmount: '0.00',
    minContentLen: 10
  },

  onLoad(options) {
    const reviewId = (options.review_id || options.id || '').trim();
    const orderId = (options.order_id || '').trim();
    const stage = (options.stage || '1m') === '3m' ? '3m' : '1m';
    const isReturnVisit = options.is_return_visit === '1' || options.is_return_visit === 'true';
    const minContentLen = stage === '3m' ? 20 : 10;

    if (!getToken()) {
      navigation.redirectTo('/pages/auth/login/index', {
        redirect: '/pages/review/followup/index' + (reviewId ? '?review_id=' + reviewId + '&stage=' + stage : orderId ? '?order_id=' + orderId + '&stage=' + stage : '')
      });
      return;
    }

    if (reviewId) {
      this.setData({ reviewId, stage, isReturnVisit, minContentLen });
      this.loadReview(reviewId);
    } else if (orderId) {
      this.setData({ stage, isReturnVisit, minContentLen });
      this.loadByOrderId(orderId);
    } else {
      this.setData({ loading: false, error: '缺少评价ID或订单ID' });
    }
  },

  async loadByOrderId(orderId) {
    try {
      const res = await getOrderFirstReview(orderId);
      if (res && res.review_id) {
        this.setData({ reviewId: res.review_id });
        this.loadReview(res.review_id);
      } else {
        this.setData({ loading: false, error: '无法获取追评信息' });
      }
    } catch (err) {
      logger.error('获取首次评价失败', err);
      this.setData({ loading: false, error: err.message || '加载失败' });
    }
  },

  async loadReview(reviewId) {
    try {
      const info = await getReviewDetail(reviewId);
      const createdText = info.created_at ? formatRelativeTime(info.created_at) : '';
      const orderTier = info.order_tier || 1;
      const rewardHint = this.getRewardHint(orderTier);
      const rewardAmount = stage === '3m' ? (info.followup_reward_3m || '0') : (info.followup_reward_1m || info.followup_reward || '0');
      this.setData({
        info: { ...info, created_at: createdText },
        orderTier,
        rewardHint,
        rewardAmount,
        loading: false
      });
    } catch (err) {
      logger.error('加载评价详情失败', err);
      this.setData({ loading: false, error: err.message || '加载失败' });
    }
  },

  getRewardHint(orderTier) {
    const { stage } = this.data;
    if (orderTier <= 2) return '选填完成可领额外权益，不影响基础奖励';
    if (stage === '1m') return orderTier === 3 ? '通过审核后发放剩余 50% 奖励金' : '通过审核后发放 30% 奖励金';
    return '通过审核后发放剩余 20% 奖励金';
  },

  onQ1(e) { this.setData({ q1_fault_recur: e.detail.value === 'true' }); },
  onQ2(e) { this.setData({ q2_new_abnormal: e.detail.value === 'true' }); },
  onQ2b(e) { this.setData({ q2_parts_ok: e.detail.value === 'true' }); },
  onQ3(e) { this.setData({ q3_after_sales: e.detail.value === 'true' }); },
  onContentInput(e) { this.setData({ content: (e.detail.value || '').trim() }); },

  onChooseImage() {
    const remain = 6 - this.data.images.length;
    if (remain <= 0) { ui.showWarning('最多 6 张'); return; }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const newPaths = (res.tempFiles || []).map((f) => f.tempFilePath);
        this.setData({ images: [...this.data.images, ...newPaths] });
      }
    });
  },

  onDelImage(e) {
    const idx = e.currentTarget.dataset.index;
    const images = [...this.data.images];
    const imageUrls = [...this.data.imageUrls];
    images.splice(idx, 1);
    imageUrls.splice(idx, 1);
    this.setData({ images, imageUrls });
  },

  onClose() {
    wx.navigateBack();
  },

  canSubmit() {
    const { stage, orderTier, q1_fault_recur, q2_new_abnormal, q2_parts_ok, q3_after_sales, content, minContentLen } = this.data;
    if (orderTier <= 2) return content.length >= minContentLen;
    if (stage === '1m') return q1_fault_recur != null && q2_new_abnormal != null && content.length >= minContentLen;
    return q1_fault_recur != null && q2_parts_ok != null && q3_after_sales != null && content.length >= minContentLen;
  },

  async onSubmit() {
    const { reviewId, stage, isReturnVisit, content, images, imageUrls, minContentLen } = this.data;
    if (!this.canSubmit()) {
      ui.showWarning(stage === '3m' ? '请完成客观题并填写至少 20 字描述' : '请完成客观题并填写至少 10 字描述');
      return;
    }
    if (this.data.submitting) return;

    this.setData({ submitting: true });
    try {
      let urls = [...imageUrls];
      for (let i = urls.length; i < images.length; i++) {
        urls.push(await uploadImage(images[i]));
      }

      const objAnswers = stage === '1m'
        ? { q1_fault_recur: this.data.q1_fault_recur, q2_new_abnormal: this.data.q2_new_abnormal }
        : { q1_fault_recur: this.data.q1_fault_recur, q2_parts_ok: this.data.q2_parts_ok, q3_after_sales: this.data.q3_after_sales };

      const res = await submitFollowup(reviewId, {
        content,
        images: urls,
        stage,
        is_return_visit: isReturnVisit,
        objective_answers: objAnswers
      });

      const amt = (res.reward && res.reward.amount) ? String(res.reward.amount) : this.data.rewardAmount;
      this.setData({
        submitted: true,
        rewardAmount: amt,
        submitting: false
      });
      ui.showSuccess('追评成功，奖励金已到账');
    } catch (err) {
      logger.error('提交追评失败', err);
      ui.showError(err.message || '提交失败');
      this.setData({ submitting: false });
    }
  },

  onToOrder() {
    const orderId = this.data.info?.order_id;
    if (orderId) navigation.navigateTo('/pages/order/detail/index?id=' + orderId);
    else wx.navigateBack();
  },

  onToUser() {
    wx.switchTab({ url: '/pages/user/index/index' });
  }
});
