/**
 * 公示场景评价正文（极简 v3 五段 + 历史表单兜底）
 * 样式与交互集中在此组件，店铺详情 / 口碑流等仅传 review 与 index 并处理事件。
 */
Component({
  properties: {
    review: {
      type: Object,
      value: {},
    },
    index: {
      type: Number,
      value: 0,
    },
    /** 折叠正文时的附加 class（店铺详情 / 口碑流 class 名不同） */
    collapsedContentClass: {
      type: String,
      value: 'detail-review-content-collapsed',
    },
    /** 「展开全文」按钮完整 class */
    expandBtnClass: {
      type: String,
      value: 'detail-review-expand-btn text-primary fs-sm',
    },
  },

  methods: {
    onExpandText() {
      this.triggerEvent('expandtext', { index: this.properties.index });
    },
    onTogglePub(e) {
      const key = e.currentTarget.dataset.key;
      this.triggerEvent('togglepub', { index: this.properties.index, key });
    },
    onToggleReviewImages() {
      this.triggerEvent('togglereviewimages', { index: this.properties.index });
    },
    onToggleQuoteJourney() {
      this.triggerEvent('togglequotejourney', { index: this.properties.index });
    },
    onPreviewImages(e) {
      const { group, current } = e.currentTarget.dataset;
      this.triggerEvent('previewimages', {
        index: this.properties.index,
        group: group || '',
        current: current || '',
      });
    },
    onPreviewQuotePhoto(e) {
      const { qpidx, url } = e.currentTarget.dataset;
      this.triggerEvent('previewquotephoto', {
        index: this.properties.index,
        qpidx: parseInt(qpidx, 10),
        url: url || '',
      });
    },
    onObjectiveTip() {
      wx.showModal({
        title: '如何读「车主核心反馈」',
        content:
          '此处为车主在评价时填写的问卷结论或星级，不是平台鉴定结论。\n\n' +
          '极简版为「修复效果 + 配件核验 + 综合星级」；经典版为「过程透明、配件核对、故障是否修好」等是/否。\n\n' +
          '请结合上方系统校验（报价/结算节点等）与下方主观评价、实拍综合判断；公开列表不展示每轮报价举证原图。',
        showCancel: false,
        confirmText: '知道了',
      });
    },
  },
});
