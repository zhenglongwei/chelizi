const { getNavBarHeight } = require('../../../../utils/util');
const { getMerchantToken, getMerchantPriceMenu, addMerchantPriceMenuRow, deleteMerchantPriceMenuRow } = require('../../../../utils/api');
const ui = require('../../../../utils/ui');

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    list: [],
    tableReady: true,
    form: { service_name: '', parts_type: '品牌件', craft_standard: '快修标准', ref_min: '', ref_max: '' },
  },
  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
  },
  onShow() {
    if (!getMerchantToken()) {
      wx.redirectTo({ url: '/pages/merchant/login' });
      return;
    }
    this.load();
  },
  async load() {
    try {
      const res = await getMerchantPriceMenu();
      this.setData({
        list: (res && res.list) || [],
        tableReady: res && res.table_ready !== false,
      });
    } catch (e) {
      ui.showError(e.message || '加载失败');
    }
  },
  onF(e) {
    const k = e.currentTarget.dataset.k;
    const v = e.detail.value;
    this.setData({ ['form.' + k]: v });
  },
  async onAdd() {
    const f = this.data.form;
    try {
      await addMerchantPriceMenuRow({
        service_name: f.service_name,
        parts_type: f.parts_type || 'unspecified',
        craft_standard: f.craft_standard || 'standard',
        ref_min: parseFloat(f.ref_min),
        ref_max: parseFloat(f.ref_max),
      });
      ui.showSuccess('已添加');
      this.setData({ form: { service_name: '', parts_type: '品牌件', craft_standard: '快修标准', ref_min: '', ref_max: '' } });
      await this.load();
    } catch (e) {
      ui.showError(e.message || '失败');
    }
  },
  async onDel(e) {
    const id = e.currentTarget.dataset.id;
    try {
      await deleteMerchantPriceMenuRow(id);
      await this.load();
    } catch (err) {
      ui.showError(err.message || '删除失败');
    }
  },
});
