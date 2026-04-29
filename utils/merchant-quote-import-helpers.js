/**
 * 服务商报价 Excel / 识别导入行 → 小程序表单行（M05 首次报价、M07 修改报价单共用）
 */
const { normalizePartsTypeLabel, partsTypePickerIndex } = require('./parts-types');

const RT_IDX_SWAP = 0;
const RT_IDX_FIX = 1;

/** 去掉建议项「车辆N-」前缀，便于填损失部位 */
function stripVehiclePrefixFromItem(item) {
  const s = String(item || '').trim();
  const m = s.match(/^车辆\d+[-：]\s*(.+)$/);
  return m ? m[1].trim() : s;
}

/**
 * 从 AI repair_suggestions 的 item 中抽出「损失部位」短名：去掉与「维修方式」重复的换/修动词、去掉括号内损伤程度等说明。
 */
function extractDamagePartFromAiSuggestionItem(rawName) {
  let s = stripVehiclePrefixFromItem(rawName);
  if (!s) return '';
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^(?:更换|换件|替换|换|修复|修理|维修|钣金)\s*/u, '').trim();
  const cutFull = s.indexOf('（');
  const cutHalf = s.indexOf('(');
  let cut = -1;
  if (cutFull >= 0 && cutHalf >= 0) cut = Math.min(cutFull, cutHalf);
  else if (cutFull >= 0) cut = cutFull;
  else if (cutHalf >= 0) cut = cutHalf;
  if (cut >= 0) s = s.slice(0, cut).trim();
  s = s.replace(/(?:更换|换件|替换|换|修复|修理|维修)$/u, '').trim();
  s = s.replace(/的$/u, '').trim();
  if (!s) {
    const fb = stripVehiclePrefixFromItem(rawName);
    const seg = fb.split(/[更换修]/)[0]?.trim();
    return seg || fb.trim();
  }
  return s;
}

/** 采用 AI 建议后去重：同「损失部位 + 维修方式 + 配件类型」只保留首条 */
function dedupeQuoteItemsByPlanKey(items) {
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    const part = String(it.damage_part || '').trim();
    const rt = String(it.repair_type || '').trim();
    const pt = String(it.parts_type || '').trim();
    const key = `${part}\u0000${rt}\u0000${pt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/**
 * 采用 AI 建议专用：同一损失部位若同时出现「修」与「换」，只保留「换」侧行（避免引擎盖修+换两条）；
 * 部位内仍按 dedupeQuoteItemsByPlanKey 去重；整体顺序按部位首次出现顺序。
 */
function dedupeAiSuggestionQuoteItemsByDamagePart(items) {
  const list = dedupeQuoteItemsByPlanKey(items || []);
  const order = [];
  const byPart = new Map();
  for (const it of list) {
    const p = String(it.damage_part || '').trim();
    if (!byPart.has(p)) {
      byPart.set(p, []);
      order.push(p);
    }
    byPart.get(p).push(it);
  }
  const out = [];
  for (const p of order) {
    const group = byPart.get(p);
    const hasReplace = group.some((it) => String(it.repair_type || '').trim() === '换');
    const pool = hasReplace
      ? group.filter((it) => String(it.repair_type || '').trim() === '换')
      : group;
    out.push(...dedupeQuoteItemsByPlanKey(pool));
  }
  return out;
}

function parseApiErrorFromArrayBuffer(resData) {
  if (!resData || !(resData.byteLength > 0)) return '';
  try {
    const u8 = new Uint8Array(resData);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    const j = JSON.parse(s);
    return (j && j.message) ? String(j.message) : '';
  } catch (_) {
    return '';
  }
}

/**
 * @param {Array} rows
 * @param {object} opts
 * @param {Record<string,string>} [opts.existingPartsTypeMap] 已锁配件类型的部位 → 五类标签
 * @param {{v:number}} opts.idCounter 导入前将 v 设为当前 nextId；导入后 v 为已占用下一个序号，请把业务侧 nextId 同步为 idCounter.v
 * @param {string} [opts.idPrefix='imp-']
 * @param {boolean} [opts.withPartsTypeLock=false] 为 true 时写入 partsTypeLocked，并按 existingPartsTypeMap 覆盖换件类型
 * @param {string|number} [opts.defaultWarrantyMonths='12'] 识别结果无质保时的默认展示值
 */
function mapImportedRowsToPlanItems(rows, opts = {}) {
  const existingPartsTypeMap = opts.existingPartsTypeMap || {};
  const idCounter = opts.idCounter;
  if (!idCounter || typeof idCounter.v !== 'number') {
    throw new Error('mapImportedRowsToPlanItems: idCounter.v (number) required');
  }
  const idPrefix = opts.idPrefix || 'imp-';
  const withLock = opts.withPartsTypeLock === true;
  const defWar = opts.defaultWarrantyMonths != null ? String(opts.defaultWarrantyMonths) : '12';

  return (rows || []).map((it) => {
    const idNum = idCounter.v++;
    const part = (it.damage_part || '').trim();
    const rt = it.repair_type === '换' ? '换' : '修';
    const rtIdx = rt === '换' ? RT_IDX_SWAP : RT_IDX_FIX;
    const locked = withLock && !!existingPartsTypeMap[part];
    const ptRaw = it.parts_type ? normalizePartsTypeLabel(String(it.parts_type)) : '';
    const pt = rt === '换' ? (locked ? existingPartsTypeMap[part] : (ptRaw || '原厂件')) : '';
    const ptIdx = rt === '换' ? partsTypePickerIndex(pt) : 0;
    const linePrice = it.price != null && !Number.isNaN(parseFloat(it.price)) ? String(it.price) : '';
    const wmRaw = it.warranty_months;
    const lineWar = wmRaw != null && !Number.isNaN(parseInt(wmRaw, 10))
      ? String(parseInt(wmRaw, 10))
      : defWar;
    const row = {
      id: idPrefix + idNum,
      damage_part: part,
      repair_type: rt,
      repairTypeIndex: rtIdx,
      rtIdx,
      parts_type: pt,
      partsTypeIndex: ptIdx,
      ptIdx,
      line_price: linePrice,
      line_warranty: lineWar
    };
    if (withLock) {
      row.partsTypeLocked = locked;
    }
    return row;
  });
}

module.exports = {
  parseApiErrorFromArrayBuffer,
  mapImportedRowsToPlanItems,
  stripVehiclePrefixFromItem,
  extractDamagePartFromAiSuggestionItem,
  dedupeQuoteItemsByPlanKey,
  dedupeAiSuggestionQuoteItemsByDamagePart
};
