/**
 * 多车定损：按车主选定的 AI 车辆 id（如「车辆2」）合并 human_display / 过滤 damages
 * analysis_focus_vehicle_id 在发起竞价时写入 biddings.vehicle_info 与 damage_reports.vehicle_info
 */

function resolveFocusVehicleEntry(vehicleInfoArr, focusId) {
  const f = String(focusId || '').trim();
  if (!f || !Array.isArray(vehicleInfoArr) || vehicleInfoArr.length === 0) return null;
  const hit = vehicleInfoArr.find((v) => String(v.vehicleId || '').trim() === f);
  if (hit) return hit;
  const m = f.match(/^车辆(\d+)$/);
  if (m) {
    const idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < vehicleInfoArr.length) return vehicleInfoArr[idx];
  }
  return null;
}

/**
 * @param {object} ar - analysis_result
 * @param {string} [focusVehicleId] - analysis_focus_vehicle_id
 */
function mergeHumanDisplayFromAnalysis(ar, focusVehicleId) {
  const empty = { obvious_damage: [], possible_damage: [], repair_advice: [] };
  if (!ar || typeof ar !== 'object') return empty;
  const focus = typeof focusVehicleId === 'string' ? focusVehicleId.trim() : '';
  const vi = Array.isArray(ar.vehicle_info) ? ar.vehicle_info : [];

  if (focus && vi.length > 0) {
    const entry = resolveFocusVehicleEntry(vi, focus);
    if (entry && entry.human_display && typeof entry.human_display === 'object') {
      const h = entry.human_display;
      return {
        obvious_damage: Array.isArray(h.obvious_damage) ? [...h.obvious_damage] : [],
        possible_damage: Array.isArray(h.possible_damage) ? [...h.possible_damage] : [],
        repair_advice: Array.isArray(h.repair_advice) ? [...h.repair_advice] : [],
      };
    }
    // 已写入 focus 但该车无 human_display 时，不回退到多车混排（避免再次出现「车辆1/2」全文）
    return empty;
  }

  if (vi.length === 0) {
    const h = ar.human_display;
    if (h && typeof h === 'object') {
      return {
        obvious_damage: Array.isArray(h.obvious_damage) ? h.obvious_damage : [],
        possible_damage: Array.isArray(h.possible_damage) ? h.possible_damage : [],
        repair_advice: Array.isArray(h.repair_advice) ? h.repair_advice : [],
      };
    }
    return empty;
  }

  const o = [];
  const p = [];
  const r = [];
  const multi = vi.length > 1;
  for (const v of vi) {
    const h = v.human_display;
    if (!h || typeof h !== 'object') continue;
    const vid = (v.vehicleId || '').trim();
    const prefix = multi && vid ? `（${vid}）` : '';
    (h.obvious_damage || []).forEach((t) => o.push(prefix + t));
    (h.possible_damage || []).forEach((t) => p.push(prefix + t));
    (h.repair_advice || []).forEach((t) => r.push(prefix + t));
  }
  return { obvious_damage: o, possible_damage: p, repair_advice: r };
}

/**
 * @param {Array} damages
 * @param {string} [focusVehicleId]
 */
function filterDamagesByFocus(damages, focusVehicleId) {
  const list = Array.isArray(damages) ? damages : [];
  const focus = typeof focusVehicleId === 'string' ? focusVehicleId.trim() : '';
  if (!focus) return list;
  return list.filter((d) => {
    const vid = String(d.vehicleId || '').trim();
    if (vid) return vid === focus;
    return focus === '车辆1' || focus === '';
  });
}

module.exports = {
  mergeHumanDisplayFromAnalysis,
  filterDamagesByFocus,
  resolveFocusVehicleEntry,
};
