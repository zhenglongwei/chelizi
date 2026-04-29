const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const { getBiddingDetail, getToken } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

const logger = getLogger('BiddingWait');

function inferState(bidding) {
  const ds = String(bidding?.distribution_status || '').trim();
  const analysisStatus = bidding?.analysis_status;
  const analysisRel = bidding?.analysis_relevance;
  const invited = bidding?.invited_count || 0;

  const rejected = ds === 'rejected' || analysisStatus === 3 || analysisRel === 'irrelevant';
  if (rejected) return 'rejected';

  const manual = ds === 'manual_review' || analysisStatus === 4;
  if (manual) return 'manual_review';

  const done = ds === 'done' || invited > 0;
  if (done) return 'done';

  return 'pending';
}

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    biddingId: '',
    title: '正在分发',
    subtitle: '正在审核材料与匹配服务商，请稍候',
    extraHint: '',
    showBackToPrequote: false,
    showGoBiddingDetail: false,
    _pollCount: 0,
  },

  onLoad(options) {
    const id = (options.id || options.bidding_id || '').trim();
    if (!id) {
      ui.showError('竞价ID无效');
      setTimeout(() => navigation.navigateBack(), 1200);
      return;
    }
    this.setData({ biddingId: id, pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
  },

  onShow() {
    if (!getToken()) return;
    this._startPoll();
  },

  onHide() {
    this._stopPoll();
  },

  onUnload() {
    this._stopPoll();
  },

  _stopPoll() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  },

  _startPoll() {
    this._stopPoll();
    this._pollOnce();
  },

  async _pollOnce() {
    const { biddingId } = this.data;
    if (!biddingId) return;
    try {
      const bidding = await getBiddingDetail(biddingId);
      const state = inferState(bidding);
      const n = (this.data._pollCount || 0) + 1;

      if (state === 'done') {
        navigation.redirectTo('/pages/bidding/detail/index', { id: biddingId });
        return;
      }
      if (state === 'rejected') {
        this.setData({
          title: '未通过审核',
          subtitle: '图片与修车无关，请返回重新上传事故照片',
          extraHint: '',
          showBackToPrequote: true,
          showGoBiddingDetail: false,
          _pollCount: n,
        });
        return;
      }
      if (state === 'manual_review') {
        this.setData({
          title: '人工审核中',
          subtitle: '系统繁忙，正在人工审核材料，审核通过后将自动分发',
          extraHint: '你可以先离开本页，稍后在“我的竞价”查看进度',
          showBackToPrequote: false,
          showGoBiddingDetail: true,
          _pollCount: n,
        });
      } else {
        const longWait = n >= 30;
        this.setData({
          title: '正在分发',
          subtitle: '正在审核材料与匹配服务商，请稍候',
          extraHint: longWait ? '当前排队较多，已提交成功，你可以稍后在“我的竞价”查看' : '',
          showBackToPrequote: false,
          showGoBiddingDetail: longWait,
          _pollCount: n,
        });
      }
    } catch (e) {
      logger.warn('轮询失败', e);
    }
    this._timer = setTimeout(() => this._pollOnce(), 2000);
  },

  onBackToPrequote() {
    navigation.redirectTo('/pages/damage/upload/index');
  },

  onGoBiddingDetail() {
    const id = this.data.biddingId;
    if (!id) return;
    navigation.redirectTo('/pages/bidding/detail/index', { id });
  },
});

