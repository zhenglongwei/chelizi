/**
 * 服务商报价 Excel / 识别导入行 → 小程序表单行（M05 首次报价、M07 修改报价单共用）
 */
const { normalizePartsTypeLabel, partsTypePickerIndex } = require('./parts-types');

const RT_IDX_SWAP = 0;
const RT_IDX_FIX = 1;

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
  mapImportedRowsToPlanItems
};
