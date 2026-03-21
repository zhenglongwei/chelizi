// 服务商上架/编辑商品
const ui = require('../../../../utils/ui');
const { getMerchantToken, getMerchantProducts, createMerchantProduct, updateMerchantProduct } = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');

const CATEGORIES = ['钣金喷漆', '发动机维修', '电路维修', '保养服务'];

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    productId: '',
    name: '',
    categoryIndex: 0,
    categoryLabel: '',
    price: '',
    description: '',
    categoryOptions: CATEGORIES.map((c) => ({ label: c, value: c })),
    submitting: false
  },

  onLoad(options) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    const productId = options.id || options.product_id;
    if (productId) {
      this.setData({ productId });
      this.loadProduct(productId);
    } else {
      this.setData({ categoryLabel: CATEGORIES[0] });
    }
  },

  async loadProduct(productId) {
    if (!getMerchantToken()) return;
    try {
      const res = await getMerchantProducts();
      const list = (res && res.data && res.data.list) || res.list || [];
      const item = list.find((p) => p.product_id === productId);
      if (!item) {
        ui.showError('商品不存在');
        return;
      }
      const idx = CATEGORIES.indexOf(item.category);
      this.setData({
        name: item.name,
        categoryIndex: idx >= 0 ? idx : 0,
        categoryLabel: item.category,
        price: String(item.price || ''),
        description: item.description || ''
      });
    } catch (err) {
      ui.showError(err.message || '加载失败');
    }
  },

  onNameInput(e) {
    this.setData({ name: (e.detail.value || '').trim() });
  },

  onCategoryChange(e) {
    const idx = parseInt(e.detail.value, 10) || 0;
    this.setData({ categoryIndex: idx, categoryLabel: CATEGORIES[idx] });
  },

  onPriceInput(e) {
    this.setData({ price: (e.detail.value || '').trim() });
  },

  onDescInput(e) {
    this.setData({ description: (e.detail.value || '').trim() });
  },

  async onSubmit() {
    const { productId, name, categoryLabel, price, submitting } = this.data;
    if (submitting) return;
    if (!name || !name.trim()) {
      ui.showWarning('请填写商品名称');
      return;
    }
    if (!categoryLabel) {
      ui.showWarning('请选择服务分类');
      return;
    }
    const priceNum = parseFloat(price);
    if (isNaN(priceNum) || priceNum < 0) {
      ui.showWarning('请填写有效价格');
      return;
    }

    this.setData({ submitting: true });
    try {
      const body = { name: name.trim(), category: categoryLabel, price: priceNum, description: this.data.description || undefined };
      if (productId) {
        await updateMerchantProduct(productId, body);
        ui.showSuccess('已更新并重新提交审核');
      } else {
        await createMerchantProduct(body);
        ui.showSuccess('已提交审核，请等待后台审核通过');
      }
      wx.navigateBack();
    } catch (err) {
      ui.showError(err.message || '提交失败');
    } finally {
      this.setData({ submitting: false });
    }
  }
});
