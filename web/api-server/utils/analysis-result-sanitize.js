/**
 * 定损 analysis_result 结构化清洗（服务端）
 *
 * 问题背景：模型可能在 vehicles 数组中多次输出同一 vehicleId（同一辆车拆成多条），
 * 扁平化 damages 时会拼接多份相同损伤；此前用「全局 part+type 去重」会误伤多车场景。
 *
 * 策略：
 * - 按 vehicleId 合并 vehicles 条目，合并 damages 后仅在「同一辆车内」按 part+type 去重；
 * - repair_suggestions：规范化 vehicle_id、damage_part、repair_method，同一车同一部位修/换并存时保留「换」；
 *   无法识别为部位分项的长句（fallback 等）原样保留；最后仍按 item 去重。
 * - 读库/出 API 时再跑一遍 sanitize，修复历史脏数据。
 */

const { extractDamagePartFromAiSuggestionItem } = require('./extract-ai-damage-part');

function stripVehiclePrefixFromText(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  // 常见前缀：(车辆1) / （车辆1） / 车辆1- / 车辆1：
  return t
    .replace(/^[（(]\s*车辆\s*\d+\s*[)）]\s*/i, '')
    .replace(/^车辆\s*\d+\s*[-：]\s*/i, '')
    .trim();
}

function normalizeGuidance(g) {
  if (!g || typeof g !== 'object') return null;
  const scriptRaw = typeof g.communication_script === 'string' ? g.communication_script.trim() : '';
  // 读时兜底裁剪到 50-200（AI 端也会被 prompt 约束；这里保证历史/异常数据不炸 UI）
  let script = scriptRaw.replace(/车辆\s*\d+|车\s*\d+/g, '').trim();
  if (script.length > 200) script = script.slice(0, 200).trim();
  if (script.length > 0 && script.length < 50) {
    // 太短也保留（避免把有效话术清空），UI 端可提示“偏短”
  }
  const notesIn = Array.isArray(g.arrival_notes) ? g.arrival_notes : [];
  const notes = notesIn.map(stripVehiclePrefixFromText).filter(Boolean);
  return {
    communication_script: script || undefined,
    arrival_notes: notes,
  };
}

function sanitizeHumanDisplay(hd) {
  if (!hd || typeof hd !== 'object') return hd;
  const out = { ...hd };
  for (const k of ['obvious_damage', 'possible_damage', 'repair_advice']) {
    const arr = Array.isArray(out[k]) ? out[k] : [];
    out[k] = arr.map(stripVehiclePrefixFromText).filter(Boolean);
  }
  return out;
}

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

/** 非「部位+修/换」类泛化建议（fallback 注入等），不做部位合并以免破坏文案 */
function isAmbientRepairSuggestionRow(rawItem, tailNoVid) {
  const t = String(tailNoVid || rawItem || '').trim();
  if (t.length > 48) return true;
  return /补充说明|待查|逐项实车|系统诊断|照片不可见|功能验证|线束与电控/.test(t);
}

/**
 * 将 repair_suggestions 规范为：vehicle_id、damage_part（仅部位名）、repair_method（换|修）、item=车辆N-部位名；
 * 同一 vehicle_id + damage_part 同时出现修与换时保留换；与 damages / 知识库一致。
 * @param {object[]} list
 * @returns {object[]}
 */
function normalizeRepairSuggestionsStructured(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const prelim = [];
  const passthrough = [];

  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const rawItem = String(r.item || '').trim();
    let vid = String(r.vehicle_id || r.vehicleId || '').trim();
    if (!vid && rawItem) {
      const m = rawItem.match(/^(车辆\d+)[-：]\s*/);
      if (m) vid = m[1];
    }
    if (!vid) vid = '车辆1';

    let tail = rawItem;
    if (tail) {
      const p1 = `${vid}-`;
      const p2 = `${vid}：`;
      if (tail.startsWith(p1)) tail = tail.slice(p1.length).trim();
      else if (tail.startsWith(p2)) tail = tail.slice(p2.length).trim();
    }

    const hasStructuredPart = !!(r.damage_part || r.part);
    const hasStructuredMethod =
      String(r.repair_method || r.repair_type || '').trim() === '换' ||
      String(r.repair_method || r.repair_type || '').trim() === '修';

    if (!hasStructuredPart && !hasStructuredMethod && isAmbientRepairSuggestionRow(rawItem, tail)) {
      passthrough.push(r);
      continue;
    }

    let part = String(r.damage_part || r.part || '').trim();
    if (!part) {
      part =
        extractDamagePartFromAiSuggestionItem(tail) ||
        extractDamagePartFromAiSuggestionItem(rawItem) ||
        tail.trim();
    }
    if (!part) continue;

    let method = String(r.repair_method || r.repair_type || '').trim();
    if (method !== '换' && method !== '修') {
      const src = rawItem || tail;
      method = /更换|换|替换/.test(src) ? '换' : '修';
    }

    prelim.push({ raw: r, vid, part, method });
  }

  const order = [];
  const groups = new Map();
  for (const row of prelim) {
    const key = `${row.vid}\u0000${row.part.replace(/\s+/g, ' ')}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(row);
  }

  const normalized = [];
  for (const key of order) {
    const group = groups.get(key);
    const hasReplace = group.some((g) => g.method === '换');
    const pool = hasReplace ? group.filter((g) => g.method === '换') : group;
    const seenMethod = new Set();
    for (const g of pool) {
      if (seenMethod.has(g.method)) continue;
      seenMethod.add(g.method);
      const r = g.raw;
      const item = `${g.vid}-${g.part}`;
      normalized.push({
        ...r,
        vehicle_id: g.vid,
        damage_part: g.part,
        repair_method: g.method,
        repair_type: r.repair_type || g.method,
        item
      });
    }
  }

  return [...normalized, ...passthrough];
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
        damages: dedupeDamagesWithinList(raw),
        human_display: sanitizeHumanDisplay(v.human_display),
        guidance: normalizeGuidance(v.guidance),
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
      if (!ex.human_display && v.human_display) ex.human_display = sanitizeHumanDisplay(v.human_display);
      if (!ex.guidance && v.guidance) ex.guidance = normalizeGuidance(v.guidance);
      if (ex.guidance && v.guidance) {
        const g2 = normalizeGuidance(v.guidance);
        if (g2 && g2.communication_script && !ex.guidance.communication_script) ex.guidance.communication_script = g2.communication_script;
        if (g2 && Array.isArray(g2.arrival_notes) && g2.arrival_notes.length) {
          const merged = [...new Set([...(ex.guidance.arrival_notes || []), ...g2.arrival_notes])];
          ex.guidance.arrival_notes = merged;
        }
      }
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

  const repair_suggestions = dedupeRepairSuggestionsByItem(
    normalizeRepairSuggestionsStructured(ar.repair_suggestions || [])
  );

  const vehicles = Array.isArray(ar.vehicles) ? mergeDuplicateVehiclesInArray(ar.vehicles) : undefined;
  return { ...ar, damages: flat, repair_suggestions, vehicles };
}

module.exports = {
  dedupeDamagesWithinList,
  dedupeRepairSuggestionsByItem,
  mergeDuplicateVehiclesInArray,
  normalizeRepairSuggestionsStructured,
  sanitizeAnalysisResultForRead
};
