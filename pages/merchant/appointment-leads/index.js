const { getNavBarHeight } = require('../../../utils/util');
const { getMerchantToken, listMerchantAppointmentLeads, patchMerchantAppointmentLead } = require('../../../utils/api');
const ui = require('../../../utils/ui');

Page({
  data: { pageRootStyle: 'padding-top: 88px', list: [], empty: true, tableReady: true },
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
      const res = await listMerchantAppointmentLeads();
      const list = (res && res.list) || [];
      this.setData({ list, empty: list.length === 0, tableReady: res && res.table_ready !== false });
    } catch (e) {
      ui.showError(e.message || '加载失败');
    }
  },

  async onPatchStatus(e) {
    const id = e.currentTarget.dataset.id;
    const status = e.currentTarget.dataset.status;
    if (!id || !status) return;
    const label = status === 'done' ? '已到店/成交' : status === 'confirmed' ? '跟进中' : '无效';
    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: '确认操作',
        content: '将线索标记为「' + label + '」？',
        success: (r) => resolve(!!r.confirm),
      });
    });
    if (!ok) return;
    try {
      await patchMerchantAppointmentLead(id, { status });
      ui.showSuccess('已更新');
      this.load();
    } catch (err) {
      ui.showError(err.message || '更新失败');
    }
  },
});
