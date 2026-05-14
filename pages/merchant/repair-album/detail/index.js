const { getNavBarHeight } = require('../../../../utils/util');
const {
  getMerchantToken,
  getRepairAlbum,
  addRepairAlbumMedia,
  submitRepairAlbumPublish,
  approveRepairAlbumPublication,
  uploadMerchantImage,
} = require('../../../../utils/api');
const ui = require('../../../../utils/ui');

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    albumId: '',
    album: {},
    nodes: [],
    mediaByNode: {},
    publication: null,
  },
  onLoad(q) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px', albumId: q.id || '' });
  },
  onShow() {
    if (!getMerchantToken()) {
      wx.redirectTo({ url: '/pages/merchant/login' });
      return;
    }
    if (this.data.albumId) this.reload();
  },
  buildMediaMap(media) {
    const map = {};
    (media || []).forEach((m) => {
      if (!map[m.node_code]) map[m.node_code] = [];
      map[m.node_code].push(m);
    });
    return map;
  },
  async reload() {
    try {
      const res = await getRepairAlbum(this.data.albumId);
      const album = res.album || {};
      const nodes = res.nodes || [];
      const media = res.media || [];
      const publication = res.publication || null;
      this.setData({
        album,
        nodes,
        publication,
        mediaByNode: this.buildMediaMap(media),
      });
    } catch (e) {
      ui.showError(e.message || '加载失败');
    }
  },
  onPickPhoto(e) {
    const nodeCode = e.currentTarget.dataset.code;
    wx.chooseMedia({
      count: 3,
      mediaType: ['image'],
      success: async (r) => {
        const files = r.tempFiles || [];
        wx.showLoading({ title: '上传中' });
        try {
          for (const f of files) {
            const url = await uploadMerchantImage(f.tempFilePath);
            await addRepairAlbumMedia(this.data.albumId, { node_code: nodeCode, url });
          }
          await this.reload();
        } catch (err) {
          ui.showError(err.message || '上传失败');
        } finally {
          wx.hideLoading();
        }
      },
    });
  },
  async onSubmitPublish() {
    try {
      await submitRepairAlbumPublish(this.data.albumId, { desensitized_snapshot: { title: '待完善', hint: '请在运营侧完善脱敏字段' } });
      ui.showSuccess('已提交审核');
      await this.reload();
    } catch (e) {
      ui.showError(e.message || '失败');
    }
  },
  async onApprovePublish() {
    try {
      const r = await approveRepairAlbumPublication(this.data.albumId);
      const url = r && r.published_url;
      ui.showSuccess(url ? '已发布' : '完成');
      await this.reload();
    } catch (e) {
      ui.showError(e.message || '发布失败');
    }
  },
});
