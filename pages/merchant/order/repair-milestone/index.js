// 维修过程留痕（维修前 / 维修过程 / 零配件验真 / 完工）；完工材料与 completion_evidence 心智统一（文字引导，不强制）
const { getLogger } = require('../../../../utils/logger');
const ui = require('../../../../utils/ui');
const {
  getMerchantToken,
  getMerchantOrder,
  merchantUploadImage,
  postMerchantRepairMilestone,
  updateOrderStatus,
} = require('../../../../utils/api');
const { getNavBarHeight } = require('../../../../utils/util');
const { REPAIR_MILESTONES, MILESTONE_PICKER_LABELS, getMilestoneHintByCode } = require('../../../../utils/repair-milestones');
const { requestMerchantSubscribe } = require('../../../../utils/subscribe');
const { computeRepairPhaseProgress } = require('../../../../utils/repair-phase-progress');

const logger = getLogger('MerchantRepairMilestone');

const MAX_PHOTOS_PER_MILESTONE = 12;
const MAX_PARTS_VERIFY_PHOTOS = 8;
const MAX_NOTE_PER_ROW = 120;
const MAX_PARTS_VERIFY = 120;
const MAX_ENTRIES = 12;

let entrySeq = 0;
function makeEntryId() {
  entrySeq += 1;
  return 'e' + Date.now() + '_' + entrySeq;
}

function makePhotoKey() {
  return 'p' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
}

function hasAfterProcessMilestone(serverRows, entries) {
  for (const m of serverRows || []) {
    if (m && String(m.milestone_code) === 'after_process') return true;
  }
  for (const r of entries || []) {
    if (r && r.code === 'after_process') return true;
  }
  return false;
}

/** 已添加或已提交「完工」过程留痕时，展示「完工材料」区（定损/结算单等） */
function shouldShowCompletionMaterials(serverRows, entries) {
  return hasAfterProcessMilestone(serverRows, entries);
}

function mergedMilestonesForProgress(serverRows, entries) {
  const list = [];
  for (const row of serverRows || []) {
    if (row && row.milestone_code) {
      list.push({
        milestone_code: row.milestone_code,
        photo_urls: row.photo_urls,
        parts_photo_urls: row.parts_photo_urls,
      });
    }
  }
  for (const e of entries || []) {
    if (!e || !e.code) continue;
    const urls = (e.photos || []).map((p) => p && p.remote).filter(Boolean);
    if (urls.length) list.push({ milestone_code: e.code, photo_urls: urls });
  }
  return list;
}

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    orderId: '',
    entries: [],
    submitting: false,
    completing: false,
    serverRepairMilestones: [],
    materialAuditing: false,
    completeDisabled: false,
    completeBtnText: '维修完成',
    repairPhotos: [],
    repairPhotoUrls: [],
    settlementPhotos: [],
    settlementPhotoUrls: [],
    materialPhotos: [],
    materialPhotoUrls: [],
    repairPhaseBeforeDone: false,
    repairPhaseDuringDone: false,
    repairPhaseAfterDone: false,
    showAfterStageMaterials: false,
    /** 主按钮：无完工意图时为「提交过程记录」，否则「提交并完工」 */
    primarySubmitLabel: '提交过程记录',
  },

  _firstShow: true,

  onLoad(options) {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    const id = (options.id || '').trim();
    if (!id) {
      ui.showError('订单ID无效');
      return;
    }
    if (!getMerchantToken()) {
      wx.redirectTo({
        url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/order/repair-milestone/index?id=' + id),
      });
      return;
    }
    this.setData({ orderId: id, entries: [] });
    this.loadOrderFlags();
  },

  onShow() {
    if (!this.data.orderId || !getMerchantToken()) return;
    if (this._firstShow) {
      this._firstShow = false;
    }
    // 不在 onShow 自动拉单：选图/切后台会频繁触发 onShow，与上传并发时易误判订单状态或 401，导致 navigateBack / 重登、草稿丢失。
    // 进入页时 onLoad 已拉单；提交进展成功后 submitPendingMilestones 会再次 loadOrderFlags。
  },

  async loadOrderFlags() {
    try {
      const res = await getMerchantOrder(this.data.orderId);
      const rawSt = res && res.status;
      const orderStatus = rawSt == null || rawSt === '' ? NaN : Number(rawSt);
      if (!Number.isFinite(orderStatus)) {
        logger.error('订单详情缺少有效 status', res);
        ui.showError('订单数据异常，请返回重试');
        return;
      }
      if (orderStatus !== 1) {
        ui.showWarning('订单不在维修中');
        wx.navigateBack();
        return;
      }
      const materialAuditPendingAi = res.material_audit_status === 'pending';
      const materialAuditManualReview = res.material_audit_status === 'manual_review';
      const materialAuditBusyHint = materialAuditPendingAi || materialAuditManualReview;
      const hasPreQuote = !!res.pre_quote_snapshot;
      const fqsRaw = res.final_quote_status != null ? parseInt(res.final_quote_status, 10) : 0;
      const fqs = Number.isNaN(fqsRaw) ? 0 : fqsRaw;
      const finalQuotePending = hasPreQuote && fqs === 1;
      const planPendingConfirm = res.repair_plan_status === 1;
      const completeDisabled = planPendingConfirm || finalQuotePending;
      let completeBtnText = '维修完成';
      if (planPendingConfirm) completeBtnText = '请等待车主确认维修方案';
      else if (finalQuotePending) completeBtnText = '请等待车主确认报价';

      const serverRepairMilestones = res.repair_milestones || [];
      const showAfterStageMaterials = shouldShowCompletionMaterials(serverRepairMilestones, this.data.entries);
      this.setData({
        serverRepairMilestones,
        materialAuditing: materialAuditBusyHint,
        completeDisabled,
        completeBtnText,
        showAfterStageMaterials,
      });
      this._syncRepairPhaseProgress(serverRepairMilestones);
    } catch (err) {
      logger.error('加载订单失败', err);
      ui.showError(err.message || '加载失败');
    }
  },

  _syncRepairPhaseProgress(serverRowsOverride) {
    const srv = serverRowsOverride != null ? serverRowsOverride : this.data.serverRepairMilestones;
    const merged = mergedMilestonesForProgress(srv, this.data.entries);
    const p = computeRepairPhaseProgress({
      orderStatus: 1,
      repair_milestones: merged,
      repairPhotoUrls: this.data.repairPhotoUrls,
      settlementPhotoUrls: this.data.settlementPhotoUrls,
      materialPhotoUrls: this.data.materialPhotoUrls,
    });
    const showAfterStageMaterials = shouldShowCompletionMaterials(srv, this.data.entries);
    this.setData({
      repairPhaseBeforeDone: p.beforeDone,
      repairPhaseDuringDone: p.duringDone,
      repairPhaseAfterDone: p.afterDone,
      primarySubmitLabel: this._computePrimarySubmitLabel(srv),
      showAfterStageMaterials,
    });
  },

  _computePrimarySubmitLabel(serverRows) {
    if (this.data.completeDisabled) return '提交过程记录';
    const rows = serverRows != null ? serverRows : this.data.serverRepairMilestones;
    const hasDraftAfterPhotos = (this.data.entries || []).some(
      (r) => r && r.code === 'after_process' && r.photos && r.photos.length > 0
    );
    const serverHasAfter = (rows || []).some((m) => m && String(m.milestone_code) === 'after_process');
    if (hasDraftAfterPhotos || serverHasAfter) return '提交并完工';
    return '提交过程记录';
  },

  onTapAddMilestoneSheet() {
    if (this.data.entries.length >= MAX_ENTRIES) {
      ui.showWarning('本页最多添加 ' + MAX_ENTRIES + ' 条，可先提交后再来补充');
      return;
    }
    wx.showActionSheet({
      itemList: MILESTONE_PICKER_LABELS,
      success: (res) => {
        const idx = res.tapIndex;
        if (idx < 0 || idx >= REPAIR_MILESTONES.length) return;
        const m = REPAIR_MILESTONES[idx];
        const hint = getMilestoneHintByCode(m.code) || '';
        this.setData({
          entries: [
            ...this.data.entries,
            {
              entryId: makeEntryId(),
              code: m.code,
              label: m.label,
              phaseLabel: m.phaseLabel,
              hint,
              photos: [],
              partsVerifyNote: '',
              note: '',
            },
          ],
        });
        this._syncRepairPhaseProgress();
      },
    });
  },

  onRemoveEntry(e) {
    const id = (e.currentTarget.dataset.entryId || '').trim();
    if (!id) return;
    this.setData({
      entries: this.data.entries.filter((x) => x.entryId !== id),
    });
    this._syncRepairPhaseProgress();
  },

  onRowNoteInput(e) {
    const entryId = (e.currentTarget.dataset.entryId || '').trim();
    if (!entryId) return;
    const v = (e.detail.value || '').slice(0, MAX_NOTE_PER_ROW);
    this.setData({
      entries: this.data.entries.map((r) => (r.entryId === entryId ? { ...r, note: v } : r)),
    });
  },

  onDelPhoto(e) {
    const entryId = (e.currentTarget.dataset.entryId || '').trim();
    const idx = parseInt(e.currentTarget.dataset.index, 10);
    if (!entryId || Number.isNaN(idx)) return;
    this.setData({
      entries: this.data.entries.map((r) => {
        if (r.entryId !== entryId) return r;
        const photos = [...(r.photos || [])];
        photos.splice(idx, 1);
        return { ...r, photos };
      }),
    });
    this._syncRepairPhaseProgress();
  },

  onPartsVerifyInput(e) {
    const entryId = (e.currentTarget.dataset.entryId || '').trim();
    if (!entryId) return;
    const row = this.data.entries.find((r) => r.entryId === entryId);
    if (!row || row.code !== 'parts_verify_process') return;
    const v = (e.detail.value || '').slice(0, MAX_PARTS_VERIFY);
    this.setData({
      entries: this.data.entries.map((r) => (r.entryId === entryId ? { ...r, partsVerifyNote: v } : r)),
    });
  },

  onAddPhotos(e) {
    const entryId = (e.currentTarget.dataset.entryId || '').trim();
    if (!entryId) return;
    const row = this.data.entries.find((r) => r.entryId === entryId);
    if (!row) return;
    const max = row.code === 'parts_verify_process' ? MAX_PARTS_VERIFY_PHOTOS : MAX_PHOTOS_PER_MILESTONE;
    const remain = max - (row.photos || []).length;
    if (remain <= 0) return;
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: async (res) => {
        const files = (res.tempFiles || []).slice(0, remain);
        for (const f of files) {
          const cur = this.data.entries.find((r) => r.entryId === entryId);
          const cap = cur && cur.code === 'parts_verify_process' ? MAX_PARTS_VERIFY_PHOTOS : MAX_PHOTOS_PER_MILESTONE;
          if (!cur || (cur.photos || []).length >= cap) break;
          const photoKey = makePhotoKey();
          const localPath = f.tempFilePath;
          this.setData({
            entries: this.data.entries.map((r) => {
              if (r.entryId !== entryId) return r;
              const photos = [...(r.photos || []), { photoKey, remote: '', local: localPath }];
              return { ...r, photos };
            }),
          });
          this._syncRepairPhaseProgress();
          try {
            const url = await merchantUploadImage(localPath);
            this.setData({
              entries: this.data.entries.map((r) => {
                if (r.entryId !== entryId) return r;
                const photos = (r.photos || []).map((p) => (p.photoKey === photoKey ? { ...p, remote: url, local: localPath } : p));
                return { ...r, photos };
              }),
            });
            this._syncRepairPhaseProgress();
          } catch (err) {
            logger.error('上传失败', err);
            this.setData({
              entries: this.data.entries.map((r) => {
                if (r.entryId !== entryId) return r;
                return { ...r, photos: (r.photos || []).filter((p) => p.photoKey !== photoKey) };
              }),
            });
            this._syncRepairPhaseProgress();
            ui.showError(err && err.message ? err.message : '上传失败');
          }
        }
      },
    });
  },

  onChooseRepairPhoto() {
    this._chooseAndUpload('repair', 6 - this.data.repairPhotoUrls.length);
  },
  onChooseSettlementPhoto() {
    this._chooseAndUpload('settlement', 4 - this.data.settlementPhotoUrls.length);
  },
  onChooseMaterialPhoto() {
    this._chooseAndUpload('material', 4 - this.data.materialPhotoUrls.length);
  },

  async _chooseAndUpload(type, count) {
    if (count <= 0) return;
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: async (res) => {
        const files = (res.tempFiles || []).slice(0, count);
        const keyUrls =
          type === 'repair'
            ? 'repairPhotoUrls'
            : type === 'settlement'
              ? 'settlementPhotoUrls'
              : 'materialPhotoUrls';
        const keyPhotos =
          type === 'repair'
            ? 'repairPhotos'
            : type === 'settlement'
              ? 'settlementPhotos'
              : 'materialPhotos';
        for (const f of files) {
          try {
            const url = await merchantUploadImage(f.tempFilePath);
            const urls = [...(this.data[keyUrls] || []), url];
            const imgs = [...(this.data[keyPhotos] || []), f.tempFilePath];
            this.setData({ [keyUrls]: urls, [keyPhotos]: imgs });
            this._syncRepairPhaseProgress();
          } catch (e) {
            logger.error('上传失败', e);
            ui.showError(e && e.message ? e.message : '上传失败');
          }
        }
      },
    });
  },

  onDelEvidencePhoto(e) {
    const { type, index } = e.currentTarget.dataset;
    const keyUrls =
      type === 'repair'
        ? 'repairPhotoUrls'
        : type === 'settlement'
          ? 'settlementPhotoUrls'
          : 'materialPhotoUrls';
    const keyPhotos =
      type === 'repair'
        ? 'repairPhotos'
        : type === 'settlement'
          ? 'settlementPhotos'
          : 'materialPhotos';
    const urls = [...(this.data[keyUrls] || [])];
    const imgs = [...(this.data[keyPhotos] || [])];
    urls.splice(index, 1);
    imgs.splice(index, 1);
    this.setData({ [keyUrls]: urls, [keyPhotos]: imgs });
    this._syncRepairPhaseProgress();
  },

  /**
   * @returns {Promise<{ ok: number, failLabels: string[], hadRows: boolean, hadAfterProcessInBatch: boolean }>}
   */
  async submitPendingMilestones() {
    const { orderId, entries } = this.data;
    const toSubmit = entries.filter((r) => (r.photos || []).some((p) => p && p.remote));
    if (toSubmit.length < 1) {
      return { ok: 0, failLabels: [], hadRows: false, hadAfterProcessInBatch: false };
    }
    let ok = 0;
    let hadAfterProcessInBatch = false;
    const failLabels = [];
    for (const r of toSubmit) {
      try {
        const payload = {
          milestone_code: r.code,
          photo_urls: (r.photos || []).map((p) => p && p.remote).filter(Boolean),
          note: (r.note || '').trim(),
        };
        if (r.code === 'parts_verify_process' && (r.partsVerifyNote || '').trim()) {
          payload.parts_verify_note = (r.partsVerifyNote || '').trim();
        }
        await postMerchantRepairMilestone(orderId, payload);
        ok += 1;
        if (r.code === 'after_process') hadAfterProcessInBatch = true;
      } catch (err) {
        logger.error('提交节点失败', r.code, err);
        failLabels.push(r.label);
      }
    }
    if (failLabels.length === 0) {
      this.setData({ entries: [] });
      await this.loadOrderFlags();
    }
    return { ok, failLabels, hadRows: true, hadAfterProcessInBatch };
  },

  async onSubmitAndFinish() {
    if (this.data.submitting || this.data.completing) return;
    const { completeDisabled, repairPhotoUrls, settlementPhotoUrls, materialPhotoUrls, orderId } = this.data;

    const evCount =
      (repairPhotoUrls || []).length + (settlementPhotoUrls || []).length + (materialPhotoUrls || []).length;

    this.setData({ submitting: true });
    let sub = { ok: 0, failLabels: [], hadRows: false, hadAfterProcessInBatch: false };
    try {
      sub = await this.submitPendingMilestones();
    } catch (e) {
      logger.error('submitPendingMilestones', e);
    }
    this.setData({ submitting: false });

    if (sub.failLabels && sub.failLabels.length > 0) {
      if (sub.ok > 0) {
        ui.showError(`已成功 ${sub.ok} 条；「${sub.failLabels.join('、')}」未提交成功，请检查网络后补传`);
      } else {
        ui.showError(sub.failLabels.length ? '提交失败，请稍后重试' : '提交失败');
      }
      return;
    }

    if (completeDisabled) {
      if (!sub.hadRows) {
        ui.showWarning('请先添加环节并上传过程/零配件照片，或待车主确认方案/报价后再完工');
      } else {
        ui.showWarning(
          (sub.ok > 1 ? `已提交 ${sub.ok} 条进展并通知车主。` : '已通知车主。') +
            '请待车主确认维修方案或确认报价后再申请待验收'
        );
      }
      return;
    }

    const serverHasAfter = hasAfterProcessMilestone(this.data.serverRepairMilestones, []);
    const allowCompletionModal = sub.hadAfterProcessInBatch || (!sub.hadRows && serverHasAfter);

    if (!allowCompletionModal) {
      if (sub.hadRows && !sub.hadAfterProcessInBatch) {
        ui.showSuccess('已提交并通知车主；完工节点留痕提交后再在此页确认待验收');
      } else if (!sub.hadRows && !serverHasAfter && evCount > 0) {
        ui.showWarning('请先在「完工」节点提交至少一条过程留痕后，再确认进入待验收');
      } else if (!sub.hadRows && !serverHasAfter) {
        ui.showWarning('请先添加并上传过程照片，或在「完工」节点提交后再申请待验收');
      }
      return;
    }

    if (sub.hadRows) {
      ui.showSuccess(sub.ok > 1 ? `已提交 ${sub.ok} 条进展并通知车主` : '已通知车主');
    }

    const modalContent =
      evCount > 0
        ? '确认进入待验收？已含完工凭证类照片时，后台将异步进行材料质检（含千问等），不阻塞订单状态。'
        : '确认进入待验收？未上传完工凭证照片时不触发自动材料质检，仍可提交。';

    wx.showModal({
      title: '确认完工',
      content: modalContent,
      success: async (res) => {
        if (!res.confirm) return;
        requestMerchantSubscribe('material_audit');
        this.setData({ completing: true });
        try {
          const ev = {
            repair_photos: repairPhotoUrls || [],
            settlement_photos: settlementPhotoUrls || [],
            material_photos: materialPhotoUrls || [],
          };
          await updateOrderStatus(orderId, {
            status: 2,
            completion_evidence: ev,
          });
          ui.showSuccess('已提交待验收；材料质检在后台进行');
          wx.navigateBack();
        } catch (err) {
          logger.error('更新状态失败', err);
          ui.showError(err.message || '更新失败');
        }
        this.setData({ completing: false });
      },
    });
  },
});
