const { getMerchantWarrantyCardTemplates, getMerchantShop, updateMerchantShop } = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');
const ui = require('../../../utils/ui');
const { buildMerchantStylePreviewCard } = require('../../../utils/warranty-card-sample.js');

function themeClassFromTheme(theme) {
  const m = {
    gold: 'warranty-card--gold',
    light: 'warranty-card--light',
    blue: 'warranty-card--blue',
    archive: 'warranty-card--archive',
    track: 'warranty-card--track',
    ink: 'warranty-card--ink'
  };
  return m[theme] || 'warranty-card--gold';
}

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    loading: true,
    saving: false,
    templates: [],
    selectedId: 1,
    shopName: '',
    previewCard: null,
    previewThemeClass: 'warranty-card--gold'
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    this.load();
  },

  rebuildPreview() {
    const { templates, selectedId, shopName } = this.data;
    const tpl = (templates || []).find((t) => t.id === selectedId) || templates[0];
    if (!tpl) return;
    const previewCard = buildMerchantStylePreviewCard(shopName, tpl);
    const previewThemeClass = themeClassFromTheme(tpl.theme);
    this.setData({ previewCard, previewThemeClass });
  },

  async load() {
    this.setData({ loading: true });
    try {
      const [tplData, shop] = await Promise.all([getMerchantWarrantyCardTemplates(), getMerchantShop()]);
      const templates = (tplData && tplData.templates) || [];
      const selectedId = shop && shop.warranty_card_template_id != null ? shop.warranty_card_template_id : 1;
      const shopName = shop && shop.name ? String(shop.name).trim() : '';
      this.setData({ templates, selectedId, shopName, loading: false }, () => this.rebuildPreview());
    } catch (e) {
      this.setData({ loading: false });
      ui.showError((e && e.message) || '加载失败');
    }
  },

  onSelect(e) {
    const id = parseInt(e.currentTarget.dataset.id, 10);
    if (Number.isNaN(id)) return;
    this.setData({ selectedId: id }, () => this.rebuildPreview());
  },

  async onSave() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      await updateMerchantShop({ warranty_card_template_id: this.data.selectedId });
      ui.showSuccess('已保存默认样式');
      setTimeout(() => wx.navigateBack(), 500);
    } catch (e) {
      ui.showError((e && e.message) || '保存失败');
    }
    this.setData({ saving: false });
  }
});
