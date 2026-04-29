const { mergeHumanDisplayFromAnalysis, filterDamagesByFocus } = require('../../../utils/analysis-human-display');

function normalizeList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => String(x || '').trim()).filter(Boolean);
}

function buildSectionsFromHumanDisplay(hd) {
  const obvious = normalizeList(hd && hd.obvious_damage);
  const possible = normalizeList(hd && hd.possible_damage);
  const advice = normalizeList(hd && hd.repair_advice);
  return [
    { key: 'obvious_damage', title: '明显损伤', items: obvious, emptyText: '暂无明显可见损伤' },
    { key: 'possible_damage', title: '可能损伤', items: possible, emptyText: '暂无待进一步确认项' },
    { key: 'repair_advice', title: '维修建议', items: advice, emptyText: '暂无专项建议' },
  ];
}

function hasAnyItems(sections) {
  return Array.isArray(sections) && sections.some((s) => Array.isArray(s?.items) && s.items.length > 0);
}

function buildSectionsFromDamages(damages) {
  const list = Array.isArray(damages) ? damages : [];
  const lines = list
    .map((d) => {
      const part = String((d && d.part) || '').trim();
      const type = String((d && d.type) || '').trim();
      if (part && type) return `${part}：${type}`;
      return part || type || '';
    })
    .filter(Boolean);
  if (!lines.length) return [];
  return [
    {
      key: 'damages',
      title: '损伤明细',
      items: lines,
      emptyText: '暂无结构化损伤明细',
    },
  ];
}

function pickHighlightFromAnalysis(ar, focusVehicleId) {
  const analysis = ar && typeof ar === 'object' ? ar : {};
  const focus = String(focusVehicleId || '').trim();
  const viArr = Array.isArray(analysis.vehicle_info) ? analysis.vehicle_info : [];
  if (focus && viArr.length) {
    const hit = viArr.find((v) => String(v?.vehicleId || '').trim() === focus);
    if (hit && typeof hit === 'object') {
      return {
        damage_level: hit.damage_level ?? analysis.damage_level ?? '',
        total_estimate: Array.isArray(hit.total_estimate) ? hit.total_estimate : (Array.isArray(analysis.total_estimate) ? analysis.total_estimate : [0, 0]),
        vehicleId: hit.vehicleId || focus,
        plate_number: hit.plate_number || hit.plateNumber || '',
        brand: hit.brand || '',
        model: hit.model || '',
      };
    }
  }
  return {
    damage_level: analysis.damage_level || '',
    total_estimate: Array.isArray(analysis.total_estimate) ? analysis.total_estimate : [0, 0],
    vehicleId: '',
    plate_number: '',
    brand: '',
    model: '',
  };
}

function buildRiskRedFlags(analysis, highlight) {
  const flags = [];
  const level = String(highlight?.damage_level || '').trim();
  const related = analysis && analysis.repair_related;
  if (related === false) {
    flags.push('当前材料可能与维修无关，建议重新上传/补充描述后再试。');
    return flags;
  }
  if (level === '三级' || level === '严重') {
    flags.push('如伴随漏液、转向异常、制动异常或明显异响，请避免继续行驶并尽快到店检查。');
  } else if (level) {
    flags.push('建议尽快到店复检确认最终维修范围与价格，避免遗漏隐蔽损伤。');
  }
  return flags;
}

function buildNextSteps(analysis) {
  const steps = [];
  if (analysis && analysis.repair_related === false) {
    steps.push({ key: 'retry', title: '下一步建议', bullets: ['重新上传清晰车辆/损伤照片', '补充一句话描述（如“低速追尾，前杠凹陷”）'] });
    return steps;
  }
  steps.push({
    key: 'checklist',
    title: '下一步建议',
    bullets: [
      '补拍：四角全景 + 损伤近景 + 带参照物同框（硬币/尺子）',
      '到店前：要求报价明细（工时/配件/喷漆范围）并确认是否可能增项',
      '如走保险：按保险公司指引补齐材料，以实车查勘为准',
    ],
  });
  return steps;
}

function buildCtas(mode) {
  const m = String(mode || 'share');
  if (m === 'share') {
    return [
      { key: 'open_miniapp_analyze', text: '我也要分析（打开小程序）', action: 'open_miniapp', params: { path: '/pages/damage/upload/index' } },
    ];
  }
  return [];
}

/**
 * 统一 report display vm（供 H5/小程序渲染）
 */
function buildDamageReportDisplayVM(opts = {}) {
  const mode = opts.mode || 'share'; // share|miniapp|h5
  const analysis = opts.analysis_result && typeof opts.analysis_result === 'object' ? opts.analysis_result : {};
  const focusVehicleId = String(opts.analysis_focus_vehicle_id || '').trim();

  const hd = opts.human_display && typeof opts.human_display === 'object'
    ? opts.human_display
    : mergeHumanDisplayFromAnalysis(analysis, focusVehicleId);

  let sections = buildSectionsFromHumanDisplay(hd);
  if (!hasAnyItems(sections)) {
    const damages = filterDamagesByFocus(analysis.damages, focusVehicleId);
    sections = buildSectionsFromDamages(damages);
  }

  const highlight = pickHighlightFromAnalysis(analysis, focusVehicleId);
  const disclaimer =
    mode === 'share'
      ? '本摘要仅供参考，不构成保险定损或责任认定；请以实车检测与正规维修厂意见为准。'
      : '本分析结果仅供参考，具体请以实车检测与正规维修厂意见为准。';

  return {
    schema_version: 1,
    mode,
    title: '损失报告（AI）摘要',
    subtitle: '先看风险与下一步，再决定是否到店/比价',
    highlights: {
      damage_level: String(highlight.damage_level || '').trim(),
      total_estimate: Array.isArray(highlight.total_estimate) ? highlight.total_estimate : [0, 0],
      vehicle: {
        vehicleId: highlight.vehicleId || '',
        plate_number: String(highlight.plate_number || '').trim(),
        brand: String(highlight.brand || '').trim(),
        model: String(highlight.model || '').trim(),
      },
    },
    risk_red_flags: buildRiskRedFlags(analysis, highlight),
    next_steps: buildNextSteps(analysis),
    sections,
    disclaimer,
    cta: buildCtas(mode),
  };
}

module.exports = {
  buildDamageReportDisplayVM,
};

