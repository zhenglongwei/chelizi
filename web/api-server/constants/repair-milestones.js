/**
 * 维修过程关键节点（稳定 code + 中文展示）
 * 与小程序 utils/repair-milestones.js 保持一致。
 * 新单接受 before_process / during_process / parts_verify_process / after_process；历史库中仍为旧 6 code。
 */
const REPAIR_MILESTONES = [
  {
    code: 'before_process',
    label: '维修前',
    phase: 'before',
    phaseLabel: '维修前',
    hint: '建议包含洗车、验车等相关照片（选填，不做强制校验）。',
  },
  {
    code: 'during_process',
    label: '维修过程',
    phase: 'during',
    phaseLabel: '维修过程',
    hint: '拆装、工序、车间等过程照（选填）。零配件与验真请单独选「零配件验真」节点上传。',
  },
  {
    code: 'parts_verify_process',
    label: '零配件验真',
    phase: 'during',
    phaseLabel: '零配件验真',
    hint: '零配件包装、编号、防伪等照片；验真方式建议填写（选填）。',
  },
  {
    code: 'after_process',
    label: '完工',
    phase: 'after',
    phaseLabel: '完工',
    hint: '完工阶段可含交车整理、修复后外观、结算单/定损单关键页、物料等（选填）。下方「完工材料」在选择本阶段后出现，与「提交并完工」一并写入订单。',
  },
];

const CODE_TO_LABEL = Object.fromEntries(REPAIR_MILESTONES.map((m) => [m.code, m.label]));

/** 旧版 6 节点（仅展示与进度推导，不可再作为新写入的合法 code） */
const LEGACY_CODE_TO_LABEL = {
  pre_clean_inspect: '拆车前清洗/验车',
  hidden_damage: '拆检发现额外问题',
  parts_off: '配件拆卸后',
  parts_on: '配件安装后',
  mid_qc: '过程质检',
  pre_delivery_clean: '交车前清洁',
};

function isValidMilestoneCode(code) {
  return typeof code === 'string' && CODE_TO_LABEL[code] != null;
}

function getMilestoneLabel(code) {
  if (!code) return '';
  const c = String(code);
  if (CODE_TO_LABEL[c]) return CODE_TO_LABEL[c];
  return LEGACY_CODE_TO_LABEL[c] || c;
}

function listMilestoneDefinitions() {
  return REPAIR_MILESTONES.map((m) => ({ ...m }));
}

module.exports = {
  REPAIR_MILESTONES,
  CODE_TO_LABEL,
  LEGACY_CODE_TO_LABEL,
  isValidMilestoneCode,
  getMilestoneLabel,
  listMilestoneDefinitions,
};
