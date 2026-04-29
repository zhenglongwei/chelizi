// 修改维修方案 - M07
const { getLogger } = require('../../../../utils/logger')
const ui = require('../../../../utils/ui');
const {
  getMerchantToken,
  getMerchantOrder,
  updateRepairPlan,
  submitMerchantFinalQuote,
  merchantUploadImage,
  getMerchantQuoteTemplateXlsxUrl,
  previewMerchantQuoteImportXlsx,
  analyzeMerchantQuoteSheetImage
} = require('../../../../utils/api');
const {
  parseApiErrorFromArrayBuffer,
  mapImportedRowsToPlanItems,
  extractDamagePartFromAiSuggestionItem,
  dedupeAiSuggestionQuoteItemsByDamagePart
} = require('../../../../utils/merchant-quote-import-helpers');
const { getNavBarHeight } = require('../../../../utils/util');
const { PARTS_TYPES, normalizePartsTypeLabel, partsTypePickerIndex } = require('../../../../utils/parts-types');
const { mergeHumanDisplayFromAnalysis, filterDamagesByFocus } = require('../../../../utils/analysis-human-display');
const { buildAccidentReportViewModel } = require('../../../../utils/accident-report-presenter');

const logger = getLogger('RepairPlanEdit');

function buildVaChosenLabels(services) {
  return (services || []).map((it) => String(it.name || '').trim()).filter(Boolean);
}

const REPAIR_TYPES = [{ label: '换', value: '换' }, { label: '修', value: '修' }];

const ACCIDENT_TYPE_LABELS = {
  single: '单方事故',
  self_fault: '己方全责',
  other_fault: '对方全责',
  equal_fault: '同等责任',
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

let nextId = 1;

/** 再次报价：总报价展示值 = 有损失部位且分项价为有效数字的行之和（与提交校验一致） */
function computeFinalTotalFromItems(items) {
  let sum = 0;
  let any = false;
  for (const it of items || []) {
    if (!(it.damage_part || '').trim()) continue;
    const pr = parseFloat(it.line_price);
    if (Number.isNaN(pr) || pr < 0) continue;
    any = true;
    sum += pr;
  }
  if (!any) return '';
  return String(Math.round(sum * 100) / 100);
}

function toEditItems(list, existingPartsTypeMap = {}) {
  return (list || []).map((it) => {
    const part = (it.damage_part || it.name || it.item || '').trim();
    const rt = it.repair_type || '修';
    const ptRaw = it.parts_type ? normalizePartsTypeLabel(it.parts_type) : '';
    const pt = rt === '换' ? (ptRaw || '原厂件') : '';
    const rtIdx = REPAIR_TYPES.findIndex(r => r.value === rt);
    const ptIdx = rt === '换' ? partsTypePickerIndex(pt) : 0;
    const locked = !!existingPartsTypeMap[part];
    const linePrice = it.price != null && !Number.isNaN(parseFloat(it.price)) ? String(it.price) : '';
    const lineWar = it.warranty_months != null && !Number.isNaN(parseInt(it.warranty_months, 10))
      ? String(parseInt(it.warranty_months, 10))
      : '';
    return {
      id: 'i-' + (nextId++),
      damage_part: part,
      repair_type: rt,
      repairTypeIndex: rtIdx >= 0 ? rtIdx : 1,
      rtIdx: rtIdx >= 0 ? rtIdx : 1,
      parts_type: pt,
      partsTypeIndex: ptIdx,
      ptIdx,
      partsTypeLocked: locked,
      line_price: linePrice,
      line_warranty: lineWar
    };
  });
}

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    scrollStyle: '',
    orderId: '',
    order: null,
    items: [],
    valueAdded: [],
    repairTypes: REPAIR_TYPES,
    partsTypes: PARTS_TYPES,
    amount: '',
    duration: '3',
    submitting: false,
    existingPartsTypeMap: {},
    isFinalMode: false,
    navTitle: '修改维修方案',
    lossAssessmentUrls: [],
    evidencePhotoUrls: [],
    isInsurance: false,
    lossSupplementNote: '',
    importBusy: false,
    hasAiSuggestions: false,
    aiReportExpanded: false,
    reportHumanDisplay: { obvious_damage: [], possible_damage: [], repair_advice: [] },
    reportHasAnalysisSection: false,
    reportDamagesDisplay: [],
    reportVm: null,
    vaChosenLabels: []
  },

  onLoad(options) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px', scrollStyle: 'height: calc(100vh - ' + getNavBarHeight() + 'px - 120rpx)' });
    const id = (options.id || '').trim();
    const isFinalMode = (options.mode || '') === 'final';
    if (!id) {
      ui.showError('订单ID无效');
      return;
    }
    this.setData({
      orderId: id,
      isFinalMode,
      navTitle: isFinalMode ? '修改报价单' : '修改维修方案'
    });
    if (!getMerchantToken()) {
      const path = '/pages/merchant/order/repair-plan-edit/index?id=' + id + (isFinalMode ? '&mode=final' : '');
      wx.redirectTo({ url: '/pages/merchant/login?redirect=' + encodeURIComponent(path) });
      return;
    }
    this.loadOrder();
  },

  async loadOrder() {
    try {
      const res = await getMerchantOrder(this.data.orderId);
      if (res.status !== 1) {
        ui.showError('仅维修中订单可操作');
        setTimeout(() => wx.navigateBack(), 1500);
        return;
      }
      if (this.data.isFinalMode) {
        if (!res.pre_quote_snapshot) {
          ui.showError('当前订单未启用双阶段报价');
          setTimeout(() => wx.navigateBack(), 1500);
          return;
        }
      }
      const rp = res.repair_plan || {};
      const quote = res.quote || {};
      const rawItems = (rp.items && rp.items.length) ? rp.items : (quote.items || []);
      const existingMap = {};
      rawItems.forEach(it => {
        const part = (it.damage_part || it.name || it.item || '').trim();
        if (part && it.parts_type) existingMap[part] = normalizePartsTypeLabel(it.parts_type) || it.parts_type;
      });
      let items = toEditItems(rawItems, existingMap);
      items = items.map((row) => ({
        ...row,
        line_warranty: row.line_warranty || '12'
      }));
      const valueAdded = (rp.value_added_services || quote.value_added_services || []).map((v, i) => ({
        id: 'va-' + (nextId++),
        name: typeof v === 'string' ? v : (v.name || v)
      }));
      const amount = (rp.amount != null ? rp.amount : res.quoted_amount) || '';
      const duration = String(rp.duration || quote.duration || 3);
      const ins = res.is_insurance_accident === 1 || res.is_insurance_accident === '1';
      const hasAi = !!(res.analysis_result && res.analysis_result.repair_suggestions && res.analysis_result.repair_suggestions.length > 0);
      const ar = res.analysis_result || {};
      const viOrd = res.vehicle_info && typeof res.vehicle_info === 'object' ? res.vehicle_info : {};
      const focusId = viOrd.analysis_focus_vehicle_id || '';
      const reportHumanDisplay = mergeHumanDisplayFromAnalysis(ar, focusId);
      const reportDamagesDisplay = filterDamagesByFocus(ar.damages || [], focusId);
      const reportVm = buildAccidentReportViewModel({
        mode: 'miniapp',
        human_display: reportHumanDisplay,
        damages: reportDamagesDisplay,
      });
      const reportHasAnalysisSection = analysisHasReportSection(ar, reportHumanDisplay, reportDamagesDisplay);
      let insuranceInfo = res.insurance_info && typeof res.insurance_info === 'object' ? { ...res.insurance_info } : {};
      if (insuranceInfo.is_insurance && insuranceInfo.accident_type && !insuranceInfo.accident_type_label) {
        insuranceInfo.accident_type_label = ACCIDENT_TYPE_LABELS[insuranceInfo.accident_type] || insuranceInfo.accident_type;
      }
      const orderPayload = {
        ...res,
        images: Array.isArray(res.images) ? res.images : [],
        insurance_info: insuranceInfo,
        vehicle_info: res.vehicle_info && typeof res.vehicle_info === 'object' ? res.vehicle_info : {}
      };
      this.setData({
        order: orderPayload,
        items,
        valueAdded,
        amount: String(amount),
        duration,
        existingPartsTypeMap: existingMap,
        isInsurance: !!ins,
        hasAiSuggestions: hasAi,
        reportHumanDisplay,
        reportDamagesDisplay,
        reportHasAnalysisSection,
        reportVm,
        aiReportExpanded: false,
        vaChosenLabels: buildVaChosenLabels(valueAdded)
      });
    } catch (err) {
      logger.error('加载订单失败', err);
      ui.showError(err.message || '加载失败');
    }
  },

  onItemInput(e) {
    const id = e.currentTarget.dataset.id;
    const val = (e.detail.value || '').trim();
    const { existingPartsTypeMap } = this.data;
    const items = this.data.items.map(it => {
      if (it.id !== id) return it;
      const locked = !!existingPartsTypeMap[val];
      return { ...it, damage_part: val, partsTypeLocked: locked };
    });
    const patch = { items };
    if (this.data.isFinalMode) patch.amount = computeFinalTotalFromItems(items);
    this.setData(patch);
  },

  onRepairTypeChange(e) {
    const id = e.currentTarget.dataset.id;
    const idx = parseInt(e.detail.value, 10);
    const rt = REPAIR_TYPES[idx]?.value || '修';
    const items = this.data.items.map(it => {
      if (it.id !== id) return it;
      const locked = it.partsTypeLocked;
      const nextPt = rt === '换' && locked ? it.parts_type : (rt === '换' ? (it.parts_type || '原厂件') : '');
      const nextPtIdx = rt === '换' ? partsTypePickerIndex(nextPt) : 0;
      return { ...it, repair_type: rt, rtIdx: idx, repairTypeIndex: idx, parts_type: nextPt, partsTypeIndex: nextPtIdx };
    });
    this.setData({ items });
  },

  onPartsTypeChange(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.items.find(it => it.id === id);
    if (item && item.partsTypeLocked) return;
    const idx = parseInt(e.detail.value, 10);
    const pt = PARTS_TYPES[idx]?.value || '原厂件';
    const items = this.data.items.map(it => it.id === id ? { ...it, parts_type: pt, ptIdx: idx, partsTypeIndex: idx } : it);
    this.setData({ items });
  },

  onDelItem(e) {
    const id = e.currentTarget.dataset.id;
    const items = this.data.items.filter(it => it.id !== id);
    const patch = { items };
    if (this.data.isFinalMode) patch.amount = computeFinalTotalFromItems(items);
    this.setData(patch);
  },

  onAddItem() {
    const items = [...this.data.items, {
      id: 'i-' + (nextId++),
      damage_part: '',
      repair_type: '修',
      rtIdx: 1,
      parts_type: '',
      ptIdx: 0,
      partsTypeLocked: false,
      line_price: '',
      line_warranty: '12'
    }];
    this.setData({ items });
  },

  onOpenQuoteValueAdded() {
    wx.navigateTo({
      url: '/pages/merchant/quote-value-added/index',
      events: {
        vaDone: (data) => {
          const list = Array.isArray(data.valueAddedServices) ? data.valueAddedServices : [];
          this.setData({
            valueAdded: list,
            vaChosenLabels: buildVaChosenLabels(list)
          });
        }
      },
      success: (res) => {
        if (res.eventChannel && typeof res.eventChannel.emit === 'function') {
          res.eventChannel.emit('initVa', { valueAddedServices: this.data.valueAdded || [] });
        }
      }
    });
  },

  onAmountInput(e) { this.setData({ amount: e.detail.value || '' }); },
  onDurationInput(e) { this.setData({ duration: e.detail.value || '3' }); },
  onLinePriceInput(e) {
    const id = e.currentTarget.dataset.id;
    const val = (e.detail.value || '').trim();
    const items = this.data.items.map(it => (it.id === id ? { ...it, line_price: val } : it));
    const patch = { items };
    if (this.data.isFinalMode) patch.amount = computeFinalTotalFromItems(items);
    this.setData(patch);
  },
  onLineWarrantyInput(e) {
    const id = e.currentTarget.dataset.id;
    const val = (e.detail.value || '').trim();
    const items = this.data.items.map(it => (it.id === id ? { ...it, line_warranty: val } : it));
    this.setData({ items });
  },

  onChooseLossPhoto() {
    const n = 6 - (this.data.lossAssessmentUrls || []).length;
    if (n <= 0) return;
    wx.chooseMedia({
      count: n,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: async (res) => {
        const files = (res.tempFiles || []).slice(0, n);
        const urls = [...(this.data.lossAssessmentUrls || [])];
        for (const f of files) {
          try {
            urls.push(await merchantUploadImage(f.tempFilePath));
          } catch (e) {
            ui.showError(e && e.message ? e.message : '上传失败');
          }
        }
        this.setData({ lossAssessmentUrls: urls });
      }
    });
  },
  onDelLoss(e) {
    const idx = e.currentTarget.dataset.index;
    const urls = [...(this.data.lossAssessmentUrls || [])];
    urls.splice(idx, 1);
    this.setData({ lossAssessmentUrls: urls });
  },

  onChooseEvidencePhoto() {
    const n = 9 - (this.data.evidencePhotoUrls || []).length;
    if (n <= 0) return;
    wx.chooseMedia({
      count: n,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: async (res) => {
        const files = (res.tempFiles || []).slice(0, n);
        const urls = [...(this.data.evidencePhotoUrls || [])];
        for (const f of files) {
          try {
            urls.push(await merchantUploadImage(f.tempFilePath));
          } catch (e) {
            ui.showError(e && e.message ? e.message : '上传失败');
          }
        }
        this.setData({ evidencePhotoUrls: urls });
      }
    });
  },
  onDelEvidence(e) {
    const idx = e.currentTarget.dataset.index;
    const urls = [...(this.data.evidencePhotoUrls || [])];
    urls.splice(idx, 1);
    this.setData({ evidencePhotoUrls: urls });
  },

  onLossSupplementInput(e) {
    this.setData({ lossSupplementNote: e.detail.value || '' });
  },

  toggleAiReport() {
    this.setData({ aiReportExpanded: !this.data.aiReportExpanded });
  },

  onPreviewOwnerDamagePhoto(e) {
    const idx = e.currentTarget.dataset.index;
    const images = (this.data.order && this.data.order.images) || [];
    if (!images.length) return;
    wx.previewImage({
      current: images[idx] || images[0],
      urls: images
    });
  },

  onUseAiSuggestions() {
    const order = this.data.order;
    const suggestions = order?.analysis_result?.repair_suggestions || [];
    if (!suggestions.length) return;
    const { existingPartsTypeMap } = this.data;
    const rawItems = suggestions.map((s, i) => {
      const name = (s.item || '').trim() || ('维修项目' + (i + 1));
      const methodRaw = String(s.repair_method || s.repair_type || '').trim();
      const isReplace =
        methodRaw === '换' || (methodRaw !== '修' && !methodRaw && /更换|换|替换/.test(name));
      const fromApi = String(s.damage_part || s.part || '').trim();
      const part = (fromApi || extractDamagePartFromAiSuggestionItem(name) || ('维修项目' + (i + 1))).trim();
      const locked = !!existingPartsTypeMap[part];
      const rt = isReplace ? '换' : '修';
      const pt = rt === '换' ? (locked ? existingPartsTypeMap[part] : '原厂件') : '';
      const rtIdx = rt === '换' ? 0 : 1;
      const ptIdx = rt === '换' ? partsTypePickerIndex(pt) : 0;
      return {
        id: 'ai-' + (nextId++),
        damage_part: part,
        repair_type: rt,
        repairTypeIndex: rtIdx,
        rtIdx,
        parts_type: pt,
        partsTypeIndex: ptIdx,
        ptIdx,
        partsTypeLocked: locked,
        line_price: '',
        line_warranty: '12'
      };
    });
    const items = dedupeAiSuggestionQuoteItemsByDamagePart(rawItems);
    const patch = { items };
    if (this.data.isFinalMode) patch.amount = computeFinalTotalFromItems(items);
    this.setData(patch);
    ui.showSuccess('已采用 AI 建议，可修改后提交');
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
    if (this.data.importBusy || !this.data.isFinalMode) return;
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
            const items = mapImportedRowsToPlanItems(data.items || [], {
              idCounter: idCtr,
              withPartsTypeLock: true,
              existingPartsTypeMap: this.data.existingPartsTypeMap || {}
            });
            nextId = idCtr.v;
            const patch = { items, importBusy: false, amount: computeFinalTotalFromItems(items) };
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
    if (this.data.importBusy || !this.data.isFinalMode) return;
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
          const items = mapImportedRowsToPlanItems(out.items || [], {
            idCounter: idCtr,
            withPartsTypeLock: true,
            existingPartsTypeMap: this.data.existingPartsTypeMap || {}
          });
          nextId = idCtr.v;
          const patch = { items, importBusy: false, amount: computeFinalTotalFromItems(items) };
          if (out.duration != null && !String(this.data.duration || '').trim()) {
            patch.duration = String(out.duration);
          }
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
    if (this.data.submitting) return;
    const { items, valueAdded, amount, duration, existingPartsTypeMap, isFinalMode, isInsurance, lossAssessmentUrls, evidencePhotoUrls, lossSupplementNote } = this.data;
    const validItems = items.filter(it => (it.damage_part || '').trim());
    if (validItems.length === 0) {
      ui.showWarning('请至少添加一个维修项目');
      return;
    }
    const seenVa = new Set();
    const va = [];
    for (const it of valueAdded || []) {
      const n = String(it.name || '').trim();
      if (!n || seenVa.has(n)) continue;
      seenVa.add(n);
      va.push({ name: n });
    }
    const amt = parseFloat(amount);
    const dur = parseInt(duration, 10);
    let sumLine = 0;
    const payload = [];
    for (const it of validItems) {
      const part = (it.damage_part || '').trim();
      const locked = !!existingPartsTypeMap[part];
      const rt = it.repair_type || '修';
      const pr = parseFloat(it.line_price);
      const wm = parseInt(it.line_warranty, 10);
      if (Number.isNaN(wm) || wm < 0) {
        ui.showWarning('每项须填写有效的项目质保（月）');
        return;
      }
      const row = {
        damage_part: part,
        repair_type: rt,
        parts_type: locked ? existingPartsTypeMap[part] : (rt === '换' ? (it.parts_type || null) : null),
        warranty_months: wm
      };
      if (isFinalMode) {
        if (Number.isNaN(pr) || pr < 0) {
          ui.showWarning('修改报价单时每项须填写分项金额（元）');
          return;
        }
        row.price = Math.round(pr * 100) / 100;
        sumLine += row.price;
      } else if (!Number.isNaN(pr) && pr >= 0 && String(it.line_price || '').trim() !== '') {
        row.price = Math.round(pr * 100) / 100;
        sumLine += row.price;
      }
      payload.push(row);
    }
    if (isFinalMode && (Number.isNaN(amt) || amt <= 0)) {
      ui.showWarning('请填写有效总报价');
      return;
    }
    if (isFinalMode && Math.abs(sumLine - amt) > 0.51) {
      ui.showWarning('分项金额合计 ¥' + sumLine.toFixed(2) + ' 与总报价不一致，请核对');
      return;
    }
    if (!isFinalMode && !Number.isNaN(amt) && amt > 0 && sumLine > 0 && Math.abs(sumLine - amt) > 0.51) {
      ui.showWarning('已填分项金额合计与总报价不一致，请核对');
      return;
    }
    if (isFinalMode && isInsurance && (!lossAssessmentUrls || lossAssessmentUrls.length < 1)) {
      ui.showWarning('保险事故车请上传定损单照片');
      return;
    }
    if (isFinalMode && !isInsurance && (!evidencePhotoUrls || evidencePhotoUrls.length < 1)) {
      ui.showWarning('请上传至少 1 张报价证明材料');
      return;
    }
    this.setData({ submitting: true });
    try {
      if (isFinalMode) {
        const body = {
          items: payload,
          value_added_services: va,
          amount: !Number.isNaN(amt) ? amt : undefined,
          duration: !Number.isNaN(dur) && dur > 0 ? dur : undefined
        };
        if (isInsurance) {
          body.loss_assessment_documents = { urls: lossAssessmentUrls || [] };
          if ((lossSupplementNote || '').trim()) {
            body.supplement_note = (lossSupplementNote || '').trim();
          }
        } else {
          body.evidence = { photo_urls: evidencePhotoUrls || [] };
        }
        await submitMerchantFinalQuote(this.data.orderId, body);
        ui.showSuccess('报价已提交，请等待车主确认');
      } else {
        await updateRepairPlan(this.data.orderId, {
          items: payload,
          value_added_services: va,
          amount: !Number.isNaN(amt) ? amt : undefined,
          duration: !Number.isNaN(dur) && dur > 0 ? dur : undefined
        });
        ui.showSuccess('维修方案已更新，请等待车主确认');
      }
      const orderId = this.data.orderId;
      const detailUrl = '/pages/merchant/order/detail/index?id=' + encodeURIComponent(orderId);
      // navigateBack 异步完成前勿将 submitting 置 false，否则会短暂解锁按钮导致重复提交
      const leavePage = () => {
        wx.navigateBack({
          delta: 1,
          fail: () => {
            wx.redirectTo({
              url: detailUrl,
              fail: () => {
                this.setData({ submitting: false });
                ui.showError('无法返回上一页，请从订单列表进入订单详情');
              }
            });
          }
        });
      };
      setTimeout(leavePage, 400);
    } catch (err) {
      logger.error('提交失败', err);
      ui.showError(err.message || '提交失败');
      this.setData({ submitting: false });
    }
  }
});
