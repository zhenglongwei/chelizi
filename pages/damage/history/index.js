// 定损历史记录
const { getToken, getDamageReports, getUserProfile } = require('../../../utils/api');
const ui = require('../../../utils/ui');
const { getNavBarHeight } = require('../../../utils/util');

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}
const navigation = require('../../../utils/navigation');

Page({
  data: {
    scrollStyle: 'height: 600px',
    hasToken: false,
    list: [],
    page: 1,
    limit: 10,
    total: 0,
    hasMore: true,
    loading: false,
    pageRootStyle: 'padding-top: 88px',
    locationAddress: '',
    locationLat: null,
    locationLng: null
  },

  onLoad() {
    const sys = wx.getSystemInfoSync();
    const navH = getNavBarHeight();
    const winH = sys.windowHeight || 600;
    const locCardH = 120;
    this.setData({
      pageRootStyle: 'padding-top: ' + navH + 'px',
      scrollStyle: 'height: ' + (winH - navH - locCardH - 20) + 'px'
    });
    this.checkToken();
  },

  onShow() {
    this.checkToken();
    if (this.data.hasToken) {
      if (this.data.list.length === 0) this.loadList(true);
      this._loadLocation();
    }
  },

  onPullDownRefresh() {
    this.loadList(true).finally(() => wx.stopPullDownRefresh());
  },

  checkToken() {
    const hasToken = !!getToken();
    this.setData({ hasToken });
    if (hasToken) {
      this.loadList(true);
    }
  },

  async loadList(refresh) {
    if (!getToken()) return;
    if (this.data.loading) return;

    const page = refresh ? 1 : this.data.page;
    if (!refresh && !this.data.hasMore) return;

    this.setData({ loading: true });
    try {
      const res = await getDamageReports({ page, limit: this.data.limit });
      const list = res.list || [];
      const total = res.total || 0;
      const prevList = refresh ? [] : this.data.list;
      const newList = [...prevList, ...list];
      const hasMore = newList.length < total;
      const formatted = newList.map((item) => ({
        ...item,
        created_at: item.created_at ? formatDate(item.created_at) : ''
      }));

      this.setData({
        list: formatted,
        page,
        total,
        hasMore,
        loading: false
      });
    } catch (err) {
      console.error('加载定损历史失败', err);
      this.setData({ loading: false });
    }
  },

  onLoadMore() {
    if (!this.data.hasMore || this.data.loading) return;
    this.setData({ page: this.data.page + 1 }, () => this.loadList(false));
  },

  onItemTap(e) {
    const id = e.currentTarget.dataset.id;
    if (id) {
      wx.setStorageSync('pendingReportId', id);
      navigation.switchTab('/pages/damage/upload/index');
    }
  },

  /** 加载询价位置（统一缓存 user_chosen_location，无则从用户资料拉取并回填） */
  _loadLocation() {
    try {
      const stored = wx.getStorageSync('user_chosen_location');
      if (stored && stored.latitude != null && stored.longitude != null) {
        const addr = stored.address || stored.name || null;
        this.setData({
          locationAddress: addr || '已选择位置（点击查看地图）',
          locationLat: stored.latitude,
          locationLng: stored.longitude
        });
        return;
      }
      if (getToken()) {
        getUserProfile().then((p) => {
          if (p && p.location && p.location.latitude != null && p.location.longitude != null) {
            const addr = [p.location.province, p.location.city, p.location.district].filter(Boolean).join('') ||
              p.location.address || p.location.name || null;
            const loc = {
              latitude: p.location.latitude,
              longitude: p.location.longitude,
              address: addr || p.location.address,
              name: p.location.name
            };
            this.setData({
              locationAddress: addr || '已选择位置（点击查看地图）',
              locationLat: loc.latitude,
              locationLng: loc.longitude
            });
            try {
              wx.setStorageSync('user_chosen_location', loc);
            } catch (_) {}
          }
        }).catch(() => {});
      }
    } catch (_) {}
  },

  /** 点击询价位置 */
  onLocationTap() {
    const { locationLat, locationLng } = this.data;
    if (locationLat != null && locationLng != null) {
      wx.openLocation({
        latitude: locationLat,
        longitude: locationLng,
        name: this.data.locationAddress || '询价位置',
        address: this.data.locationAddress || '',
        scale: 18
      });
    } else {
      this._openChooseLocation();
    }
  },

  

  async _openChooseLocation() {
    const app = getApp();
    try {
      const loc = await app.chooseLocation();
      if (!loc || loc.latitude == null || loc.longitude == null) return;
      const addr = loc.address || loc.name || '已选择位置';
      this.setData({
        locationAddress: addr,
        locationLat: loc.latitude,
        locationLng: loc.longitude
      });
      ui.showSuccess('已选择位置');
    } catch (err) {
      if (err.errMsg && !err.errMsg.includes('cancel')) {
        ui.showError('选择位置失败');
      }
    }
  }
});
