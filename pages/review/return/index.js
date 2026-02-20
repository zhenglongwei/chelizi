// 返厂评价页 - 17-返厂评价页
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const { getToken, getUserOrder, submitReturnReview, uploadImage } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

const logger = getLogger('ReviewReturn');

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    scrollStyle: 'height: 500px',
    orderId: '',
    order: null,
    loading: true,
    error: '',
    canSubmit: false,
    content: '',
    images: [],
    imageUrls: [],
    rebateAmount: '0.00',
    submitting: false,
    submitted: false
  },

  onLoad(options) {
    const navH = getNavBarHeight();
    const sys = wx.getSystemInfoSync();
    this.setData({ pageRootStyle: 'padding-top: ' + navH + 'px', scrollStyle: 'height: ' + (sys.windowHeight - navH - 120) + 'px' });
    const orderId = (options.order_id || options.id || '').trim();
    if (!getToken()) {
      navigation.redirectTo('/pages/auth/login/index', {
        redirect: '/pages/review/return/index?order_id=' + orderId
      });
      return;
    }
    if (!orderId) {
      this.setData({ loading: false, error: '缺少订单ID' });
      return;
    }
    this.setData({ orderId });
    this.loadOrder(orderId);
  },

  async loadOrder(orderId) {
    try {
      const order = await getUserOrder(orderId);
      if (order.status !== 3 || !order.can_return) {
        let msg = '不满足返厂评价条件';
        if (order.status !== 3) msg = '请先完成订单';
        else if (!order.first_review_id) msg = '请先完成首次评价';
        else msg = '您已提交过追评或返厂评价，或已超过 6 个月';
        this.setData({ loading: false, error: msg });
        return;
      }
      const amount = parseFloat(order.actual_amount || order.quoted_amount) || 0;
      const rebate = (amount * 0.02).toFixed(2);
      this.setData({
        order,
        canSubmit: true,
        rebateAmount: rebate,
        loading: false
      });
    } catch (err) {
      logger.error('加载订单失败', err);
      this.setData({ loading: false, error: err.message || '加载失败' });
    }
  },

  onContentInput(e) {
    this.setData({ content: (e.detail.value || '').trim() });
  },

  onChooseImage() {
    const remain = 6 - this.data.images.length;
    if (remain <= 0) {
      ui.showWarning('最多上传 6 张照片');
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
        if (err.errMsg && !err.errMsg.includes('cancel')) ui.showError('选择图片失败');
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

  async onSubmit() {
    const { orderId, content, images, imageUrls, submitting, canSubmit } = this.data;
    if (!canSubmit || submitting) return;
    if (!images || images.length === 0) {
      ui.showWarning('请上传至少 1 张返厂照片');
      return;
    }

    this.setData({ submitting: true });
    try {
      let urls = [...imageUrls];
      for (let i = urls.length; i < images.length; i++) {
        const url = await uploadImage(images[i]);
        urls.push(url);
      }

      const res = await submitReturnReview({ order_id: orderId, images: urls, content });
      this.setData({
        submitted: true,
        rebateAmount: (res.rebate && res.rebate.amount) ? String(res.rebate.amount) : this.data.rebateAmount,
        submitting: false
      });
      ui.showSuccess('返厂评价提交成功，返点已到账');
    } catch (err) {
      logger.error('提交返厂评价失败', err);
      ui.showError(err.message || '提交失败');
      this.setData({ submitting: false });
    }
  },

  onToOrder() {
    const orderId = this.data.orderId;
    if (orderId) {
      navigation.navigateTo('/pages/order/detail/index', { id: orderId });
    } else {
      navigation.navigateBack();
    }
  },

  onToUser() {
    navigation.switchTab('/pages/user/index/index');
  }
});
