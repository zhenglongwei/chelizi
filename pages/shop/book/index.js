// 预约页 - 04a-预约页
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const { getShopDetail, createAppointment } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

const logger = getLogger('ShopBook');

const TIME_SLOTS = [
  { value: 'morning', label: '上午 8:00-12:00' },
  { value: 'afternoon', label: '下午 12:00-18:00' }
];

const SERVICE_CATEGORIES = [
  { value: 'maintenance', label: '保养' },
  { value: 'wash', label: '洗车' },
  { value: 'repair', label: '修车' },
  { value: 'other', label: '其他' }
];

function getDateOpts() {
  const opts = [];
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    opts.push({
      value: d.toISOString().slice(0, 10),
      label: i === 0 ? '今天' : i === 1 ? '明天' : `${d.getMonth() + 1}月${d.getDate()}日`
    });
  }
  return opts;
}

Page({
  data: {
    shopId: '',
    shop: null,
    loading: true,
    pageRootStyle: 'padding-top: 88px',
    serviceCategories: SERVICE_CATEGORIES,
    serviceCategory: 'maintenance',
    dateOpts: getDateOpts(),
    dateIndex: 0,
    selectedDate: '',
    timeSlotIndex: 0,
    timeSlotLabels: TIME_SLOTS.map((s) => s.label),
    selectedServices: [],
    remark: '',
    submitting: false
  },

  onLoad(options) {
    const id = (options.id || options.shop_id || '').trim();
    if (!id) {
      ui.showError('缺少维修厂信息');
      setTimeout(() => navigation.navigateBack(), 1500);
      return;
    }
    const dateOpts = getDateOpts();
    const selectedDate = dateOpts[0].value;
    this.setData({ shopId: id, dateOpts, selectedDate, pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    this.loadShop();
  },

  async loadShop() {
    try {
      const shop = await getShopDetail(this.data.shopId);
      const services = (shop.services || []).map((s) => ({ ...s, selected: false }));
      this.setData({
        shop: {
          ...shop,
          logo: shop.logo || '/images/logo/logo_white.png',
          services
        },
        loading: false
      });
    } catch (err) {
      logger.error('加载维修厂失败', err);
      ui.showError(err.message || '加载失败');
      this.setData({ loading: false });
      setTimeout(() => navigation.navigateBack(), 1500);
    }
  },

  onCategoryTap(e) {
    const value = e.currentTarget.dataset.value;
    if (value) this.setData({ serviceCategory: value });
  },

  onDateChange(e) {
    const idx = parseInt(e.detail.value, 10) || 0;
    const dateOpts = this.data.dateOpts;
    this.setData({ dateIndex: idx, selectedDate: dateOpts[idx].value });
  },

  onTimeSlotChange(e) {
    const idx = parseInt(e.detail.value, 10) || 0;
    this.setData({ timeSlotIndex: idx });
  },

  onServiceTap(e) {
    const idx = e.currentTarget.dataset.index;
    const shop = this.data.shop;
    const services = [...shop.services];
    services[idx].selected = !services[idx].selected;
    this.setData({ shop: { ...shop, services } });
  },

  onRemarkInput(e) {
    this.setData({ remark: (e.detail.value || '').trim() });
  },

  async onSubmit() {
    const { shopId, shop, selectedDate, timeSlotIndex, serviceCategory, remark, submitting } = this.data;
    if (!shop || submitting) return;

    const selectedServices = (shop.services || []).filter((s) => s.selected);
    const timeSlot = TIME_SLOTS[timeSlotIndex].value;

    if (!selectedDate || !timeSlot) {
      ui.showWarning('请选择预约日期和时段');
      return;
    }
    if (!serviceCategory) {
      ui.showWarning('请选择服务类型');
      return;
    }

    const token = wx.getStorageSync('token') || '';
    if (!token) {
      ui.showWarning('请先登录后再预约');
      const redirect = '/pages/shop/book/index?id=' + (shopId || '');
      navigation.navigateTo('/pages/auth/login/index', { redirect });
      return;
    }

    this.setData({ submitting: true });
    try {
      await createAppointment({
        shop_id: shopId,
        appointment_date: selectedDate,
        time_slot: timeSlot,
        service_category: serviceCategory,
        services: selectedServices.map((s) => ({ name: s.name, min_price: s.min_price, max_price: s.max_price })),
        remark: remark || undefined
      });
      ui.showSuccess('预约提交成功');
      setTimeout(() => navigation.navigateBack(), 1500);
    } catch (err) {
      logger.error('提交预约失败', err);
      ui.showError(err.message || '提交失败');
      this.setData({ submitting: false });
    }
  }
});
