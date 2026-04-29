// 增值服务勾选子页：由竞价报价 / 修改方案等页 navigateTo，经 eventChannel 回传
const {
  buildMerchantVaTemplateGroupsUI,
  isTemplateValueAddedName,
  normalizeVaNameForTemplate,
  findGroupIdForTemplateName,
  VA_COMPLIANCE_HINT_MERCHANT,
  VALUE_ADDED_LEGAL_DISCLAIMER_LINES
} = require('../../../utils/value-added-services');

let nextId = 1;

function normalizeIncomingList(raw) {
  const list = [];
  for (const it of raw || []) {
    const obj = typeof it === 'string' ? { name: it } : (it || {});
    list.push({
      id: obj.id ? obj.id : 'va-' + (nextId++),
      name: typeof it === 'string' ? it : String(obj.name || '')
    });
  }
  return list;
}

Page({
  data: {
    valueAddedServices: [],
    vaTemplateGroupsUI: [],
    customVaRows: [],
    vaComplianceHintMerchant: VA_COMPLIANCE_HINT_MERCHANT,
    vaComplianceLines: VALUE_ADDED_LEGAL_DISCLAIMER_LINES
  },

  onLoad() {
    const ec = this.getOpenerEventChannel && this.getOpenerEventChannel();
    this._ec = ec;
    if (!ec || typeof ec.on !== 'function') return;
    ec.on('initVa', (payload) => {
      const list = normalizeIncomingList(payload && payload.valueAddedServices);
      this.setData({ valueAddedServices: list }, () => this.syncVaUi());
    });
  },

  syncVaUi() {
    const list = this.data.valueAddedServices || [];
    this.setData({
      vaTemplateGroupsUI: buildMerchantVaTemplateGroupsUI(list),
      customVaRows: list.filter((it) => !isTemplateValueAddedName(it.name))
    });
  },

  onVaTemplateTap(e) {
    const label = String(e.currentTarget.dataset.name || '').trim();
    if (!label) return;
    let list = [...(this.data.valueAddedServices || [])];
    const idx = list.findIndex((it) => normalizeVaNameForTemplate(String(it.name || '')) === label);
    if (idx >= 0) list.splice(idx, 1);
    else list.push({ id: 'va-' + (nextId++), name: label });
    this.setData({ valueAddedServices: list }, () => this.syncVaUi());
  },

  onAddCustomVa() {
    const list = [...(this.data.valueAddedServices || []), { id: 'va-' + (nextId++), name: '' }];
    this.setData({ valueAddedServices: list }, () => this.syncVaUi());
  },

  onDelCustomVa(e) {
    const id = e.currentTarget.dataset.id;
    const list = (this.data.valueAddedServices || []).filter((it) => it.id !== id);
    this.setData({ valueAddedServices: list }, () => this.syncVaUi());
  },

  onCustomVaInput(e) {
    const id = e.currentTarget.dataset.id;
    const val = (e.detail.value || '').trim();
    const list = (this.data.valueAddedServices || []).map((it) =>
      it.id === id ? { ...it, name: val } : it
    );
    this.setData({ valueAddedServices: list }, () => this.syncVaUi());
  },

  onCancelTap() {
    wx.navigateBack();
  },

  onDoneTap() {
    const seen = new Set();
    const out = [];
    for (const it of this.data.valueAddedServices || []) {
      const n = String(it.name || '').trim();
      if (!n) continue;
      const canon = normalizeVaNameForTemplate(n);
      const stored = findGroupIdForTemplateName(canon) ? canon : n;
      if (seen.has(stored)) continue;
      seen.add(stored);
      out.push({ id: it.id, name: stored });
    }
    if (this._ec && typeof this._ec.emit === 'function') {
      this._ec.emit('vaDone', { valueAddedServices: out });
    }
    wx.navigateBack();
  }
});
