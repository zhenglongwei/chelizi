// 竞价详情与报价 - M05，报价明细：损失部位、维修方案+配件类型
const { getLogger } = require('../../../../utils/logger');
const ui = require('../../../../utils/ui');
const {
  getMerchantToken,
  getMerchantBidding,
  submitQuote,
  getMerchantQuoteTemplateXlsxUrl,
  previewMerchantQuoteImportXlsx,
  analyzeMerchantQuoteSheetImage,
  merchantUploadImage
} = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');
const { PARTS_TYPES } = require('../../../../utils/parts-types');
const { parseApiErrorFromArrayBuffer, mapImportedRowsToPlanItems } = require('../../../../utils/merchant-quote-import-helpers');
const { mergeHumanDisplayFromAnalysis, filterDamagesByFocus } = require('../../../../utils/analysis-human-display');

const logger = getLogger('MerchantBiddingDetail');

/** 去掉建议项「车辆N-」前缀，便于填损失部位 */
function stripVehiclePrefixFromItem(item) {
  const s = String(item || '').trim();
  const m = s.match(/^车辆\d+[-：]\s*(.+)$/);
  return m ? m[1].trim() : s;
}

const ACCIDENT_TYPE_LABELS = {
  single: '单方事故',
  self_fault: '己方全责',
  other_fault: '对方全责',
  other_main: '对方主责',
  self_main: '己方主责'
};

function analysisHasReportSection(ar, humanDisplay, damagesFiltered) {
  if (!ar || typeof ar !== 'object') return false;
  const d = damagesFiltered != null ? damagesFiltered : ar.damages || [];
  if (Array.isArray(d) && d.length > 0) return true;
  const hd = humanDisplay || {};
  const n =
    (Array.isArray(hd.obvious_damage) ? hd.obvious_damage.length : 0) +
    (Array.isArray(hd.possible_damage) ? hd.possible_damage.length : 0) +
    (Array.isArray(hd.repair_advice) ? hd.repair_advice.length : 0);
  return n > 0;
}

const REPAIR_TYPES = [{ label: '换', value: '换' }, { label: '修', value: '修' }];
const QUOTE_VALIDITY_OPTIONS = [
  { label: '1 天', value: 1 },
  { label: '3 天', value: 3 },
  { label: '5 天', value: 5 },
  { label: '7 天', value: 7 }
];
let nextId = 1;

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    scrollStyle: '',
    biddingId: '',
    bidding: null,
    quoteItems: [],
    valueAddedServices: [],
    repairTypeOptions: REPAIR_TYPES,
    partsTypeOptions: PARTS_TYPES,
    amount: '',
    duration: '',
    remark: '',
    quoteValidityDays: 3,
    quoteValidityIndex: 1,
    quoteValidityOptions: QUOTE_VALIDITY_OPTIONS,
    submitting: false,
    hasAiSuggestions: false,
    importBusy: false,
    aiReportExpanded: false,
    reportHumanDisplay: { obvious_damage: [], possible_damage: [], repair_advice: [] },
    reportDamagesDisplay: [],
    reportHasHumanLines: false,
    reportHasAnalysisSection: false
  },

  onLoad(options) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px', scrollStyle: 'height: calc(100vh - ' + getNavBarHeight() + 'px)' });
    const id = (options.id || '').trim();
    if (!id) {
      ui.showError('竞价ID无效');
      return;
    }
    this.setData({ biddingId: id });
    if (!getMerchantToken()) {
      wx.redirectTo({ url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/bidding/detail/index?id=' + id) });
      return;
    }
    this.loadBidding();
  },

  async loadBidding() {
    try {
      const res = await getMerchantBidding(this.data.biddingId);
      const ins = res.insurance_info || {};
      if (ins.is_insurance && ins.accident_type) {
        ins.accident_type_label = ACCIDENT_TYPE_LABELS[ins.accident_type] || ins.accident_type;
      }
      const hasAi = !!(res.analysis_result && res.analysis_result.repair_suggestions && res.analysis_result.repair_suggestions.length > 0);
      const ar = res.analysis_result || {};
      const viBid = res.vehicle_info && typeof res.vehicle_info === 'object' ? res.vehicle_info : {};
      const focusId = viBid.analysis_focus_vehicle_id || '';
      const reportHumanDisplay = mergeHumanDisplayFromAnalysis(ar, focusId);
      const reportDamagesDisplay = filterDamagesByFocus(ar.damages || [], focusId);
      const reportHasAnalysisSection = analysisHasReportSection(ar, reportHumanDisplay, reportDamagesDisplay);
      const reportHasHumanLines =
        (Array.isArray(reportHumanDisplay.obvious_damage) ? reportHumanDisplay.obvious_damage.length : 0) +
          (Array.isArray(reportHumanDisplay.possible_damage) ? reportHumanDisplay.possible_damage.length : 0) +
          (Array.isArray(reportHumanDisplay.repair_advice) ? reportHumanDisplay.repair_advice.length : 0) >
        0;
      this.setData({
        bidding: res,
        hasAiSuggestions: hasAi,
        duration: res.my_quote ? res.my_quote.duration : '',
        remark: res.my_quote ? (res.my_quote.remark || '') : '',
        reportHumanDisplay,
        reportDamagesDisplay,
        reportHasAnalysisSection,
        reportHasHumanLines,
        aiReportExpanded: false
      });
      if (!res.my_quote) {
        this.setData({ quoteItems: [], valueAddedServices: [], amount: '' });
      }
    } catch (err) {
      logger.error('加载竞价详情失败', err);
      ui.showError(err.message || '加载失败');
    }
  },

  onUseAiSuggestions() {
    const { bidding } = this.data;
    const suggestions = bidding?.analysis_result?.repair_suggestions || [];
    const damages = bidding?.analysis_result?.damages || [];
    if (!suggestions.length) return;
    const items = suggestions.map((s, i) => {
      const name = (s.item || '').trim() || ('维修项目' + (i + 1));
      const isReplace = /更换|换|替换/.test(name);
      const stripped = stripVehiclePrefixFromItem(name);
      const fromLine = damages[i] ? String(damages[i].part || '').trim() : '';
      const damagePart = fromLine || stripped.split(/[更换修]/)[0]?.trim() || stripped || name;
      return {
        id: 'ai-' + (nextId++),
        damage_part: damagePart,
        repair_type: isReplace ? '换' : '修',
        repairTypeIndex: isReplace ? 0 : 1,
        parts_type: isReplace ? '原厂件' : '',
        partsTypeIndex: isReplace ? 0 : 0,
        line_price: '',
        line_warranty: '12'
      };
    });
    this.setData({ quoteItems: items });
    ui.showSuccess('已采用 AI 建议，可修改后提交');
  },

  onAddValueAdded() {
    const list = [...(this.data.valueAddedServices || []), { id: 'va-' + (nextId++), name: '' }];
    this.setData({ valueAddedServices: list });
  },

  onDelValueAdded(e) {
    const id = e.currentTarget.dataset.id;
    const list = (this.data.valueAddedServices || []).filter(it => it.id !== id);
    this.setData({ valueAddedServices: list });
  },

  onValueAddedInput(e) {
    const id = e.currentTarget.dataset.id;
    const val = (e.detail.value || '').trim();
    const list = (this.data.valueAddedServices || []).map(it =>
      it.id === id ? { ...it, name: val } : it
    );
    this.setData({ valueAddedServices: list });
  },

  onAddItem() {
    const items = [...(this.data.quoteItems || []), {
      id: 'n-' + (nextId++),
      damage_part: '',
      repair_type: '换',
      repairTypeIndex: 0,
      parts_type: '原厂件',
      partsTypeIndex: 0,
      line_price: '',
      line_warranty: '12'
    }];
    this.setData({ quoteItems: items });
  },

  onDelItem(e) {
    const id = e.currentTarget.dataset.id;
    const items = (this.data.quoteItems || []).filter(it => it.id !== id);
    this.setData({ quoteItems: items });
  },

  onItemFieldInput(e) {
    const id = e.currentTarget.dataset.id;
    const field = e.currentTarget.dataset.field;
    const val = (e.detail.value || '').trim();
    const items = (this.data.quoteItems || []).map(it =>
      it.id === id ? { ...it, [field]: val } : it
    );
    this.setData({ quoteItems: items });
  },

  onRepairTypeChange(e) {
    const id = e.currentTarget.dataset.id;
    const idx = parseInt(e.detail.value, 10);
    const val = REPAIR_TYPES[idx]?.value || '换';
    const items = (this.data.quoteItems || []).map(it => {
      if (it.id !== id) return it;
      const next = { ...it, repair_type: val, repairTypeIndex: idx };
      if (val === '修') next.parts_type = '';
      else if (!it.parts_type) { next.parts_type = '原厂件'; next.partsTypeIndex = 0; }
      return next;
    });
    this.setData({ quoteItems: items });
  },

  onPartsTypeChange(e) {
    const id = e.currentTarget.dataset.id;
    const idx = parseInt(e.detail.value, 10);
    const val = PARTS_TYPES[idx]?.value || '原厂件';
    const items = (this.data.quoteItems || []).map(it =>
      it.id === id ? { ...it, parts_type: val, partsTypeIndex: idx } : it
    );
    this.setData({ quoteItems: items });
  },

  onAmountInput(e) {
    this.setData({ amount: (e.detail.value || '').trim() });
  },

  onDurationInput(e) {
    const val = (e.detail.value || '').trim();
    const num = parseInt(val, 10);
    this.setData({ duration: val === '' ? '' : (isNaN(num) ? '' : num) });
  },

  onLinePriceInput(e) {
    const id = e.currentTarget.dataset.id;
    const val = (e.detail.value || '').trim();
    const items = this.data.quoteItems.map(it => (it.id === id ? { ...it, line_price: val } : it));
    this.setData({ quoteItems: items });
  },

  onLineWarrantyInput(e) {
    const id = e.currentTarget.dataset.id;
    const val = (e.detail.value || '').trim();
    const items = this.data.quoteItems.map(it => (it.id === id ? { ...it, line_warranty: val } : it));
    this.setData({ quoteItems: items });
  },

  onRemarkInput(e) {
    this.setData({ remark: (e.detail.value || '').trim() });
  },

  onQuoteValidityChange(e) {
    const idx = parseInt(e.detail.value, 10);
    const opt = QUOTE_VALIDITY_OPTIONS[idx];
    if (opt) this.setData({ quoteValidityIndex: idx, quoteValidityDays: opt.value });
  },

  toggleAiReport() {
    this.setData({ aiReportExpanded: !this.data.aiReportExpanded });
  },

  onPreviewPhoto(e) {
    const idx = e.currentTarget.dataset.index;
    const images = (this.data.bidding && this.data.bidding.images) || [];
    if (!images.length) return;
    wx.previewImage({
      current: images[idx] || images[0],
      urls: images
    });
  },

  onDownloadQuoteTemplateExcel() {
    const token = getMerchantToken();
    if (!token) {
      ui.showError('请先登录');
      return;
    }
    const userDataPath = typeof wx !== 'undefined' && wx.env && wx.env.USER_DATA_PATH;
    if (!userDataPath) {
      ui.showError('当前微信版本过低，请升级后重试');
      return;
    }
    wx.showLoading({ title: '下载中', mask: true });
    wx.request({
      url: getMerchantQuoteTemplateXlsxUrl(),
      method: 'GET',
      header: { Authorization: 'Bearer ' + token },
      responseType: 'arraybuffer',
      success: (res) => {
        wx.hideLoading();
        if (res.statusCode !== 200) {
          ui.showError(parseApiErrorFromArrayBuffer(res.data) || '下载失败');
          return;
        }
        const fname = 'zhejian-quote-template.xlsx';
        const filePath = `${userDataPath}/${fname}`;
        wx.getFileSystemManager().writeFile({
          filePath,
          data: res.data,
          success: () => {
            wx.openDocument({
              filePath,
              fileType: 'xlsx',
              showMenu: true,
              success: () => {
                ui.showSuccess('已打开模板，可用右上角菜单保存或分享');
              },
              fail: (e) => {
                logger.warn('openDocument', e);
                ui.showWarning('若无法预览，请到「文件」或微信下载记录中查找 Excel 文件');
              }
            });
          },
          fail: (e) => {
            logger.error('writeFile template', e);
            ui.showError('保存模板失败，请重试');
          }
        });
      },
      fail: (err) => {
        wx.hideLoading();
        ui.showError((err && err.errMsg) || '下载失败');
      }
    });
  },

  onChooseImportExcel() {
    if (this.data.importBusy) return;
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['xlsx'],
      success: (res) => {
        const f = (res.tempFiles && res.tempFiles[0]) || null;
        if (!f || !f.path) {
          ui.showWarning('未选择文件');
          return;
        }
        this.setData({ importBusy: true });
        (async () => {
          try {
            const data = await previewMerchantQuoteImportXlsx(f.path);
            const idCtr = { v: nextId };
            const items = mapImportedRowsToPlanItems(data.items || [], { idCounter: idCtr, withPartsTypeLock: false });
            nextId = idCtr.v;
            const patch = { quoteItems: items, importBusy: false };
            if (data.amount_sum != null && data.amount_sum > 0 && !this.data.amount) {
              patch.amount = String(data.amount_sum);
            }
            this.setData(patch);
            const hints = [];
            if (data.missing_fields && data.missing_fields.length) hints.push('待补全：' + data.missing_fields.join('；'));
            if (data.ai_warnings && data.ai_warnings.length) hints.push('提示：' + data.ai_warnings.join('；'));
            if (data.ai_enrich_error) hints.push('AI：' + data.ai_enrich_error);
            if (hints.length) {
              wx.showModal({ title: '导入完成', content: hints.join('\n'), showCancel: false });
            } else {
              ui.showSuccess('已导入 ' + items.length + ' 条，请核对总价与工期');
            }
          } catch (err) {
            this.setData({ importBusy: false });
            ui.showError(err.message || '导入失败');
          }
        })();
      },
      fail: () => ui.showWarning('未选择文件')
    });
  },

  onAnalyzeQuotePhoto() {
    if (this.data.importBusy) return;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: async (res) => {
        const file = (res.tempFiles && res.tempFiles[0]) || null;
        if (!file || !file.tempFilePath) return;
        this.setData({ importBusy: true });
        try {
          const url = await merchantUploadImage(file.tempFilePath);
          const out = await analyzeMerchantQuoteSheetImage(url);
          if (out.recognition_failed || !(out.items && out.items.length)) {
            const hint = (out.missing_fields && out.missing_fields.join('；')) || '未能识别有效项目';
            ui.showWarning(hint);
            this.setData({ importBusy: false });
            return;
          }
          const idCtr = { v: nextId };
          const items = mapImportedRowsToPlanItems(out.items || [], { idCounter: idCtr, withPartsTypeLock: false });
          nextId = idCtr.v;
          const patch = { quoteItems: items, importBusy: false };
          if (out.amount != null && out.amount > 0 && !this.data.amount) patch.amount = String(out.amount);
          if (out.duration != null && !this.data.duration) patch.duration = String(out.duration);
          this.setData(patch);
          if (out.missing_fields && out.missing_fields.length) {
            wx.showModal({ title: '识别完成', content: '请补全：' + out.missing_fields.join('；'), showCancel: false });
          } else {
            ui.showSuccess('已填入识别结果，请核对分项价与项目质保');
          }
        } catch (err) {
          this.setData({ importBusy: false });
          ui.showError(err.message || '识别失败');
        }
      }
    });
  },

  async onSubmit() {
    const { biddingId, amount, quoteItems, valueAddedServices, duration, remark, submitting } = this.data;
    const amt = parseFloat(amount);
    if (!amount || isNaN(amt) || amt <= 0) {
      ui.showWarning('请输入有效报价金额');
      return;
    }
    const dur = duration === '' || duration == null ? null : parseInt(duration, 10);
    if (dur == null || isNaN(dur) || dur < 0) {
      ui.showWarning('请填写预计工期（天）');
      return;
    }
    if (submitting) return;

    const rawItems = (quoteItems || []).filter(it => (it.damage_part || '').trim());
    if (!rawItems.length) {
      ui.showWarning('请至少填写一条维修项目');
      return;
    }
    let sumLine = 0;
    const items = [];
    for (const it of rawItems) {
      const pr = parseFloat(it.line_price);
      const wm = parseInt(it.line_warranty, 10);
      if (Number.isNaN(pr) || pr < 0 || Number.isNaN(wm) || wm < 0) {
        ui.showWarning('每项须填写有效的分项金额（元）与项目质保（月）');
        return;
      }
      sumLine += pr;
      items.push({
        damage_part: (it.damage_part || '').trim(),
        repair_type: it.repair_type || '修',
        parts_type: it.repair_type === '换' ? (it.parts_type || '原厂件') : null,
        price: Math.round(pr * 100) / 100,
        warranty_months: wm
      });
    }
    if (Math.abs(sumLine - amt) > 0.51) {
      ui.showWarning('分项金额合计 ¥' + sumLine.toFixed(2) + ' 与总报价不一致，请核对');
      return;
    }
    const value_added_services = (valueAddedServices || [])
      .filter(it => (it.name || '').trim())
      .map(it => ({ name: (it.name || '').trim() }));

    this.setData({ submitting: true });
    try {
      await submitQuote({
        bidding_id: biddingId,
        amount: amt,
        items,
        value_added_services,
        duration: dur,
        remark: remark || null,
        quote_validity_days: this.data.quoteValidityDays || 3
      });
      ui.showSuccess('报价已提交');
      setTimeout(() => wx.navigateBack(), 800);
    } catch (err) {
      logger.error('提交报价失败', err);
      ui.showError(err.message || '提交失败');
      this.setData({ submitting: false });
    }
  }
});
