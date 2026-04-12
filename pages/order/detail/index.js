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
  confirmFinalQuote,
} = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');
const ui = require('../../../utils/ui');
const { requestUserSubscribe } = require('../../../utils/subscribe');
const navigation = require('../../../utils/navigation');
const { QUOTE_LABELS, getShopNthQuoteLabel, getShopRoundStageCode } = require('../../../utils/quote-nomenclature');
const { prependPreQuoteProposalToList } = require('../../../utils/quote-proposal-public-list');

const STATUS_MAP = { 0: '待接单', 1: '维修中', 2: '待确认完成', 3: '待评价', 4: '已取消' };

function normPlanPrice(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

function normPlanWarranty(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

/** 分项对比用：含价格、质保，用于待确认与多轮报价差异展示 */
function fmtItemForDiff(it) {
  const part = (it.damage_part || it.name || it.item || '').trim() || '项目';
  const type = it.repair_type || '维修';
  const pts = it.repair_type === '换' && it.parts_type ? ' · ' + String(it.parts_type) : '';
  const pr = normPlanPrice(it.price);
  const wm = normPlanWarranty(it.warranty_months);
  const text = `${part}：${type}${pts}${pr != null ? ' · ¥' + pr : ''}${wm != null ? ' · 质保' + wm + '月' : ''}`;
  return { part, type, pts, pr, wm, text };
}

function samePlanItemLine(a, b) {
  return a.type === b.type && a.pts === b.pts && a.pr === b.pr && a.wm === b.wm;
}

/** 比较两侧方案快照（items / 增值服务 / 金额 / 工期） */
function buildPlanDiffForConfirm(quote, repairPlan) {
  if (!quote || !repairPlan) return null;
  const qItems = (quote.items || []).map(fmtItemForDiff);
  const rItems = (repairPlan.items || []).map(fmtItemForDiff);
  const qByPart = {};
  qItems.forEach((it, i) => { qByPart[it.part] = { ...it, idx: i }; });
  const rByPart = {};
  rItems.forEach((it, i) => { rByPart[it.part] = { ...it, idx: i }; });

  const oldPlanItems = qItems.map((it) => {
    const inNew = rByPart[it.part];
    const change = !inNew ? 'removed' : (samePlanItemLine(it, inNew) ? 'unchanged' : 'modified');
    return { ...it, change };
  });
  const newPlanItems = rItems.map((it) => {
    const inOld = qByPart[it.part];
    const change = !inOld ? 'added' : (samePlanItemLine(inOld, it) ? 'unchanged' : 'modified');
    return { ...it, change };
  });

  const amountDiff = (quote.amount != null && repairPlan.amount != null && Number(quote.amount) !== Number(repairPlan.amount));
  const durationDiff = (quote.duration != null && repairPlan.duration != null && Number(quote.duration) !== Number(repairPlan.duration));
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
    valueAddedDiff,
    originalAmount: quote.amount,
    originalDuration: quote.duration,
    originalValueAdded: qVa,
    newAmount: repairPlan.amount,
    newDuration: repairPlan.duration,
    newValueAdded: rVa
  };
}

function parseQuoteSnapObj(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch (_) {
      return null;
    }
  }
  return typeof v === 'object' ? v : null;
}

function normalizePlanSnapForDiff(snap) {
  if (!snap) return null;
  return {
    items: snap.items || [],
    value_added_services: snap.value_added_services || [],
    amount: snap.amount,
    duration: snap.duration
  };
}

/** 多轮报价协商记录（含相对上一轮的结构化差异） */
function buildQuoteProposalDisplayList(raw, preQuoteSnap) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const preNorm = normalizePlanSnapForDiff(parseQuoteSnapObj(preQuoteSnap));
  return raw.map((p, idx) => {
    const snap = parseQuoteSnapObj(p.quote_snapshot) || {};
    const ev = p.evidence || {};
    const urls = [...(ev.photo_urls || [])];
    const loss = ev.loss_assessment_documents;
    if (loss && typeof loss === 'object' && Array.isArray(loss.urls)) {
      loss.urls.forEach((u) => {
        if (typeof u === 'string' && urls.indexOf(u) < 0) urls.push(u);
      });
    }
    const prevNorm = idx === 0 ? preNorm : normalizePlanSnapForDiff(parseQuoteSnapObj(raw[idx - 1].quote_snapshot));
    const curNorm = normalizePlanSnapForDiff(snap);
    let diffFromPrevious = null;
    if (prevNorm && curNorm) {
      diffFromPrevious = buildPlanDiffForConfirm(prevNorm, curNorm);
    }
    return {
      proposal_id: p.proposal_id || 'rev_' + String(p.revision_no),
      is_synthetic_pre_quote: !!p.is_synthetic_pre_quote,
      revision_no: p.revision_no,
      display_round_label: p.display_round_label || getShopNthQuoteLabel(p.revision_no),
      quote_stage_code: p.quote_stage_code || getShopRoundStageCode(p.revision_no),
      status: p.status,
      status_text: p.status_text || '',
      submitted_at: p.submitted_at,
      resolved_at: p.resolved_at,
      amount: snap.amount,
      duration: snap.duration,
      supplement_note: (ev.supplement_note || '').trim(),
      photo_urls: urls,
      diffFromPrevious
    };
  });
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
    approvingFinal: false,
    durationCountdownText: '',
    durationCountdownExpired: false,
    repairPaying: false,
    finalQuotePending: false,
    preQuoteSnap: null,
    finalQuoteSnap: null,
    finalQuoteDiff: null,
    quoteProposalList: [],
    pendingFinalEvidenceUrls: [],
    rewardSectionVisible: false,
    showRewardStages: false,
    orderFooterVisible: false,
    rewardDisplayTotal: '0.00',
    rewardInvalidHint: '',
    rewardRuleEstimate: ''
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
    this._orderDetailId = id;
    this._firstOrderShow = true;
    this.loadOrder(id);
  },

  onShow() {
    const id = this._orderDetailId;
    if (!id || !getToken()) return;
    if (this._firstOrderShow) {
      this._firstOrderShow = false;
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
      const fqs = order.final_quote_status != null ? parseInt(order.final_quote_status, 10) : 0;
      order.final_quote_status = fqs;
      let preQuoteSnap = order.pre_quote_snapshot;
      let finalQuoteSnap = order.final_quote_snapshot;
      if (typeof preQuoteSnap === 'string') {
        try {
          preQuoteSnap = JSON.parse(preQuoteSnap);
        } catch (_) {
          preQuoteSnap = null;
        }
      }
      if (typeof finalQuoteSnap === 'string') {
        try {
          finalQuoteSnap = JSON.parse(finalQuoteSnap);
        } catch (_) {
          finalQuoteSnap = null;
        }
      }
      const finalQuotePending = order.status === 1 && fqs === 1;

      const rp = order.repair_plan;
      const quote = order.quote || {};
      const pendingConfirm = order.repair_plan_status === 1;
      let planItems;
      let planValueAdded;
      if (finalQuotePending && preQuoteSnap) {
        planItems = preQuoteSnap.items && preQuoteSnap.items.length ? preQuoteSnap.items : (quote.items || []);
        const pva = preQuoteSnap.value_added_services || quote.value_added_services || [];
        planValueAdded = pva.map((v) => (typeof v === 'string' ? { name: v } : v));
      } else if (pendingConfirm) {
        planItems = quote.items || [];
        planValueAdded = quote.value_added_services || [];
      } else {
        planItems = (rp && rp.items && rp.items.length) ? rp.items : (quote.items || []);
        planValueAdded = (rp && rp.value_added_services && rp.value_added_services.length) ? rp.value_added_services : (quote.value_added_services || []);
      }
      if (finalQuotePending && preQuoteSnap) {
        order.displayAmount = preQuoteSnap.amount != null ? preQuoteSnap.amount : order.quoted_amount;
        order.displayDuration = preQuoteSnap.duration != null ? preQuoteSnap.duration : (quote.duration || order.quote_duration);
      } else if (pendingConfirm) {
        order.displayAmount = quote.amount ?? order.quoted_amount;
        order.displayDuration = quote.duration ?? order.quote_duration;
      } else {
        order.displayAmount = (rp && rp.amount != null) ? rp.amount : order.quoted_amount;
        order.displayDuration = rp && rp.duration != null ? rp.duration : (quote.duration || order.quote_duration);
      }

      const planDiff = (order.repair_plan_status === 1 && quote && rp) ? buildPlanDiffForConfirm(quote, rp) : null;
      const finalQuoteDiff =
        finalQuotePending && preQuoteSnap && finalQuoteSnap ? buildPlanDiffForConfirm(preQuoteSnap, finalQuoteSnap) : null;

      let quoteProposalList = buildQuoteProposalDisplayList(order.quote_proposals, preQuoteSnap);
      const prePlanForList =
        (preQuoteSnap && typeof preQuoteSnap === 'object' ? preQuoteSnap : null) ||
        (quote && (quote.items?.length || quote.amount != null || quote.duration != null) ? quote : null) ||
        {};
      quoteProposalList = prependPreQuoteProposalToList(quoteProposalList, prePlanForList, order.accepted_at);
      let pendingFinalEvidenceUrls = [];
      for (let i = quoteProposalList.length - 1; i >= 0; i--) {
        if (quoteProposalList[i].status === 0) {
          pendingFinalEvidenceUrls = quoteProposalList[i].photo_urls || [];
          break;
        }
      }

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

      const showRewardStages = !!(
        rewardPreview &&
        (order.canConfirm || order.canReview || order.canFollowup)
      );
      const showComplexityBanner = !!(order.complexity_level && (order.status === 1 || order.status === 2));
      const rewardSectionVisible = showRewardStages || showComplexityBanner;

      const orderFooterVisible = !!(
        order.shop_phone ||
        order.status === 1 ||
        order.status === 2 ||
        order.canConfirm ||
        order.canReview ||
        order.canFollowup ||
        order.canCancel ||
        order.cancelRejected
      );

      const fmtReward = (v) => {
        const x = Number(v);
        return Number.isFinite(x) ? x.toFixed(2) : '0.00';
      };
      let rewardDisplayTotal = rewardPreview ? fmtReward(rewardPreview.total_reward) : '0.00';
      let rewardInvalidHint = '';
      let rewardRuleEstimate = '';
      if (order.first_review_id) {
        const rb =
          order.first_review_rebate_amount != null && order.first_review_rebate_amount !== ''
            ? Number(order.first_review_rebate_amount)
            : rewardPreview && rewardPreview.first_review_credited != null
              ? Number(rewardPreview.first_review_credited)
              : NaN;
        if (Number.isFinite(rb)) {
          rewardDisplayTotal = fmtReward(rb);
        }
        const pendingH = order.first_review_pending_human === true;
        const humanFb = order.first_review_human_feedback && String(order.first_review_human_feedback).trim();
        if (pendingH) {
          rewardDisplayTotal = fmtReward(0);
          rewardInvalidHint =
            '正在人工审核，请稍候。工作人员会尽快完成复核，通过后奖励金将按规则发放；上列为当前到账金额。';
          if (rewardPreview && rewardPreview.total_reward != null) {
            rewardRuleEstimate = fmtReward(rewardPreview.total_reward);
          }
        } else if (humanFb) {
          rewardInvalidHint = humanFb;
          if (rewardPreview && rewardPreview.total_reward != null) {
            rewardRuleEstimate = fmtReward(rewardPreview.total_reward);
          }
        } else {
          const inv = order.first_review_invalid === true || rewardPreview?.first_review_invalid === true;
          if (inv) {
            rewardInvalidHint = '首评未达有效评价标准，本单未发放奖励金；上列为实际到账金额。';
            if (rewardPreview && rewardPreview.total_reward != null) {
              rewardRuleEstimate = fmtReward(rewardPreview.total_reward);
            }
          }
        }
      }

      this.setData({
        order,
        rewardPreview,
        planItems,
        planValueAdded,
        planDiff,
        finalQuoteDiff,
        completionEvidence,
        loading: false,
        finalQuotePending,
        preQuoteSnap,
        finalQuoteSnap,
        quoteProposalList,
        pendingFinalEvidenceUrls,
        rewardSectionVisible,
        showRewardStages,
        orderFooterVisible,
        rewardDisplayTotal,
        rewardInvalidHint,
        rewardRuleEstimate
      });
      this._startDurationTimer();
      if (order.status < 2) requestUserSubscribe('order_update');
    } catch (e) {
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
      this.setData({ loading: false, orderFooterVisible: false });
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

  onPreviewPendingFinalQuotePhoto(e) {
    const current = e.currentTarget.dataset.url;
    const urls = this.data.pendingFinalEvidenceUrls || [];
    if (urls.length) wx.previewImage({ urls, current: current || urls[0] });
  },

  onPreviewQuoteProposalPhoto(e) {
    const idx = parseInt(e.currentTarget.dataset.idx, 10);
    const current = e.currentTarget.dataset.url;
    const { quoteProposalList } = this.data;
    if (!quoteProposalList || Number.isNaN(idx) || !quoteProposalList[idx]) return;
    const urls = quoteProposalList[idx].photo_urls || [];
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

  async onConfirmFinalQuote(e) {
    const approve = e.currentTarget.dataset.approve === 'true' || e.currentTarget.dataset.approve === true;
    const { order } = this.data;
    if (!order || !this.data.finalQuotePending) return;
    this.setData({ approvingFinal: true });
    try {
      await confirmFinalQuote(order.order_id, approve);
      ui.showSuccess(
        approve
          ? `${QUOTE_LABELS.finalLockedFull}已生效`
          : `已拒绝，维修厂将按${QUOTE_LABELS.biddingPrequoteShort}沟通`
      );
      await this.loadOrder(order.order_id);
    } catch (err) {
      ui.showError(err.message || '操作失败');
    }
    this.setData({ approvingFinal: false });
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
