// 预约页 - 04a-预约页
const { getLogger } = require('../../../utils/logger');
const ui = require('../../../utils/ui');
const navigation = require('../../../utils/navigation');
const { getShopDetail, createAppointment, getUserProductOrder, getUserOrder } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

const logger = getLogger('ShopBook');

const REPAIR_STATUS_MAP = { 0: '待接单', 1: '维修中', 2: '待确认完成', 3: '已完成', 4: '已取消' };

const TIME_SLOTS = [
  { value: 'morning', label: '上午 8:00-12:00' },
  { value: 'afternoon', label: '下午 12:00-18:00' }
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
    productOrderId: '',
    orderIdForBook: '',
    needContext: false,
    shop: null,
    loading: true,
    pageRootStyle: 'padding-top: 88px',
    dateOpts: getDateOpts(),
    dateIndex: 0,
    selectedDate: '',
    timeSlotIndex: 0,
    timeSlotLabels: TIME_SLOTS.map((s) => s.label),
    selectedServices: [],
    remark: '',
    submitting: false,
    productOrderSummary: null,
    repairOrderSummary: null
  },

  onLoad(options) {
    const id = (options.id || options.shop_id || '').trim();
    const productOrderId = (options.product_order_id || '').trim();
    const orderIdForBook = (options.order_id || '').trim();
    if (!id) {
      ui.showError('缺少维修厂信息');
      setTimeout(() => navigation.navigateBack(), 1500);
      return;
    }
    const dateOpts = getDateOpts();
    const selectedDate = dateOpts[0].value;
    const needContext = !productOrderId && !orderIdForBook;
    this.setData({
      shopId: id,
      productOrderId,
      orderIdForBook,
      needContext,
      dateOpts,
      selectedDate,
      pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px'
    });
    if (needContext) {
      this.setData({ loading: false });
      return;
    }
    this.loadShop();
  },

  onGoOrders() {
    navigation.navigateTo('/pages/order/hub/index');
  },

  onGoShop() {
    navigation.navigateBack();
  },

  async loadLinkedContext() {
    const { productOrderId, orderIdForBook } = this.data;
    if (productOrderId) {
      try {
        const po = await getUserProductOrder(productOrderId);
        const amt = parseFloat(po.amount_total);
        this.setData({
          productOrderSummary: {
            product_name: po.product_name || '商品',
            quantity: po.quantity,
            amountText: (Number.isFinite(amt) ? amt : 0).toFixed(2),
            shop_name: po.shop_name || '',
            paymentLabel: po.payment_status === 'paid' ? '已支付' : po.payment_status
          }
        });
      } catch (e) {
        logger.warn('load product order summary', e);
        this.setData({ productOrderSummary: null });
      }
    }
    if (orderIdForBook) {
      try {
        const o = await getUserOrder(orderIdForBook);
        const st = o.status != null ? parseInt(o.status, 10) : 0;
        const q = parseFloat(o.quoted_amount);
        this.setData({
          repairOrderSummary: {
            order_id: o.order_id,
            shop_name: o.shop_name || '维修厂',
            statusText: REPAIR_STATUS_MAP[st] || '进行中',
            quotedText: Number.isFinite(q) ? q.toFixed(2) : '—'
          }
        });
      } catch (e) {
        logger.warn('load repair order summary', e);
        this.setData({ repairOrderSummary: null });
      }
    }
  },

  async loadShop() {
    try {
      const shop = await getShopDetail(this.data.shopId);
      const services = (shop.services || []).map((s) => ({ ...s, selected: false }));
      this.setData({
        shop: {
          ...shop,
          logo: shop.logo || '/images/brand/brand-app-icon-zhejian.png',
          services
        },
        loading: false
      });
      this.loadLinkedContext();
    } catch (err) {
      logger.error('加载维修厂失败', err);
      ui.showError(err.message || '加载失败');
      this.setData({ loading: false });
      setTimeout(() => navigation.navigateBack(), 1500);
    }
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
    const { shopId, shop, selectedDate, timeSlotIndex, remark, submitting } = this.data;
    if (!shop || submitting) return;

    const selectedServices = (shop.services || []).filter((s) => s.selected);
    const timeSlot = TIME_SLOTS[timeSlotIndex].value;

    if (!selectedDate || !timeSlot) {
      ui.showWarning('请选择预约日期和时段');
      return;
    }

    const token = wx.getStorageSync('token') || '';
    if (!token) {
      ui.showWarning('请先登录后再预约');
      let redirect = '/pages/shop/book/index?id=' + encodeURIComponent(shopId || '');
      if (this.data.productOrderId) redirect += '&product_order_id=' + encodeURIComponent(this.data.productOrderId);
      if (this.data.orderIdForBook) redirect += '&order_id=' + encodeURIComponent(this.data.orderIdForBook);
      navigation.navigateTo('/pages/auth/login/index', { redirect });
      return;
    }

    this.setData({ submitting: true });
    try {
      const payload = {
        shop_id: shopId,
        appointment_date: selectedDate,
        time_slot: timeSlot,
        service_category: 'other',
        services: selectedServices.map((s) => ({ name: s.name, min_price: s.min_price, max_price: s.max_price })),
        remark: remark || undefined
      };
      if (this.data.productOrderId) payload.product_order_id = this.data.productOrderId;
      if (this.data.orderIdForBook) payload.order_id = this.data.orderIdForBook;
      await createAppointment(payload);
      ui.showSuccess('预约提交成功');
      setTimeout(() => navigation.navigateBack(), 1500);
    } catch (err) {
      logger.error('提交预约失败', err);
      ui.showError(err.message || '提交失败');
      this.setData({ submitting: false });
    }
  }
});
