const { getNavBarHeight } = require('../../../../utils/util');
const { getMerchantToken, listRepairAlbums, createRepairAlbum } = require('../../../../utils/api');
const ui = require('../../../../utils/ui');

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    list: [],
    empty: true,
    tableReady: true,
  },
  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
  },
  onShow() {
    if (!getMerchantToken()) {
      wx.redirectTo({ url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/repair-album/list/index') });
      return;
    }
    this.load();
  },
  async load() {
    try {
      const res = await listRepairAlbums({});
      const list = (res && res.list) || [];
      const tableReady = res && res.table_ready !== false;
      this.setData({ list, empty: list.length === 0, tableReady });
    } catch (e) {
      ui.showError(e.message || '加载失败');
    }
  },
  async onCreate() {
    try {
      const r = await createRepairAlbum({ template_type: 'accident_default' });
      const id = r && r.album_id;
      if (!id) {
        ui.showError('创建失败');
        return;
      }
      wx.navigateTo({ url: '/pages/merchant/repair-album/detail/index?id=' + encodeURIComponent(id) });
    } catch (e) {
      ui.showError(e.message || '创建失败');
    }
  },
  onOpen(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/merchant/repair-album/detail/index?id=' + encodeURIComponent(id) });
  },
});
