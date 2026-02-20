// 竞价详情与报价 - M05，报价明细：损失部位、维修方案+配件类型
const { getLogger } = require('../../../../utils/logger');
const ui = require('../../../../utils/ui');
const { getMerchantToken, getMerchantBidding, submitQuote } = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');

const logger = getLogger('MerchantBiddingDetail');

const ACCIDENT_TYPE_LABELS = {
  single: '单方事故',
  self_fault: '己方全责',
  other_fault: '对方全责',
  other_main: '对方主责',
  self_main: '己方主责'
};

const REPAIR_TYPES = [{ label: '换', value: '换' }, { label: '修', value: '修' }];
const PARTS_TYPES = [
  { label: '原厂配件', value: '原厂配件' },
  { label: '同质品牌件', value: '同质品牌件' },
  { label: '再制造件', value: '再制造件' },
  { label: '回用拆车件', value: '回用拆车件' }
];

let nextId = 1;

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    scrollStyle: '',
    biddingId: '',
    bidding: null,
    quoteItems: [],
    valueAddedServices: [],
    repairTypeOptions: REPAIR_TYPES,
    partsTypeOptions: PARTS_TYPES,
    amount: '',
    duration: 3,
    warranty: 12,
    remark: '',
    submitting: false,
    hasAiSuggestions: false
  },

  onLoad(options) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px', scrollStyle: 'height: calc(100vh - ' + getNavBarHeight() + 'px)' });
    const id = (options.id || '').trim();
    if (!id) {
      ui.showError('竞价ID无效');
      return;
    }
    this.setData({ biddingId: id });
    if (!getMerchantToken()) {
      wx.redirectTo({ url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/bidding/detail/index?id=' + id) });
      return;
    }
    this.loadBidding();
  },

  async loadBidding() {
    try {
      const res = await getMerchantBidding(this.data.biddingId);
      const ins = res.insurance_info || {};
      if (ins.is_insurance && ins.accident_type) {
        ins.accident_type_label = ACCIDENT_TYPE_LABELS[ins.accident_type] || ins.accident_type;
      }
      const hasAi = !!(res.analysis_result && res.analysis_result.repair_suggestions && res.analysis_result.repair_suggestions.length > 0);
      this.setData({
        bidding: res,
        hasAiSuggestions: hasAi,
        duration: res.my_quote ? res.my_quote.duration : 3,
        warranty: res.my_quote ? res.my_quote.warranty : 12,
        remark: res.my_quote ? (res.my_quote.remark || '') : ''
      });
      if (!res.my_quote) {
        this.setData({ quoteItems: [], valueAddedServices: [], amount: '' });
      }
    } catch (err) {
      logger.error('加载竞价详情失败', err);
      ui.showError(err.message || '加载失败');
    }
  },

  onUseAiSuggestions() {
    const { bidding } = this.data;
    const suggestions = bidding?.analysis_result?.repair_suggestions || [];
    const damages = bidding?.analysis_result?.damages || [];
    if (!suggestions.length) return;
    const items = suggestions.map((s, i) => {
      const name = (s.item || '').trim() || ('维修项目' + (i + 1));
      const isReplace = /更换|换|替换/.test(name);
      const damagePart = damages[i] ? (damages[i].part || name.split(/[更换修]/)[0] || name) : name;
      return {
        id: 'ai-' + (nextId++),
        damage_part: damagePart,
        repair_type: isReplace ? '换' : '修',
        repairTypeIndex: isReplace ? 0 : 1,
        parts_type: isReplace ? '原厂配件' : '',
        partsTypeIndex: isReplace ? 0 : -1
      };
    });
    this.setData({ quoteItems: items });
    ui.showSuccess('已采用 AI 建议，可修改后提交');
  },

  onAddValueAdded() {
    const list = [...(this.data.valueAddedServices || []), { id: 'va-' + (nextId++), name: '' }];
    this.setData({ valueAddedServices: list });
  },

  onDelValueAdded(e) {
    const id = e.currentTarget.dataset.id;
    const list = (this.data.valueAddedServices || []).filter(it => it.id !== id);
    this.setData({ valueAddedServices: list });
  },

  onValueAddedInput(e) {
    const id = e.currentTarget.dataset.id;
    const val = (e.detail.value || '').trim();
    const list = (this.data.valueAddedServices || []).map(it =>
      it.id === id ? { ...it, name: val } : it
    );
    this.setData({ valueAddedServices: list });
  },

  onAddItem() {
    const items = [...(this.data.quoteItems || []), {
      id: 'n-' + (nextId++),
      damage_part: '',
      repair_type: '换',
      repairTypeIndex: 0,
      parts_type: '原厂配件',
      partsTypeIndex: 0
    }];
    this.setData({ quoteItems: items });
  },

  onDelItem(e) {
    const id = e.currentTarget.dataset.id;
    const items = (this.data.quoteItems || []).filter(it => it.id !== id);
    this.setData({ quoteItems: items });
  },

  onItemFieldInput(e) {
    const id = e.currentTarget.dataset.id;
    const field = e.currentTarget.dataset.field;
    const val = (e.detail.value || '').trim();
    const items = (this.data.quoteItems || []).map(it =>
      it.id === id ? { ...it, [field]: val } : it
    );
    this.setData({ quoteItems: items });
  },

  onRepairTypeChange(e) {
    const id = e.currentTarget.dataset.id;
    const idx = parseInt(e.detail.value, 10);
    const val = REPAIR_TYPES[idx]?.value || '换';
    const items = (this.data.quoteItems || []).map(it => {
      if (it.id !== id) return it;
      const next = { ...it, repair_type: val, repairTypeIndex: idx };
      if (val === '修') next.parts_type = '';
      else if (!it.parts_type) { next.parts_type = '原厂配件'; next.partsTypeIndex = 0; }
      return next;
    });
    this.setData({ quoteItems: items });
  },

  onPartsTypeChange(e) {
    const id = e.currentTarget.dataset.id;
    const idx = parseInt(e.detail.value, 10);
    const val = PARTS_TYPES[idx]?.value || '原厂配件';
    const items = (this.data.quoteItems || []).map(it =>
      it.id === id ? { ...it, parts_type: val, partsTypeIndex: idx } : it
    );
    this.setData({ quoteItems: items });
  },

  onAmountInput(e) {
    this.setData({ amount: (e.detail.value || '').trim() });
  },

  onDurationInput(e) {
    this.setData({ duration: parseInt(e.detail.value, 10) || 3 });
  },

  onWarrantyInput(e) {
    this.setData({ warranty: parseInt(e.detail.value, 10) || 12 });
  },

  onRemarkInput(e) {
    this.setData({ remark: (e.detail.value || '').trim() });
  },

  async onSubmit() {
    const { biddingId, amount, quoteItems, valueAddedServices, duration, warranty, remark, submitting } = this.data;
    const amt = parseFloat(amount);
    if (!amount || isNaN(amt) || amt <= 0) {
      ui.showWarning('请输入有效报价金额');
      return;
    }
    if (submitting) return;

    const items = (quoteItems || [])
      .filter(it => (it.damage_part || '').trim())
      .map(it => ({
        damage_part: (it.damage_part || '').trim(),
        repair_type: it.repair_type || '修',
        parts_type: it.repair_type === '换' ? (it.parts_type || '原厂配件') : null
      }));

    const value_added_services = (valueAddedServices || [])
      .filter(it => (it.name || '').trim())
      .map(it => ({ name: (it.name || '').trim() }));

    this.setData({ submitting: true });
    try {
      await submitQuote({
        bidding_id: biddingId,
        amount: amt,
        items,
        value_added_services,
        duration: duration || 3,
        warranty: warranty || 12,
        remark: remark || null
      });
      ui.showSuccess('报价已提交');
      setTimeout(() => wx.navigateBack(), 800);
    } catch (err) {
      logger.error('提交报价失败', err);
      ui.showError(err.message || '提交失败');
      this.setData({ submitting: false });
    }
  }
});
