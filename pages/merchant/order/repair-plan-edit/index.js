// 修改维修方案 - M07
const { getLogger } = require('../../../../../utils/logger');
const ui = require('../../../../../utils/ui');
const { getMerchantToken, getMerchantOrder, updateRepairPlan } = require('../../../../../utils/api');
const { getNavBarHeight } = require('../../../../../utils/util');

const logger = getLogger('RepairPlanEdit');

const REPAIR_TYPES = [{ label: '换', value: '换' }, { label: '修', value: '修' }];
const PARTS_TYPES = [
  { label: '原厂配件', value: '原厂配件' },
  { label: '同质品牌件', value: '同质品牌件' },
  { label: '再制造件', value: '再制造件' },
  { label: '回用拆车件', value: '回用拆车件' }
];

let nextId = 1;

function toEditItems(list, existingPartsTypeMap = {}) {
  return (list || []).map((it, i) => {
    const part = (it.damage_part || it.name || it.item || '').trim();
    const rt = it.repair_type || '修';
    const pt = it.parts_type || '';
    const rtIdx = REPAIR_TYPES.findIndex(r => r.value === rt);
    const ptIdx = pt ? Math.max(0, PARTS_TYPES.findIndex(p => p.value === pt)) : 0;
    const locked = !!existingPartsTypeMap[part];
    return {
      id: 'i-' + (nextId++),
      damage_part: part,
      repair_type: rt,
      repairTypeIndex: rtIdx >= 0 ? rtIdx : 1,
      rtIdx: rtIdx >= 0 ? rtIdx : 1,
      parts_type: pt,
      partsTypeIndex: ptIdx,
      ptIdx: ptIdx,
      partsTypeLocked: locked
    };
  });
}

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    scrollStyle: '',
    orderId: '',
    order: null,
    items: [],
    valueAdded: [],
    repairTypes: REPAIR_TYPES,
    partsTypes: PARTS_TYPES,
    amount: '',
    duration: '3',
    warranty: '12',
    submitting: false,
    existingPartsTypeMap: {}
  },

  onLoad(options) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px', scrollStyle: 'height: calc(100vh - ' + getNavBarHeight() + 'px - 120rpx)' });
    const id = (options.id || '').trim();
    if (!id) {
      ui.showError('订单ID无效');
      return;
    }
    this.setData({ orderId: id });
    if (!getMerchantToken()) {
      wx.redirectTo({ url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/order/repair-plan-edit/index?id=' + id) });
      return;
    }
    this.loadOrder();
  },

  async loadOrder() {
    try {
      const res = await getMerchantOrder(this.data.orderId);
      if (res.status !== 1) {
        ui.showError('仅维修中订单可修改方案');
        setTimeout(() => wx.navigateBack(), 1500);
        return;
      }
      const rp = res.repair_plan || {};
      const quote = res.quote || {};
      const rawItems = (rp.items && rp.items.length) ? rp.items : (quote.items || []);
      const existingMap = {};
      rawItems.forEach(it => {
        const part = (it.damage_part || it.name || it.item || '').trim();
        if (part && it.parts_type) existingMap[part] = it.parts_type;
      });
      const items = toEditItems(rawItems, existingMap);
      const valueAdded = (rp.value_added_services || quote.value_added_services || []).map((v, i) => ({
        id: 'va-' + (nextId++),
        name: typeof v === 'string' ? v : (v.name || v)
      }));
      if (valueAdded.length === 0) valueAdded.push({ id: 'va-' + (nextId++), name: '' });
      const amount = (rp.amount != null ? rp.amount : res.quoted_amount) || '';
      const duration = String(rp.duration || quote.duration || 3);
      const warranty = String(rp.warranty || quote.warranty || 12);
      this.setData({
        order: res,
        items,
        valueAdded,
        amount: String(amount),
        duration,
        warranty,
        existingPartsTypeMap: existingMap
      });
    } catch (err) {
      logger.error('加载订单失败', err);
      ui.showError(err.message || '加载失败');
    }
  },

  onItemInput(e) {
    const id = e.currentTarget.dataset.id;
    const val = (e.detail.value || '').trim();
    const { existingPartsTypeMap } = this.data;
    const items = this.data.items.map(it => {
      if (it.id !== id) return it;
      const locked = !!existingPartsTypeMap[val];
      return { ...it, damage_part: val, partsTypeLocked: locked };
    });
    this.setData({ items });
  },

  onRepairTypeChange(e) {
    const id = e.currentTarget.dataset.id;
    const idx = parseInt(e.detail.value, 10);
    const rt = REPAIR_TYPES[idx]?.value || '修';
    const items = this.data.items.map(it => {
      if (it.id !== id) return it;
      const locked = it.partsTypeLocked;
      return { ...it, repair_type: rt, rtIdx: idx, repairTypeIndex: idx, parts_type: rt === '换' && locked ? it.parts_type : (rt === '换' ? (it.parts_type || '原厂配件') : '') };
    });
    this.setData({ items });
  },

  onPartsTypeChange(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.items.find(it => it.id === id);
    if (item && item.partsTypeLocked) return;
    const idx = parseInt(e.detail.value, 10);
    const pt = PARTS_TYPES[idx]?.value || '';
    const items = this.data.items.map(it => it.id === id ? { ...it, parts_type: pt, ptIdx: idx, partsTypeIndex: idx } : it);
    this.setData({ items });
  },

  onDelItem(e) {
    const id = e.currentTarget.dataset.id;
    const items = this.data.items.filter(it => it.id !== id);
    this.setData({ items });
  },

  onAddItem() {
    const items = [...this.data.items, { id: 'i-' + (nextId++), damage_part: '', repair_type: '修', rtIdx: 1, parts_type: '', ptIdx: 0, partsTypeLocked: false }];
    this.setData({ items });
  },

  onVaInput(e) {
    const id = e.currentTarget.dataset.id;
    const val = (e.detail.value || '').trim();
    const valueAdded = this.data.valueAdded.map(it => it.id === id ? { ...it, name: val } : it);
    this.setData({ valueAdded });
  },

  onDelVa(e) {
    const id = e.currentTarget.dataset.id;
    const valueAdded = this.data.valueAdded.filter(it => it.id !== id);
    this.setData({ valueAdded });
  },

  onAddVa() {
    const valueAdded = [...this.data.valueAdded, { id: 'va-' + (nextId++), name: '' }];
    this.setData({ valueAdded });
  },

  onAmountInput(e) { this.setData({ amount: e.detail.value || '' }); },
  onDurationInput(e) { this.setData({ duration: e.detail.value || '3' }); },
  onWarrantyInput(e) { this.setData({ warranty: e.detail.value || '12' }); },

  async onSubmit() {
    if (this.data.submitting) return;
    const { items, valueAdded, amount, duration, warranty, existingPartsTypeMap } = this.data;
    const validItems = items.filter(it => (it.damage_part || '').trim());
    if (validItems.length === 0) {
      ui.showWarning('请至少添加一个维修项目');
      return;
    }
    const payload = validItems.map(it => {
      const part = (it.damage_part || '').trim();
      const locked = !!existingPartsTypeMap[part];
      return {
        damage_part: part,
        repair_type: it.repair_type || '修',
        parts_type: locked ? existingPartsTypeMap[part] : (it.parts_type || null)
      };
    });
    const va = valueAdded.filter(it => (it.name || '').trim()).map(it => ({ name: (it.name || '').trim() }));
    const amt = parseFloat(amount);
    const dur = parseInt(duration, 10);
    const war = parseInt(warranty, 10);
    this.setData({ submitting: true });
    try {
      await updateRepairPlan(this.data.orderId, {
        items: payload,
        value_added_services: va,
        amount: !Number.isNaN(amt) ? amt : undefined,
        duration: !Number.isNaN(dur) && dur > 0 ? dur : undefined,
        warranty: !Number.isNaN(war) && war > 0 ? war : undefined
      });
      ui.showSuccess('维修方案已更新，请等待车主确认');
      wx.navigateBack();
    } catch (err) {
      logger.error('提交失败', err);
      ui.showError(err.message || '提交失败');
    }
    this.setData({ submitting: false });
  }
});
