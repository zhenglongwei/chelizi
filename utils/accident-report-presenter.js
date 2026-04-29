const { mergeHumanDisplayFromAnalysis } = require('./analysis-human-display');

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
  if (!Array.isArray(sections)) return false;
  for (const sec of sections) {
    if (sec && Array.isArray(sec.items) && sec.items.length > 0) return true;
  }
  return false;
}

function buildSectionsFromDamages(damages) {
  if (!Array.isArray(damages) || damages.length === 0) return [];
  const lines = damages
    .map((d) => {
      const part = String((d && d.part) || '').trim();
      const type = String((d && d.type) || '').trim();
      if (part && type) return part + '：' + type;
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

/**
 * 统一事故报告展示 ViewModel
 * - 只负责“内容一致性”，按钮/入口由各页面自行控制
 */
function buildAccidentReportViewModel(opts = {}) {
  const mode = opts.mode || 'miniapp';
  const disclaimer =
    mode === 'share'
      ? '本摘要仅供参考，不构成保险定损或责任认定；请以实车检测与正规维修厂意见为准。'
      : '本分析结果仅供参考，具体请以实车检测与正规维修厂意见为准。';

  let hd = opts.human_display;
  if (!hd && opts.analysis_result) {
    const focusId = opts.analysis_focus_vehicle_id || '';
    hd = mergeHumanDisplayFromAnalysis(opts.analysis_result, focusId);
  }
  hd = hd && typeof hd === 'object' ? hd : {};

  let sections = buildSectionsFromHumanDisplay(hd);
  if (!hasAnyItems(sections)) {
    const damages = Array.isArray(opts.damages)
      ? opts.damages
      : (opts.analysis_result && Array.isArray(opts.analysis_result.damages) ? opts.analysis_result.damages : []);
    sections = buildSectionsFromDamages(damages);
  }
  return {
    mode,
    sections,
    disclaimer,
  };
}

module.exports = {
  buildAccidentReportViewModel,
};

