const { getUserOrderWarrantyCard, getMerchantOrderWarrantyCard } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');
const ui = require('../../../utils/ui');
const { formatBeijingDateTimeShort, formatBeijingDateTimeFull } = require('../../../utils/beijing-time');

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    loading: true,
    error: '',
    card: null,
    themeClass: 'warranty-card--gold',
    useSampleItems: false,
    isMerchant: false,
    orderId: ''
  },

  onLoad(options) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    const id = (options.id || '').trim();
    const isMerchant = options.merchant === '1' || options.merchant === 'true';
    if (!id) {
      this.setData({ loading: false, error: '订单无效' });
      return;
    }
    this.setData({ orderId: id, isMerchant });
    this.loadCard();
  },

  async loadCard() {
    this.setData({ loading: true, error: '' });
    try {
      const fetchFn = this.data.isMerchant ? getMerchantOrderWarrantyCard : getUserOrderWarrantyCard;
      const data = await fetchFn(this.data.orderId);
      const theme = (data.template && data.template.theme) || 'gold';
      const themeMap = {
        gold: 'warranty-card--gold',
        light: 'warranty-card--light',
        blue: 'warranty-card--blue',
        archive: 'warranty-card--archive',
        track: 'warranty-card--track',
        ink: 'warranty-card--ink'
      };
      const themeClass = themeMap[theme] || 'warranty-card--gold';
      const ws = data.warranty_start_at;
      const wsShort = formatBeijingDateTimeShort(ws);
      data.warranty_start_at_display = wsShort ? wsShort.slice(0, 10) : '';
      const gen = data.generated_at;
      data.generated_at_display = formatBeijingDateTimeFull(gen);
      const useSampleItems = data.card_phase === 'style_preview';
      this.setData({ card: data, themeClass, useSampleItems, loading: false });
    } catch (e) {
      this.setData({
        loading: false,
        error: (e && e.message) || '加载失败'
      });
      ui.showError((e && e.message) || '加载失败');
    }
  },

  onShareAppMessage() {
    const { orderId, card } = this.data;
    if (card && card.card_phase === 'style_preview') {
      return {
        title: '辙见·凭证样式预览（非正式）',
        path: '/pages/index/index'
      };
    }
    const title = card && card.shop_name ? `${card.shop_name} · 电子质保凭证` : '电子质保凭证';
    return {
      title: orderId ? `${title}（订单 ${orderId}）` : title,
      path: '/pages/order/warranty-card/index?id=' + encodeURIComponent(orderId || '')
    };
  }
});
