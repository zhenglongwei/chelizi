/**
 * 维修三格进度条：维修前 / 维修过程 / 完工（与过程留痕、完工凭证均为引导，不做前端强制）
 *
 * 判定：各阶段在「过程留痕」中有至少 1 张对应节点照片即点亮该段（中间「维修过程」格含 during 与零配件验真两类 milestone）；完工段另认「修复后+结算单」各至少 1 张的完工材料上传。
 * 历史订单仍为旧 milestone_code，按阶段映射参与判定。
 */
const MILESTONE_CODE_PHASE = {
  before_process: 'before',
  during_process: 'during',
  parts_verify_process: 'during',
  after_process: 'after',
  pre_clean_inspect: 'before',
  hidden_damage: 'during',
  parts_off: 'during',
  parts_on: 'during',
  mid_qc: 'during',
  pre_delivery_clean: 'after',
};

function codeToPhase(code) {
  return MILESTONE_CODE_PHASE[String(code)] || null;
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * @param {Array<{ milestone_code?: string, code?: string, photo_urls?: string[] }>} rows
 * @param {'before'|'during'|'after'} phase
 */
function milestoneRowPhotoCount(row) {
  const main = Array.isArray(row.photo_urls) ? row.photo_urls.length : 0;
  const parts = Array.isArray(row.parts_photo_urls) ? row.parts_photo_urls.length : 0;
  return main + parts;
}

function milestoneRowsHavePhaseWithPhotos(rows, phase) {
  for (const row of rows || []) {
    const code =
      row && (row.milestone_code != null ? String(row.milestone_code) : row.code != null ? String(row.code) : '');
    if (!code) continue;
    if (milestoneRowPhotoCount(row) < 1) continue;
    if (codeToPhase(code) === phase) return true;
  }
  return false;
}

/** 完工材料：修复后 + 结算单各至少 1 张时，视为完工段进度已满足（与旧「修末」条对齐） */
function completionSuggestsAfterPhase(params) {
  const repair = arr(params.repairPhotoUrls);
  const settlement = arr(params.settlementPhotoUrls);
  return repair.length >= 1 && settlement.length >= 1;
}

function parseCompletionEvidence(raw) {
  if (raw == null || raw === '') {
    return { repair_photos: [], settlement_photos: [], material_photos: [] };
  }
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
    return {
      repair_photos: Array.isArray(o.repair_photos) ? o.repair_photos : [],
      settlement_photos: Array.isArray(o.settlement_photos) ? o.settlement_photos : [],
      material_photos: Array.isArray(o.material_photos) ? o.material_photos : [],
    };
  } catch (_) {
    return { repair_photos: [], settlement_photos: [], material_photos: [] };
  }
}

/** 车主端：从订单 completion_evidence 解析照片 URL（status=1 时多为空） */
function ownerRepairCompletionDraft(order) {
  let raw = null;
  if (order && order.completion_evidence) {
    try {
      raw = typeof order.completion_evidence === 'string' ? JSON.parse(order.completion_evidence || '{}') : order.completion_evidence;
    } catch (_) {
      raw = null;
    }
  }
  const ev = raw
    ? {
        repair_photos: Array.isArray(raw.repair_photos) ? raw.repair_photos : [],
        settlement_photos: Array.isArray(raw.settlement_photos) ? raw.settlement_photos : [],
        material_photos: Array.isArray(raw.material_photos) ? raw.material_photos : [],
      }
    : { repair_photos: [], settlement_photos: [], material_photos: [] };
  return {
    repairPhotoUrls: ev.repair_photos,
    settlementPhotoUrls: ev.settlement_photos,
    materialPhotoUrls: ev.material_photos,
  };
}

function computeOwnerRepairPhaseProgress(order) {
  const draft = ownerRepairCompletionDraft(order || {});
  return computeRepairPhaseProgress({
    orderStatus: order && order.status,
    repair_milestones: (order && order.repair_milestones) || [],
    repairPhotoUrls: draft.repairPhotoUrls,
    settlementPhotoUrls: draft.settlementPhotoUrls,
    materialPhotoUrls: draft.materialPhotoUrls,
  });
}

/**
 * @param {object} opts
 * @param {number} opts.orderStatus
 * @param {Array} opts.repair_milestones 含 milestone_code、photo_urls（车主接口 / 合并后的本地行）
 * @param {object} [opts.completionEvidence]
 * @param {string[]} [opts.repairPhotoUrls] 商户本地（非空优先于 completionEvidence）
 */
function computeRepairPhaseProgress(opts) {
  const orderStatus = opts.orderStatus != null ? parseInt(opts.orderStatus, 10) : 0;
  if (Number.isNaN(orderStatus)) {
    return { beforeDone: false, duringDone: false, afterDone: false };
  }
  if (orderStatus >= 2) {
    return { beforeDone: true, duringDone: true, afterDone: true };
  }

  const rows = opts.repair_milestones || [];
  const beforeDone = milestoneRowsHavePhaseWithPhotos(rows, 'before');
  const duringDone = milestoneRowsHavePhaseWithPhotos(rows, 'during');

  const ev = opts.completionEvidence || {};
  const repairPhotoUrls =
    opts.repairPhotoUrls != null && opts.repairPhotoUrls.length ? opts.repairPhotoUrls : ev.repair_photos || [];
  const settlementPhotoUrls =
    opts.settlementPhotoUrls != null && opts.settlementPhotoUrls.length
      ? opts.settlementPhotoUrls
      : ev.settlement_photos || [];
  const materialPhotoUrls =
    opts.materialPhotoUrls != null && opts.materialPhotoUrls.length ? opts.materialPhotoUrls : ev.material_photos || [];

  const afterDone =
    milestoneRowsHavePhaseWithPhotos(rows, 'after') ||
    completionSuggestsAfterPhase({
      repairPhotoUrls,
      settlementPhotoUrls,
      materialPhotoUrls,
    });

  return { beforeDone, duringDone, afterDone };
}

module.exports = {
  computeRepairPhaseProgress,
  computeOwnerRepairPhaseProgress,
  ownerRepairCompletionDraft,
  parseCompletionEvidence,
  milestoneRowsHavePhaseWithPhotos,
  codeToPhase,
};
