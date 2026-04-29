// 竞价报价页 - 03-竞价报价页
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const { getToken, getBiddingDetail, getBiddingQuotes, selectBiddingShop, seedDevQuotes, endBidding } = require('../../../utils/api');
const { requestUserSubscribe } = require('../../../utils/subscribe');
const { getNavBarHeight, getSystemInfo } = require('../../../utils/util');
const { QUOTE_LABELS: quoteNm } = require('../../../utils/quote-nomenclature');
const { mergeHumanDisplayFromAnalysis, filterDamagesByFocus } = require('../../../utils/analysis-human-display');
const { buildOwnerValueAddedDisplay } = require('../../../utils/value-added-services');
const { buildAccidentReportViewModel } = require('../../../utils/accident-report-presenter');

const logger = getLogger('BiddingDetail');

// 选定前三重确认：强制停留 + 勾选条款（服务端也会校验）
const SELECTION_CONFIRM_DWELL_SECONDS = 5;
const SELECTION_CONFIRM_CLAUSES = [
  { id: 'prequote_only_visual', text: '预报价仅基于照片与描述，到店检测后可能调整。' },
  { id: 'final_may_change', text: '若出现增项/减项，将以订单内“待确认报价”发起确认。' },
  { id: 'can_refuse_if_unexpected', text: '如金额明显超预期或无法接受，可拒绝维修并按规则处理。' },
];

// 07 文档：用户可选排序
const SORT_OPTIONS = [
  { value: 'default', label: '综合推荐' },
  { value: 'price_asc', label: '价格从低到高' },
  { value: 'rating', label: '评价星级优先' },
  { value: 'good_rate', label: '好评率优先' },
  { value: 'bad_rate', label: '差评率低优先' },
  { value: 'distance', label: '距离从近到远' },
  { value: 'warranty', label: '项目质保从长到短' },
];

function formatAmount(v) {
  if (v == null || v === '' || isNaN(v)) return '0.00';
  return Number(v).toFixed(2);
}

function isExpireAtPassed(expireAt) {
  if (!expireAt) return false;
  const t = new Date(expireAt).getTime();
  return t > 0 && t <= Date.now();
}

function formatCountdown(expireAt) {
  if (!expireAt) return '--';
  const end = new Date(expireAt).getTime();
  const now = Date.now();
  const diff = end - now;
  if (diff <= 0) return '窗口已截止';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

function analysisHasReportSection(ar, humanDisplay, damagesFiltered) {
  if (!ar || typeof ar !== 'object') return false;
  const d = damagesFiltered != null ? damagesFiltered : ar.damages || [];
  if (Array.isArray(d) && d.length > 0) return true;
  const hd = humanDisplay || {};
  const n =
    (Array.isArray(hd.obvious_damage) ? hd.obvious_damage.length : 0) +
    (Array.isArray(hd.possible_damage) ? hd.possible_damage.length : 0) +
    (Array.isArray(hd.repair_advice) ? hd.repair_advice.length : 0);
  return n > 0;
}

Page({
  data: {
    biddingId: '',
    bidding: null,
    quotes: [],
    sortType: 'default',
    sortIndex: 0,
    sortOptions: SORT_OPTIONS,
    loading: true,
    error: '',
    hasToken: false,
    countdownText: '--',
    countdownExpired: false,
    reportExpanded: false,
    showQuoteDetailSheet: false,
    sheetQuote: null,
    showConfirm: false,
    confirmQuote: null,
    confirmDwellLeft: 0,
    confirmChecks: {},
    confirmClauses: SELECTION_CONFIRM_CLAUSES,
    selecting: false,
    selectedShopId: '',
    redirectUrl: '',
    showBadReviewPopup: false,
    badReviewPopupText: '',
    pageRootStyle: 'padding-top: 88px',
    scrollStyle: 'height: 600px',
    notifiedCount: 0,
    isDistributionPending: false,
    isDistributionRejected: false,
    rewardPreviewDisclaimer: '',
    quoteNm,
    showOwnerActionsFooter: false,
    showEndRoundDetail: false,
    canRecreateFromDetail: false,
    reportHumanDisplay: { obvious_damage: [], possible_damage: [], repair_advice: [] },
    reportHasAnalysisSection: false,
    reportDamagesDisplay: [],
    reportVm: null
  },

  _timer: null,
  _notifiedTimer: null,
  _confirmTimer: null,

  onLoad(options) {
    const id = (options.id || options.bidding_id || '').trim();
    const navH = getNavBarHeight();
    const sys = getSystemInfo();
    this.setData({
      biddingId: id,
      pageRootStyle: 'padding-top: ' + navH + 'px',
      scrollStyle: 'height: ' + (sys.windowHeight - navH - 20) + 'px',
      redirectUrl: '/pages/auth/login/index?redirect=' + encodeURIComponent('/pages/bidding/detail/index?id=' + id)
    });
    this.checkToken();
    if (id && getToken()) {
      this.loadBidding();
    } else if (!id) {
      this.setData({ loading: false, error: '竞价ID无效' });
    }
  },

  onShow() {
    this.checkToken();
    if (this.data.hasToken && this.data.biddingId) {
      this.loadBidding(this.data.bidding ? 'silent' : false);
    }
  },

  onUnload() {
    if (this._timer) clearInterval(this._timer);
    if (this._notifiedTimer) clearInterval(this._notifiedTimer);
    if (this._confirmTimer) clearInterval(this._confirmTimer);
  },

  _resetSelectionConfirmState() {
    const checks = {};
    for (const c of SELECTION_CONFIRM_CLAUSES) checks[c.id] = false;
    this.setData({ confirmDwellLeft: SELECTION_CONFIRM_DWELL_SECONDS, confirmChecks: checks });
  },

  _startSelectionConfirmDwell() {
    if (this._confirmTimer) clearInterval(this._confirmTimer);
    const tick = () => {
      const left = Math.max(0, (this.data.confirmDwellLeft || 0) - 1);
      this.setData({ confirmDwellLeft: left });
      if (left <= 0 && this._confirmTimer) {
        clearInterval(this._confirmTimer);
        this._confirmTimer = null;
      }
    };
    tick();
    this._confirmTimer = setInterval(tick, 1000);
  },

  _canSubmitSelectionConfirm() {
    if ((this.data.confirmDwellLeft || 0) > 0) return false;
    const checks = this.data.confirmChecks || {};
    for (const c of SELECTION_CONFIRM_CLAUSES) {
      if (!checks[c.id]) return false;
    }
    return true;
  },

  _calcNotifiedCount(bidding) {
    if (!bidding || !bidding.invited_count) return 0;
    const tier1EndsAt = bidding.tier1_window_ends_at ? new Date(bidding.tier1_window_ends_at).getTime() : 0;
    const now = Date.now();
    if (tier1EndsAt && now < tier1EndsAt) {
      return bidding.tier1_count || 0;
    }
    return bidding.invited_count || 0;
  },

  startNotifiedCountUpdate() {
    if (this._notifiedTimer) clearInterval(this._notifiedTimer);
    const { bidding } = this.data;
    if (!bidding || !bidding.tier1_window_ends_at || bidding.invited_count <= (bidding.tier1_count || 0)) return;
    const tier1EndsAt = new Date(bidding.tier1_window_ends_at).getTime();
    const tick = () => {
      const n = this._calcNotifiedCount(this.data.bidding);
      if (n !== this.data.notifiedCount) this.setData({ notifiedCount: n });
      if (Date.now() >= tier1EndsAt && this._notifiedTimer) {
        clearInterval(this._notifiedTimer);
        this._notifiedTimer = null;
      }
    };
    tick();
    this._notifiedTimer = setInterval(tick, 1000);
  },

  checkToken() {
    const hasToken = !!getToken();
    this.setData({ hasToken });
  },

  async loadBidding(silent) {
    const { biddingId } = this.data;
    if (!biddingId || !getToken()) return;
    if (!silent) this.setData({ loading: true, error: '' });
    try {
      const bidding = await getBiddingDetail(biddingId);
      const isInsurance = bidding.insurance_info && bidding.insurance_info.is_insurance;
      const sortType = isInsurance ? 'default' : 'price_asc';
      const sortIndex = SORT_OPTIONS.findIndex((o) => o.value === sortType);
      const notifiedCount = this._calcNotifiedCount(bidding);
      const sel = bidding.selected_shop_id;
      const hasSelection = sel != null && String(sel).trim() !== '';
      const timeExpired = isExpireAtPassed(bidding.expire_at);
      const showEndRoundDetail = bidding.status === 0 && !hasSelection;
      const canRecreateFromDetail =
        !!bidding.report_id &&
        !hasSelection &&
        (bidding.status === 1 || (bidding.status === 0 && timeExpired));
      const showOwnerActionsFooter = showEndRoundDetail || canRecreateFromDetail;
      const ar = bidding.analysis_result || {};
      const viBid = bidding.vehicle_info && typeof bidding.vehicle_info === 'object' ? bidding.vehicle_info : {};
      const focusId = viBid.analysis_focus_vehicle_id || '';
      const reportHumanDisplay = mergeHumanDisplayFromAnalysis(ar, focusId);
      const reportDamagesDisplay = filterDamagesByFocus(ar.damages || [], focusId);
      const reportVm = buildAccidentReportViewModel({
        mode: 'miniapp',
        human_display: reportHumanDisplay,
        damages: reportDamagesDisplay,
      });
      const reportHasAnalysisSection = analysisHasReportSection(ar, reportHumanDisplay, reportDamagesDisplay);
      const ds = String(bidding.distribution_status || '').trim();
      const analysisStatus = bidding.analysis_status;
      const isDistributionPending =
        ds === 'pending' || ds === 'manual_review' || analysisStatus === 0 || analysisStatus === 4;
      const isDistributionRejected = ds === 'rejected' || analysisStatus === 3 || bidding.analysis_relevance === 'irrelevant';

      this.setData({
        bidding,
        sortType,
        sortIndex: sortIndex >= 0 ? sortIndex : 0,
        notifiedCount,
        loading: false,
        isDistributionPending,
        isDistributionRejected,
        showEndRoundDetail,
        canRecreateFromDetail,
        showOwnerActionsFooter,
        reportHumanDisplay,
        reportDamagesDisplay,
        reportHasAnalysisSection,
        reportVm
      });
      this.startCountdown();
      this.startNotifiedCountUpdate();
      this.loadQuotes(sortType);
      // 订阅消息须在用户手势下调用更可靠；自动请求在真机可能被拒，见 onTapSubscribeBiddingQuote
      if (bidding.status === 0) requestUserSubscribe('bidding_quote');
    } catch (err) {
      logger.error('加载竞价失败', err);
      this.setData({ loading: false, error: err.message || '加载失败' });
    }
  },

  async loadQuotes(sortType) {
    const { biddingId } = this.data;
    if (!biddingId || !getToken()) return;
    try {
      const app = getApp();
      let lat = 0, lng = 0;
      const cached = app.getCachedLocation();
      if (cached) {
        lat = cached.latitude || 0;
        lng = cached.longitude || 0;
      }
      const res = await getBiddingQuotes(biddingId, {
        sort_type: sortType,
        latitude: lat,
        longitude: lng
      });
      const disclaimer = res.reward_preview_disclaimer || '';
      const { buildOwnerSideScoreRow } = require('../../../utils/shop-public-score');
      const now = Date.now();
      const list = (res.list || []).map((q, idx) => {
        const scoreRow = buildOwnerSideScoreRow(q);
        const amountText = formatAmount(q.amount);
        let validityText = '';
        if (q.quote_valid_until) {
          const end = new Date(q.quote_valid_until).getTime();
          if (now > end) validityText = '已过期';
          else {
            const days = Math.ceil((end - now) / (24 * 3600 * 1000));
            validityText = days > 1 ? `${days}天内有效` : '今日有效';
          }
        }
        const pr = q.preview_reward_pre;
        const previewRewardText = pr != null && pr !== '' && !isNaN(Number(pr)) ? Number(pr).toFixed(2) : '';
        return {
          ...q,
          amountText,
          showPublicScore: scoreRow.showPublicScore,
          starsDisplay: scoreRow.starsDisplay,
          rating: scoreRow.rating,
          scoreNum: scoreRow.scoreNum,
          goodRateText: q.good_rate != null ? q.good_rate + '%好评' : '',
          recentBadReviewSummary: q.recent_bad_review_summary || '',
          saveText: '',
          validityText,
          previewRewardText,
          hasRewardPreview: !!(q.preview_complexity_level || previewRewardText),
          ownerVaDisplay: buildOwnerValueAddedDisplay(q.value_added_services || [])
        };
      });
      if (sortType === 'price_asc' && list.length > 1) {
        const maxAmount = Math.max(...list.map((q) => parseFloat(q.amount)));
        list.forEach((q) => {
          const save = maxAmount - parseFloat(q.amount);
          if (save > 0) q.saveText = '省' + formatAmount(save) + '元';
        });
      }
      this.setData({ quotes: list, rewardPreviewDisclaimer: disclaimer });
    } catch (err) {
      logger.error('加载报价失败', err);
      ui.showError(err.message || '加载报价失败');
    }
  },

  startCountdown() {
    if (this._timer) clearInterval(this._timer);
    const { bidding } = this.data;
    if (!bidding || !bidding.expire_at) return;
    const tick = () => {
      const text = formatCountdown(bidding.expire_at);
      const expired = text === '窗口已截止';
      this.setData({ countdownText: text, countdownExpired: expired });
      if (expired && this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
    };
    tick();
    this._timer = setInterval(tick, 1000);
  },

  onSortChange(e) {
    const idx = parseInt(e.detail.value, 10);
    if (isNaN(idx) || idx < 0 || idx >= SORT_OPTIONS.length) return;
    const sortType = SORT_OPTIONS[idx].value;
    this.setData({ sortIndex: idx, sortType });
    this.loadQuotes(sortType);
  },

  toggleReport() {
    this.setData({ reportExpanded: !this.data.reportExpanded });
  },

  /** 用户点击：再次申请「新报价」订阅（一次性订阅每同意一次通常多 1 条下发额度） */
  onTapSubscribeBiddingQuote() {
    requestUserSubscribe('bidding_quote').then((ok) => {
      if (ok) wx.showToast({ title: '已订阅报价提醒', icon: 'success' });
      else wx.showToast({ title: '未开启或已取消', icon: 'none' });
    });
  },

  onOpenQuoteSheet(e) {
    const idx = e.currentTarget.dataset.index;
    const quote = (this.data.quotes || [])[idx];
    if (!quote) return;
    this.setData({ showQuoteDetailSheet: true, sheetQuote: quote });
  },

  onCloseQuoteSheet() {
    this.setData({ showQuoteDetailSheet: false, sheetQuote: null });
  },

  onOpenPartsHelp(e) {
    const type = e.currentTarget.dataset.type;
    const q = type ? encodeURIComponent(String(type)) : '';
    wx.navigateTo({
      url: '/pages/help/parts-types/index' + (q ? '?type=' + q : '')
    });
  },

  onSelectFromSheet() {
    const quote = this.data.sheetQuote;
    if (!quote) return;
    if (quote.is_expired) {
      ui.showWarning('该报价已过期');
      return;
    }
    if (this.data.bidding && this.data.bidding.status !== 0) {
      ui.showWarning('该竞价已关闭，无法选厂');
      return;
    }
    this.setData({
      showQuoteDetailSheet: false,
      sheetQuote: null,
      showConfirm: true,
      confirmQuote: quote
    });
    this._resetSelectionConfirmState();
    this._startSelectionConfirmDwell();
  },

  onQuoteLongPress(e) {
    const idx = e.currentTarget.dataset.index;
    const quote = (this.data.quotes || [])[idx];
    const text = quote?.recentBadReviewSummary;
    if (text) {
      this.setData({
        showQuoteDetailSheet: false,
        sheetQuote: null,
        showBadReviewPopup: true,
        badReviewPopupText: text
      });
    } else {
      ui.showWarning('近30天暂无差评');
    }
  },

  onCloseBadReviewPopup() {
    this.setData({ showBadReviewPopup: false, badReviewPopupText: '' });
  },

  onSelectTap(e) {
    const idx = e.currentTarget.dataset.index;
    const quote = (this.data.quotes || [])[idx];
    if (!quote) return;
    if (quote.is_expired) {
      ui.showWarning('该报价已过期');
      return;
    }
    this.setData({
      showQuoteDetailSheet: false,
      sheetQuote: null,
      showConfirm: true,
      confirmQuote: quote
    });
    this._resetSelectionConfirmState();
    this._startSelectionConfirmDwell();
  },

  onCloseConfirm() {
    this.setData({ showConfirm: false, confirmQuote: null });
    if (this._confirmTimer) clearInterval(this._confirmTimer);
    this._confirmTimer = null;
  },

  onToggleConfirmClause(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const checks = { ...(this.data.confirmChecks || {}) };
    checks[id] = !checks[id];
    this.setData({ confirmChecks: checks });
  },

  async onConfirmSelect() {
    const { biddingId, confirmQuote } = this.data;
    if (!confirmQuote || this.data.selecting) return;
    if (!this._canSubmitSelectionConfirm()) {
      ui.showWarning('请先阅读并勾选确认条款');
      return;
    }
    this.setData({ selecting: true, selectedShopId: confirmQuote.shop_id });
    try {
      await requestUserSubscribe('order_update');
      const checkedIds = SELECTION_CONFIRM_CLAUSES.map((c) => c.id).filter((cid) => (this.data.confirmChecks || {})[cid]);
      const clausesTextMap = {};
      for (const c of SELECTION_CONFIRM_CLAUSES) clausesTextMap[c.id] = c.text;
      const res = await selectBiddingShop(biddingId, {
        shop_id: confirmQuote.shop_id,
        selection_confirmation: {
          dwell_seconds: SELECTION_CONFIRM_DWELL_SECONDS,
          checked_clause_ids: checkedIds,
          clauses_text_map: clausesTextMap,
          client_confirmed_at_ms: Date.now(),
          client_meta: { from: 'bidding_detail_confirm_modal' }
        }
      });
      ui.showSuccess('选择成功');
      this.onCloseConfirm();
      navigation.navigateTo('/pages/order/detail/index', { id: res.order_id });
    } catch (err) {
      logger.error('选择维修厂失败', err);
      ui.showError(err.message || '选择失败');
    } finally {
      this.setData({ selecting: false, selectedShopId: '' });
    }
  },

  onBack() {
    wx.navigateBack();
  },

  onEndBiddingFromDetail() {
    const id = this.data.biddingId;
    if (!id) return;
    wx.showModal({
      title: '结束本轮比价',
      content: '确定结束吗？结束后不能再选厂，当前所有报价将作废。',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await endBidding(id);
          ui.showSuccess('已结束本轮');
          await this.loadBidding();
        } catch (err) {
          ui.showError(err.message || '操作失败');
        }
      }
    });
  },

  onRecreateFromDetail() {
    const reportId = this.data.bidding && this.data.bidding.report_id;
    if (!reportId) return;
    wx.showModal({
      title: '重新发起询价',
      content:
        '将使用同一份预报价报告开启新一轮询价。若当前轮仍在进行中或窗口已截止但未关单，会先结束本轮并作废已有报价。确认前往预报价页补充信息后发起？',
      confirmText: '前往',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return;
        wx.setStorageSync('pendingReportId', reportId);
        navigation.switchTab('/pages/damage/upload/index');
      }
    });
  }
});
