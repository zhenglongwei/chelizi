// 服务商商品管理
const ui = require('../../../../utils/ui');
const { getMerchantToken, getMerchantProducts, offShelfMerchantProduct } = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');

const STATUS_LABELS = { pending: '待审核', approved: '已上架', rejected: '已驳回', off_shelf: '已下架' };

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    list: []
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
  },

  onShow() {
    if (!getMerchantToken()) {
      wx.redirectTo({ url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/product/list/index') });
      return;
    }
    this.loadList();
  },

  async loadList() {
    try {
      const res = await getMerchantProducts();
      const list = ((res && res.data && res.data.list) || res.list || []).map((item) => ({
        ...item,
        statusLabel: STATUS_LABELS[item.status] || item.status
      }));
      this.setData({ list });
    } catch (err) {
      ui.showError(err.message || '加载失败');
    }
  },

  onAdd() {
    wx.navigateTo({ url: '/pages/merchant/product/edit/index' });
  },

  onEdit(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/merchant/product/edit/index?id=' + id });
  },

  async onOffShelf(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: '确认下架',
        content: '下架后该商品将不再在车主端展示',
        success: (r) => resolve(r.confirm)
      });
    });
    if (!ok) return;
    try {
      await offShelfMerchantProduct(id);
      ui.showSuccess('已下架');
      this.loadList();
    } catch (err) {
      ui.showError(err.message || '下架失败');
    }
  }
});
