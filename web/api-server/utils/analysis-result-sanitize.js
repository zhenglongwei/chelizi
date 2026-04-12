/**
 * 定损 analysis_result 结构化清洗（服务端）
 *
 * 问题背景：模型可能在 vehicles 数组中多次输出同一 vehicleId（同一辆车拆成多条），
 * 扁平化 damages 时会拼接多份相同损伤；此前用「全局 part+type 去重」会误伤多车场景。
 *
 * 策略：
 * - 按 vehicleId 合并 vehicles 条目，合并 damages 后仅在「同一辆车内」按 part+type 去重；
 * - repair_suggestions 仅去掉完全相同的 item 文案（与是否多车无关）。
 * - 读库/出 API 时再跑一遍 sanitize，修复历史脏数据。
 */

function damagePartTypeKey(d) {
  const part = String(d.part || '')
    .trim()
    .replace(/\s+/g, ' ');
  const typ = String(d.type || '')
    .trim()
    .replace(/\s+/g, ' ');
  return `${part}\n${typ}`;
}

/** 仅在一辆车（或一批同属同一车的 damages 列表）内去重，保留首次出现顺序 */
function dedupeDamagesWithinList(list) {
  if (!Array.isArray(list) || list.length === 0) return list || [];
  const seen = new Set();
  const out = [];
  for (const d of list) {
    const key = damagePartTypeKey(d);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/** 完全相同的 item 只保留一条 */
function dedupeRepairSuggestionsByItem(list) {
  if (!Array.isArray(list) || list.length === 0) return list || [];
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const item = String(r.item || '')
      .trim()
      .replace(/\s+/g, ' ');
    if (!item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push({ ...r, item });
  }
  return out;
}

/**
 * 合并 vehicles 数组中相同 vehicleId 的条目（拼接 damages 并去重，合并 damagedParts 等）
 * @param {object[]} vehicles
 * @returns {object[]}
 */
function mergeDuplicateVehiclesInArray(vehicles) {
  if (!Array.isArray(vehicles) || vehicles.length === 0) return [];
  const map = new Map();
  const order = [];
  for (let idx = 0; idx < vehicles.length; idx++) {
    const v = vehicles[idx] || {};
    const vid = String(v.vehicleId || `车辆${idx + 1}`).trim() || `车辆${idx + 1}`;
    const raw = Array.isArray(v.damages) ? v.damages : [];
    if (!map.has(vid)) {
      order.push(vid);
      map.set(vid, {
        ...v,
        vehicleId: vid,
        damages: dedupeDamagesWithinList(raw)
      });
    } else {
      const ex = map.get(vid);
      ex.damages = dedupeDamagesWithinList([...ex.damages, ...raw]);
      const dp = [...new Set([...(ex.damagedParts || []), ...(v.damagedParts || [])])];
      ex.damagedParts = dp;
      const dt = [...new Set([...(ex.damageTypes || []), ...(v.damageTypes || [])])];
      ex.damageTypes = dt;
      if (!ex.damageSummary && v.damageSummary) ex.damageSummary = v.damageSummary;
      if (v.plateNumber && !ex.plateNumber) ex.plateNumber = v.plateNumber;
      if (v.plate_number && !ex.plate_number) ex.plate_number = v.plate_number;
      if (v.brand && !ex.brand) ex.brand = v.brand;
      if (v.model && !ex.model) ex.model = v.model;
    }
  }
  return order.map((id) => map.get(id));
}

/**
 * 对已定型的 analysis_result 做读时清洗：按 vehicle_info 顺序输出 damages，每车内部去重
 * @param {object} ar
 * @returns {object}
 */
function sanitizeAnalysisResultForRead(ar) {
  if (!ar || typeof ar !== 'object') return ar;
  const damagesIn = Array.isArray(ar.damages) ? ar.damages : [];
  const vi = Array.isArray(ar.vehicle_info) ? ar.vehicle_info : [];
  const orderIds =
    vi.length > 0 ? vi.map((v, i) => String(v.vehicleId || `车辆${i + 1}`).trim()) : ['车辆1'];

  const byVid = new Map();
  for (const id of orderIds) {
    if (!byVid.has(id)) byVid.set(id, []);
  }
  for (const d of damagesIn) {
    const id = String(d.vehicleId || '车辆1').trim();
    if (!byVid.has(id)) byVid.set(id, []);
    byVid.get(id).push(d);
  }

  const flat = [];
  for (const id of orderIds) {
    const list = byVid.get(id);
    if (list && list.length) {
      flat.push(...dedupeDamagesWithinList(list));
      byVid.delete(id);
    }
  }
  for (const [, list] of byVid) {
    if (list.length) flat.push(...dedupeDamagesWithinList(list));
  }

  const repair_suggestions = dedupeRepairSuggestionsByItem(ar.repair_suggestions || []);
  return { ...ar, damages: flat, repair_suggestions };
}

module.exports = {
  dedupeDamagesWithinList,
  dedupeRepairSuggestionsByItem,
  mergeDuplicateVehiclesInArray,
  sanitizeAnalysisResultForRead
};
