// 订单详情 - 07-订单详情页
const {
  getToken,
  getUserOrder,
  getRewardPreview,
  cancelOrder,
  confirmOrder,
  escalateCancelRequest,
  approveRepairPlan,
  prepayUserRepairOrder,
} = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');
const ui = require('../../../utils/ui');
const { requestUserSubscribe } = require('../../../utils/subscribe');
const navigation = require('../../../utils/navigation');

const STATUS_MAP = { 0: '待接单', 1: '维修中', 2: '待确认完成', 3: '待评价', 4: '已取消' };

/** 格式化维修项为展示文本 */
function fmtItem(it) {
  const part = it.damage_part || it.name || it.item || '项目';
  const type = it.repair_type || '维修';
  const pts = it.repair_type === '换' && it.parts_type ? ' · ' + it.parts_type : '';
  return { part, type, pts, text: `${part}：${type}${pts}` };
}

/** 比较原方案(quote)与新方案(repair_plan)，生成待确认时的对比数据 */
function buildPlanDiffForConfirm(quote, repairPlan) {
  if (!quote || !repairPlan) return null;
  const qItems = (quote.items || []).map(fmtItem);
  const rItems = (repairPlan.items || []).map(fmtItem);
  const qByPart = {};
  qItems.forEach((it, i) => { qByPart[it.part] = { ...it, idx: i }; });
  const rByPart = {};
  rItems.forEach((it, i) => { rByPart[it.part] = { ...it, idx: i }; });

  const oldPlanItems = qItems.map((it) => {
    const inNew = rByPart[it.part];
    const change = !inNew ? 'removed' : (it.type !== inNew.type || it.pts !== inNew.pts) ? 'modified' : 'unchanged';
    return { ...it, change };
  });
  const newPlanItems = rItems.map((it) => {
    const inOld = qByPart[it.part];
    const change = !inOld ? 'added' : (it.type !== inOld.type || it.pts !== inOld.pts) ? 'modified' : 'unchanged';
    return { ...it, change };
  });

  const amountDiff = (quote.amount != null && repairPlan.amount != null && Number(quote.amount) !== Number(repairPlan.amount));
  const durationDiff = (quote.duration != null && repairPlan.duration != null && Number(quote.duration) !== Number(repairPlan.duration));
  const warrantyDiff = (quote.warranty != null && repairPlan.warranty != null && Number(quote.warranty) !== Number(repairPlan.warranty));
  const qVa = (quote.value_added_services || []).map((v) => (typeof v === 'string' ? v : v.name || v));
  const rVa = (repairPlan.value_added_services || []).map((v) => (typeof v === 'string' ? v : v.name || v));
  const valueAddedDiff = JSON.stringify(qVa) !== JSON.stringify(rVa);
  const qVaSet = new Set(qVa);
  const rVaSet = new Set(rVa);
  const oldValueAddedItems = qVa.map((t) => ({ text: t, change: rVaSet.has(t) ? 'unchanged' : 'removed' }));
  const newValueAddedItems = rVa.map((t) => ({ text: t, change: qVaSet.has(t) ? 'unchanged' : 'added' }));

  return {
    oldPlanItems,
    newPlanItems,
    oldValueAddedItems,
    newValueAddedItems,
    amountDiff,
    durationDiff,
    warrantyDiff,
    valueAddedDiff,
    originalAmount: quote.amount,
    originalDuration: quote.duration,
    originalWarranty: quote.warranty,
    originalValueAdded: qVa,
    newAmount: repairPlan.amount,
    newDuration: repairPlan.duration,
    newWarranty: repairPlan.warranty,
    newValueAdded: rVa
  };
}

Page({
  data: {
    order: null,
    rewardPreview: null,
    loading: true,
    pageRootStyle: 'padding-top: 88px',
    planItems: [],
    planValueAdded: [],
    planDiff: null,
    completionEvidence: { repair_photos: [], settlement_photos: [], material_photos: [] },
    approving: false,
    durationCountdownText: '',
    durationCountdownExpired: false,
    repairPaying: false
  },

  _durationTimer: null,

  onLoad(options) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    const id = options.id;
    if (!id) {
      wx.showToast({ title: '参数错误', icon: 'none' });
      return;
    }
    if (!getToken()) {
      wx.navigateTo({ url: '/pages/auth/login/index?redirect=' + encodeURIComponent('/pages/order/detail/index?id=' + id) });
      return;
    }
    this.loadOrder(id);
  },

  async loadOrder(id) {
    try {
      const [order, rewardPreview] = await Promise.all([
        getUserOrder(id),
        getRewardPreview(id).catch(() => null)
      ]);
      if (order.status === 3 && order.first_review_id) {
        order.statusText = '已评价';
      } else {
        order.statusText = STATUS_MAP[order.status] ?? '未知';
      }
      order.canCancel = order.can_cancel === true && order.status !== 2;
      order.cancelNeedsReason = order.cancel_needs_reason === true;
      order.cancelRejected = order.cancel_rejected === true;
      order.cancelRequestId = order.cancel_request_id;
      order.canConfirm = (order.status === 2);
      order.canReview = (order.status === 3 && !order.first_review_id);
      order.canFollowup = order.can_followup && order.first_review_id;
      order.repair_plan_status = parseInt(order.repair_plan_status, 10) || 0;

      const rp = order.repair_plan;
      const quote = order.quote || {};
      const pendingConfirm = order.repair_plan_status === 1;
      const planItems = pendingConfirm ? (quote.items || []) : ((rp && rp.items && rp.items.length) ? rp.items : (quote.items || []));
      const planValueAdded = pendingConfirm ? (quote.value_added_services || []) : ((rp && rp.value_added_services && rp.value_added_services.length) ? rp.value_added_services : (quote.value_added_services || []));
      order.displayAmount = pendingConfirm ? (quote.amount ?? order.quoted_amount) : ((rp && rp.amount != null) ? rp.amount : order.quoted_amount);
      order.displayDuration = pendingConfirm ? (quote.duration ?? order.quote_duration) : (rp && rp.duration != null ? rp.duration : (quote.duration || order.quote_duration));
      order.displayWarranty = pendingConfirm ? quote.warranty : (rp && rp.warranty != null ? rp.warranty : quote.warranty);

      const planDiff = (order.repair_plan_status === 1 && quote && rp) ? buildPlanDiffForConfirm(quote, rp) : null;

      let completionEvidence = { repair_photos: [], settlement_photos: [], material_photos: [] };
      if (order.completion_evidence && order.status === 2) {
        try {
          const raw = typeof order.completion_evidence === 'string' ? JSON.parse(order.completion_evidence || '{}') : order.completion_evidence;
          completionEvidence = {
            repair_photos: Array.isArray(raw.repair_photos) ? raw.repair_photos : [],
            settlement_photos: Array.isArray(raw.settlement_photos) ? raw.settlement_photos : [],
            material_photos: Array.isArray(raw.material_photos) ? raw.material_photos : []
          };
        } catch (_) {}
      }

      this.setData({ order, rewardPreview, planItems, planValueAdded, planDiff, completionEvidence, loading: false });
      this._startDurationTimer();
      if (order.status < 2) requestUserSubscribe('order_update');
    } catch (e) {
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  _startDurationTimer() {
    if (this._durationTimer) {
      clearInterval(this._durationTimer);
      this._durationTimer = null;
    }
    const order = this.data.order;
    if (!order || order.status > 1 || !order.duration_deadline) return;
    const update = () => {
      const deadline = new Date(order.duration_deadline);
      deadline.setHours(23, 59, 59, 999);
      const now = Date.now();
      if (now >= deadline.getTime()) {
        this.setData({ durationCountdownText: '', durationCountdownExpired: true });
        if (this._durationTimer) {
          clearInterval(this._durationTimer);
          this._durationTimer = null;
        }
        return;
      }
      const ms = deadline.getTime() - now;
      const d = Math.floor(ms / 86400000);
      const h = Math.floor((ms % 86400000) / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      let text = '';
      if (d > 0) text = d + '天' + (h > 0 ? h + '小时' : '');
      else if (h > 0) text = h + '小时' + m + '分';
      else text = m + '分钟';
      this.setData({ durationCountdownText: text || '不足1分钟', durationCountdownExpired: false });
    };
    update();
    this._durationTimer = setInterval(update, 60000);
  },

  onUnload() {
    if (this._durationTimer) {
      clearInterval(this._durationTimer);
      this._durationTimer = null;
    }
  },

  onCallShop() {
    const phone = this.data.order && this.data.order.shop_phone;
    if (phone) wx.makePhoneCall({ phoneNumber: phone });
  },

  onPreviewEvidence(e) {
    const urls = e.currentTarget.dataset.urls || [];
    const current = e.currentTarget.dataset.current;
    if (urls.length) wx.previewImage({ urls, current: current || urls[0] });
  },

  async onConfirm() {
    const { order } = this.data;
    if (!order || !order.canConfirm) return;
    wx.showModal({
      title: '确认完成',
      content: '确认维修已完成？确认后将进行评价',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await confirmOrder(order.order_id);
          ui.showSuccess('已确认完成');
          await this.loadOrder(order.order_id);
        } catch (e) {
          ui.showError(e.message || '操作失败');
        }
      }
    });
  },

  onReview() {
    const { order } = this.data;
    if (!order || !order.canReview) return;
    wx.navigateTo({ url: '/pages/review/submit/index?order_id=' + order.order_id });
  },

  onFollowup() {
    const { order } = this.data;
    if (!order || !order.canFollowup) return;
    wx.navigateTo({ url: '/pages/review/followup/index?review_id=' + order.first_review_id + '&stage=1m' });
  },

  onCancel() {
    const { order } = this.data;
    if (!order || !order.canCancel) return;
    if (order.cancelNeedsReason) {
      wx.showModal({
        title: '申请撤销',
        editable: true,
        placeholderText: '请填写撤单理由（必填）',
        success: async (res) => {
          if (!res.confirm) return;
          const reason = (res.content || '').trim();
          if (!reason) {
            ui.showWarning('请填写撤单理由');
            return;
          }
          try {
            const data = await cancelOrder(order.order_id, reason);
            ui.showSuccess(data.direct ? '已撤销' : '撤单申请已提交');
            if (data.direct) wx.navigateBack();
            else this.loadOrder(order.order_id);
          } catch (e) {
            ui.showError(e.message || '操作失败');
          }
        }
      });
    } else {
      wx.showModal({
        title: '撤销订单',
        content: '撤销后可重新选择其他报价，确定撤销吗？',
        success: async (res) => {
          if (!res.confirm) return;
          try {
            await cancelOrder(order.order_id);
            ui.showSuccess('已撤销');
            wx.navigateBack();
          } catch (e) {
            ui.showError(e.message || '撤销失败');
          }
        }
      });
    }
  },

  async onApprovePlan(e) {
    const approve = e.currentTarget.dataset.approve === 'true' || e.currentTarget.dataset.approve === true;
    const { order } = this.data;
    if (!order || order.repair_plan_status !== 1) return;
    this.setData({ approving: true });
    try {
      await approveRepairPlan(order.order_id, approve);
      ui.showSuccess(approve ? '已同意维修方案' : '如有疑问请联系客服');
      this.loadOrder(order.order_id);
    } catch (err) {
      ui.showError(err.message || '操作失败');
    }
    this.setData({ approving: false });
  },

  async onEscalateCancel() {
    const { order } = this.data;
    if (!order || !order.cancelRejected || !order.cancelRequestId) return;
    try {
      await escalateCancelRequest(order.order_id, order.cancelRequestId);
      ui.showSuccess('已提交人工通道');
      this.loadOrder(order.order_id);
    } catch (e) {
      ui.showError(e.message || '提交失败');
    }
  },

  onBookAppointment() {
    const { order } = this.data;
    if (!order || order.status < 1 || order.status === 4) return;
    navigation.navigateTo('/pages/shop/book/index', {
      id: order.shop_id,
      order_id: order.order_id
    });
  },

  async runRepairJsapiPay(prepayPayload) {
    const { timeStamp, nonceStr, package: pkg, signType, paySign } = prepayPayload;
    return new Promise((resolve, reject) => {
      wx.requestPayment({
        timeStamp,
        nonceStr,
        package: pkg,
        signType: signType || 'RSA',
        paySign,
        success: () => resolve(),
        fail: (err) => reject(new Error(err.errMsg || '支付取消'))
      });
    });
  },

  async onPayRepair() {
    const { order, repairPaying } = this.data;
    if (!order || !order.can_pay_repair || repairPaying) return;
    this.setData({ repairPaying: true });
    try {
      const login = await new Promise((resolve, reject) => {
        wx.login({ success: (r) => resolve(r.code), fail: reject });
      });
      const prepay = await prepayUserRepairOrder(order.order_id, login);
      await this.runRepairJsapiPay(prepay);
      ui.showSuccess('支付成功');
      await this.loadOrder(order.order_id);
    } catch (e) {
      ui.showError(e.message || '支付失败');
    } finally {
      this.setData({ repairPaying: false });
    }
  }
});
