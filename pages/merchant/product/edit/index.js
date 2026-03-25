// 服务商上架/编辑商品
const ui = require('../../../../utils/ui');
const {
  getMerchantToken,
  getMerchantProducts,
  createMerchantProduct,
  updateMerchantProduct,
  merchantUploadImage
} = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');

const CATEGORIES = ['钣金喷漆', '发动机维修', '电路维修', '保养服务'];
const MAX_IMAGES = 6;
const MIN_PRICE = 0.01;

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    productId: '',
    name: '',
    categoryIndex: 0,
    categoryLabel: '',
    price: '',
    description: '',
    images: [],
    maxImages: MAX_IMAGES,
    uploadingImage: false,
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
      const imgs = Array.isArray(item.images) ? item.images : [];
      this.setData({
        name: item.name,
        categoryIndex: idx >= 0 ? idx : 0,
        categoryLabel: item.category,
        price: String(item.price || ''),
        description: item.description || '',
        images: imgs.filter(Boolean).slice(0, MAX_IMAGES)
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

  onRemoveImage(e) {
    const idx = parseInt(e.currentTarget.dataset.index, 10);
    if (isNaN(idx)) return;
    const images = [...this.data.images];
    images.splice(idx, 1);
    this.setData({ images });
  },

  async onAddImages() {
    const { images, uploadingImage } = this.data;
    if (uploadingImage) return;
    const remain = MAX_IMAGES - images.length;
    if (remain <= 0) {
      ui.showWarning('最多上传' + MAX_IMAGES + '张图');
      return;
    }
    const choose = await new Promise((resolve) => {
      wx.chooseImage({
        count: Math.min(remain, 9),
        sizeType: ['compressed'],
        sourceType: ['album', 'camera'],
        success: (r) => resolve(r.tempFilePaths || []),
        fail: () => resolve([])
      });
    });
    if (!choose.length) return;
    this.setData({ uploadingImage: true });
    try {
      const next = [...images];
      for (const path of choose) {
        if (next.length >= MAX_IMAGES) break;
        const url = await merchantUploadImage(path);
        if (url) next.push(url);
      }
      this.setData({ images: next });
    } catch (err) {
      ui.showError(err.message || '上传失败');
    } finally {
      this.setData({ uploadingImage: false });
    }
  },

  async onSubmit() {
    const { productId, name, categoryLabel, price, submitting, images } = this.data;
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
    if (isNaN(priceNum) || priceNum < MIN_PRICE) {
      ui.showWarning('价格不能低于 ' + MIN_PRICE + ' 元');
      return;
    }

    this.setData({ submitting: true });
    try {
      const body = {
        name: name.trim(),
        category: categoryLabel,
        price: priceNum,
        description: this.data.description || undefined,
        images: images || []
      };
      if (productId) {
        const res = await updateMerchantProduct(productId, body);
        ui.showSuccess((res && res.message) || '已更新');
      } else {
        const res = await createMerchantProduct(body);
        ui.showSuccess((res && res.message) || '已提交审核，请等待后台审核通过');
      }
      wx.navigateBack();
    } catch (err) {
      ui.showError(err.message || '提交失败');
    } finally {
      this.setData({ submitting: false });
    }
  }
});
