// 绑定车辆 - 仅车牌号
const { getNavBarHeight } = require('../../../utils/util');
const ui = require('../../../utils/ui');
const { getToken, getUserVehicles, addUserVehicle } = require('../../../utils/api');

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

Page({
  data: {
    list: [],
    plateInput: '',
    loading: false,
    pageRootStyle: 'padding-top: 88px'
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    if (!getToken()) {
      wx.redirectTo({ url: '/pages/auth/login/index' });
      return;
    }
    this.loadList();
  },

  onShow() {
    if (getToken()) this.loadList();
  },

  async loadList() {
    try {
      const res = await getUserVehicles();
      const list = (res?.list || []).map((r) => ({
        ...r,
        created_at_text: formatDate(r.created_at)
      }));
      this.setData({ list });
    } catch (err) {
      console.error('加载车辆列表失败', err);
    }
  },

  onPlateInput(e) {
    this.setData({ plateInput: (e.detail.value || '').trim().toUpperCase() });
  },

  async onAdd() {
    const { plateInput, list } = this.data;
    if (!plateInput || plateInput.length < 5) {
      ui.showError('请输入正确的车牌号');
      return;
    }
    if (list.length >= 3) {
      ui.showError('最多绑定 3 台车辆');
      return;
    }
    this.setData({ loading: true });
    try {
      await addUserVehicle({ plate_number: plateInput });
      ui.showSuccess('添加成功');
      this.setData({ plateInput: '' });
      this.loadList();
    } catch (err) {
      ui.showError(err.message || '添加失败');
    } finally {
      this.setData({ loading: false });
    }
  }
});
