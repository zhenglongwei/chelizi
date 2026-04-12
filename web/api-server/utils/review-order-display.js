/**
 * 评价列表展示：从订单冗余字段解析维修项目、配件承诺、新配件留档图
 */

function parseCompletionEvidence(ev) {
  try {
    const ce = typeof ev === 'string' ? JSON.parse(ev || '{}') : (ev || {});
    const materialPhotos = Array.isArray(ce.material_photos)
      ? ce.material_photos.filter((u) => u && String(u).trim())
      : [];
    return { material_photos: materialPhotos };
  } catch (_) {
    return { material_photos: [] };
  }
}

/**
 * @param {string|object|null} repairPlanStrOrObj
 * @param {string|null} repairProjectKey
 * @param {{ stripLinePrices?: boolean }} [options] stripLinePrices 为 true 时配件承诺行不含分项价（公示列表）
 * @returns {{ repairItems: string[], part_promise_lines: string[] }}
 */
function parseRepairPlanEnrichment(repairPlanStrOrObj, repairProjectKey, options = {}) {
  const stripLinePrices = !!options.stripLinePrices;
  let repairItems = [];
  let partPromiseLines = [];
  try {
    const rp = typeof repairPlanStrOrObj === 'string'
      ? JSON.parse(repairPlanStrOrObj || '{}')
      : (repairPlanStrOrObj || {});
    const items = rp?.items || [];
    repairItems = items.map((i) => i.name || i.damage_part || '').filter(Boolean);
    partPromiseLines = items
      .map((it) => {
        const part = it.damage_part || it.name || '';
        if (!part) return '';
        const rt = it.repair_type || '维修';
        const pt = it.repair_type === '换' && it.parts_type ? ' · ' + String(it.parts_type).trim() : '';
        const pr =
          !stripLinePrices && it.price != null && !Number.isNaN(parseFloat(it.price))
            ? ` · ¥${it.price}`
            : '';
        const wm = it.warranty_months != null && !Number.isNaN(parseInt(it.warranty_months, 10))
          ? ` · 质保${it.warranty_months}月`
          : '';
        return `${part}：${rt}${pt}${pr}${wm}`;
      })
      .filter(Boolean);
  } catch (_) {}
  if (!repairItems.length && repairProjectKey) {
    repairItems = String(repairProjectKey)
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return { repairItems, part_promise_lines: partPromiseLines };
}

module.exports = {
  parseCompletionEvidence,
  parseRepairPlanEnrichment,
};
