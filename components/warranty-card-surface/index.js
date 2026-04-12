const sample = require('../../utils/warranty-card-sample.js');

Component({
  properties: {
    card: {
      type: Object,
      value: null
    },
    themeClass: {
      type: String,
      value: 'warranty-card--gold'
    },
    /** 车主端：样式预览且尚无分项时，用示例行展示完整卡面 */
    useSampleItems: {
      type: Boolean,
      value: false
    },
    showShareHint: {
      type: Boolean,
      value: true
    }
  },

  data: {
    displayItems: [],
    showSampleRibbon: false,
    isOfficial: false,
    isMerchantDemo: false,
    isOwnerStylePreview: false
  },

  observers: {
    'card, useSampleItems': function (card, useSampleItems) {
      this._syncDerived(card, useSampleItems);
    }
  },

  lifetimes: {
    attached() {
      this._syncDerived(this.properties.card, this.properties.useSampleItems);
    }
  },

  methods: {
    _syncDerived(card, useSampleItems) {
      if (!card) {
        this.setData({
          displayItems: [],
          showSampleRibbon: false,
          isOfficial: false,
          isMerchantDemo: false,
          isOwnerStylePreview: false
        });
        return;
      }
      const phase = card.card_phase;
      const isOfficial = phase === 'official';
      const isMerchantDemo = phase === 'merchant_style_demo';
      const isOwnerStylePreview = phase === 'style_preview';
      const raw = Array.isArray(card.items) ? card.items : [];

      let displayItems = raw;
      let showSampleRibbon = false;

      if (isOfficial) {
        displayItems = raw;
      } else if (isMerchantDemo) {
        displayItems = raw.length ? raw.map((x) => ({ ...x })) : sample.SAMPLE_ITEMS.map((x) => ({ ...x }));
        showSampleRibbon = true;
      } else if (isOwnerStylePreview && useSampleItems && !raw.length) {
        displayItems = sample.SAMPLE_ITEMS.map((x) => ({ ...x }));
        showSampleRibbon = true;
      } else {
        displayItems = raw;
      }

      this.setData({
        displayItems,
        showSampleRibbon,
        isOfficial,
        isMerchantDemo,
        isOwnerStylePreview
      });
    }
  }
});
