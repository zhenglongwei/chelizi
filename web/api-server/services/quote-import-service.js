/**
 * 标准报价表 CSV / Excel 解析（与 quotes.items / 小程序报价项对齐）
 * 列：损失部位、维修方式、配件类型、分项价格、项目质保（月）
 */

const ExcelJS = require('exceljs');
const { normalizePartsType, CANONICAL_PARTS_TYPES } = require('../constants/parts-types');

const TEMPLATE_FILENAME = 'zhejian-quote-template.csv';

const TEMPLATE_CSV =
  'damage_part,repair_type,parts_type,price,warranty_months\n' +
  '前保险杠,换,原厂件,1200,12\n' +
  '左前门,修,,800,6\n';

function getQuoteTemplatePayload() {
  return {
    filename: TEMPLATE_FILENAME,
    mime_type: 'text/csv; charset=utf-8',
    csv: TEMPLATE_CSV,
    columns: [
      { key: 'damage_part', label: '损失部位', required: true },
      { key: 'repair_type', label: '维修方式', required: true, enum: ['换', '修'] },
      {
        key: 'parts_type',
        label: '配件类型',
        required: true,
        note: '「换」必填，须为：' + CANONICAL_PARTS_TYPES.join('、') + '；「修」可留空',
      },
      { key: 'price', label: '分项金额（元）', required: true },
      { key: 'warranty_months', label: '项目质保（月）', required: true },
    ],
  };
}

function parseLineCSV(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQ = !inQ;
      continue;
    }
    if (!inQ && c === ',') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

function isHeaderRow(cells) {
  const joined = cells.join(',').toLowerCase();
  return /damage_part|损失部位/.test(joined) && /repair_type|维修/.test(joined);
}

/**
 * 解析一行报价表数据（CSV / Excel 共用）
 * @returns {{ skip?: true } | { ok: false, error: string } | { ok: true, item: object }}
 */
function tryParseQuoteImportRow(rowNum, damagePart, repairType, partsTypeRaw, priceRaw, warRaw) {
  const dp = String(damagePart || '').trim();
  const rt = String(repairType || '').trim();
  const ptRaw = String(partsTypeRaw || '').trim();
  const prRaw =
    priceRaw === null || priceRaw === undefined
      ? ''
      : typeof priceRaw === 'number' && !Number.isNaN(priceRaw)
        ? String(priceRaw)
        : String(priceRaw).trim();
  const wmRaw =
    warRaw === null || warRaw === undefined
      ? ''
      : typeof warRaw === 'number' && !Number.isNaN(warRaw)
        ? String(Math.trunc(warRaw))
        : String(warRaw).trim();

  if (!dp && !rt && !ptRaw && !prRaw && !wmRaw) {
    return { skip: true };
  }
  if (!dp) {
    return { ok: false, error: `第 ${rowNum} 行：损失部位不能为空` };
  }
  if (rt !== '换' && rt !== '修') {
    return { ok: false, error: `第 ${rowNum} 行：维修方式须为「换」或「修」` };
  }
  if (rt === '换') {
    if (!ptRaw) {
      return {
        ok: false,
        error: `第 ${rowNum} 行：选择「换」时必须填写配件类型（${CANONICAL_PARTS_TYPES.join('、')}）`,
      };
    }
    const canon = normalizePartsType(ptRaw);
    if (!canon || !CANONICAL_PARTS_TYPES.includes(canon)) {
      return {
        ok: false,
        error: `第 ${rowNum} 行：配件类型须为规范五类之一：${CANONICAL_PARTS_TYPES.join('、')}（当前：${ptRaw || '空'}）`,
      };
    }
  }
  if (!prRaw) {
    return { ok: false, error: `第 ${rowNum} 行：分项金额（元）不能为空` };
  }
  const p = parseFloat(prRaw);
  if (Number.isNaN(p) || p < 0) {
    return { ok: false, error: `第 ${rowNum} 行：分项金额无效` };
  }
  if (!wmRaw) {
    return { ok: false, error: `第 ${rowNum} 行：项目质保（月）不能为空` };
  }
  const w = parseInt(wmRaw, 10);
  if (Number.isNaN(w) || w < 0) {
    return { ok: false, error: `第 ${rowNum} 行：项目质保月数无效` };
  }
  return {
    ok: true,
    item: {
      damage_part: dp,
      repair_type: rt,
      parts_type: rt === '换' ? normalizePartsType(ptRaw) : null,
      price: Math.round(p * 100) / 100,
      warranty_months: w,
    },
  };
}

function excelCellToScalar(val) {
  if (val == null || val === '') return '';
  if (typeof val === 'number' && !Number.isNaN(val)) return val;
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'object') {
    if (val.result !== undefined && val.result !== null) return excelCellToScalar(val.result);
    if (val.text != null) return String(val.text).trim();
    if (val.richText && val.richText.length) {
      return val.richText.map((t) => t.text || '').join('').trim();
    }
  }
  return String(val).trim();
}

function buildExcelColumnMap(sheet) {
  const hr = sheet.getRow(1);
  const map = {};
  hr.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const raw = String(excelCellToScalar(cell.value)).replace(/\s+/g, '');
    if (!raw) return;
    const lower = raw.toLowerCase();
    if (raw.includes('损失部位') || lower === 'damage_part') map.damage_part = colNumber;
    else if (raw.includes('维修方式') || lower.includes('repair_type')) map.repair_type = colNumber;
    else if (raw.includes('配件类型') || lower.includes('parts_type')) map.parts_type = colNumber;
    else if (raw.includes('分项金额') || lower === 'price') map.price = colNumber;
    else if (raw.includes('项目质保') || lower.includes('warranty_months') || /^质保.*月$/.test(raw)) {
      map.warranty_months = colNumber;
    }
  });
  if (map.damage_part != null && map.repair_type != null && map.price != null && map.warranty_months != null) {
    if (map.parts_type == null && map.price > map.repair_type) {
      map.parts_type = map.repair_type + 1;
    }
    if (map.parts_type == null) {
      map.parts_type = 3;
    }
    return map;
  }
  return { damage_part: 1, repair_type: 2, parts_type: 3, price: 4, warranty_months: 5 };
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<{ ok: boolean, items?: object[], amount_sum?: number, errors?: string[] }>}
 */
async function parseQuoteImportXlsx(buffer) {
  if (!buffer || buffer.length === 0) {
    return { ok: false, errors: ['文件为空'] };
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (_) {
    return { ok: false, errors: ['无法读取 Excel 文件，请确认是否为 .xlsx 格式'] };
  }
  let sheet = workbook.getWorksheet('报价明细');
  if (!sheet) {
    for (const ws of workbook.worksheets) {
      const c1 = excelCellToScalar(ws.getRow(1).getCell(1).value);
      if (String(c1).includes('损失') || String(c1).includes('部位')) {
        sheet = ws;
        break;
      }
    }
  }
  if (!sheet) {
    sheet = workbook.worksheets[0];
  }
  if (!sheet) {
    return { ok: false, errors: ['工作簿中无工作表'] };
  }

  const colMap = buildExcelColumnMap(sheet);
  const items = [];
  const rowErrors = [];
  let amountSum = 0;
  const maxRow = Math.min(sheet.rowCount || 0, 500);

  for (let r = 2; r <= maxRow; r++) {
    const row = sheet.getRow(r);
    const damagePart = excelCellToScalar(row.getCell(colMap.damage_part).value);
    const repairType = excelCellToScalar(row.getCell(colMap.repair_type).value);
    const partsTypeRaw = colMap.parts_type != null ? excelCellToScalar(row.getCell(colMap.parts_type).value) : '';
    const priceRaw = excelCellToScalar(row.getCell(colMap.price).value);
    const warRaw = excelCellToScalar(row.getCell(colMap.warranty_months).value);

    const out = tryParseQuoteImportRow(r, damagePart, repairType, partsTypeRaw, priceRaw, warRaw);
    if (out.skip) continue;
    if (!out.ok) {
      rowErrors.push(out.error);
      continue;
    }
    amountSum += out.item.price;
    items.push(out.item);
  }

  if (rowErrors.length) {
    return { ok: false, errors: rowErrors };
  }
  if (items.length === 0) {
    return { ok: false, errors: ['未解析到任何维修项目'] };
  }
  return { ok: true, items, amount_sum: Math.round(amountSum * 100) / 100 };
}

/**
 * @param {string} csvText
 * @returns {{ ok: boolean, items?: object[], row_errors?: string[], amount_sum?: number, errors?: string[] }}
 */
function parseQuoteImportCsv(csvText) {
  const errors = [];
  const raw = String(csvText || '').replace(/^\uFEFF/, '').trim();
  if (!raw) {
    return { ok: false, errors: ['文件内容为空'] };
  }

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { ok: false, errors: ['无有效行'] };
  }

  let start = 0;
  const firstCells = parseLineCSV(lines[0]);
  if (isHeaderRow(firstCells)) {
    start = 1;
  }

  const items = [];
  const rowErrors = [];
  let amountSum = 0;

  for (let i = start; i < lines.length; i++) {
    const cells = parseLineCSV(lines[i]);
    const rowNum = i + 1;
    const damagePart = (cells[0] || '').trim();
    const repairType = (cells[1] || '').trim();
    const partsTypeRaw = (cells[2] || '').trim();
    const priceRaw = (cells[3] || '').trim();
    const warRaw = (cells[4] || '').trim();

    const out = tryParseQuoteImportRow(rowNum, damagePart, repairType, partsTypeRaw, priceRaw, warRaw);
    if (out.skip) continue;
    if (!out.ok) {
      rowErrors.push(out.error);
      continue;
    }
    amountSum += out.item.price;
    items.push(out.item);
  }

  if (rowErrors.length) {
    return { ok: false, errors: rowErrors };
  }
  if (items.length === 0) {
    return { ok: false, errors: ['未解析到任何维修项目'] };
  }

  return { ok: true, items, amount_sum: Math.round(amountSum * 100) / 100 };
}

/**
 * 报价明细校验（分项价、项目质保、换件五类），供竞价报价与到店最终报价共用
 * @returns {{ ok: boolean, error?: string, items?: object[], maxWarranty?: number, sumPrice?: number }}
 */
function sanitizeQuoteItemsStrict(items) {
  const arr = Array.isArray(items) ? items : [];
  if (arr.length === 0) {
    return { ok: false, error: '请填写维修项目明细' };
  }
  const out = [];
  let maxWarranty = null;
  let sumPrice = 0;
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i] || {};
    const part = String(it.damage_part || it.name || it.item || '').trim();
    if (!part) {
      return { ok: false, error: `第 ${i + 1} 项：损失部位不能为空` };
    }
    const rt = it.repair_type === '换' ? '换' : '修';
    let pt = null;
    if (rt === '换') {
      pt = normalizePartsType(it.parts_type);
      if (!pt || !CANONICAL_PARTS_TYPES.includes(pt)) {
        return {
          ok: false,
          error: `「${part}」换件须选择规范配件类型：${CANONICAL_PARTS_TYPES.join('、')}`,
        };
      }
    }
    const pr = parseFloat(it.price);
    if (Number.isNaN(pr) || pr < 0) {
      return { ok: false, error: `「${part}」须填写分项金额（元）` };
    }
    const wm = parseInt(it.warranty_months, 10);
    if (Number.isNaN(wm) || wm < 0) {
      return { ok: false, error: `「${part}」须填写项目质保（月）` };
    }
    sumPrice += pr;
    maxWarranty = maxWarranty == null ? wm : Math.max(maxWarranty, wm);
    out.push({
      damage_part: part,
      repair_type: rt,
      parts_type: pt,
      price: Math.round(pr * 100) / 100,
      warranty_months: wm,
    });
  }
  return { ok: true, items: out, maxWarranty, sumPrice: Math.round(sumPrice * 100) / 100 };
}

/** 从分项明细推导最长项目质保（月），用于排序等；不设整单质保字段 */
function maxWarrantyMonthsFromItems(items) {
  let m = null;
  for (const it of items || []) {
    const wm = parseInt(it && it.warranty_months, 10);
    if (!Number.isNaN(wm) && wm >= 0) m = m == null ? wm : Math.max(m, wm);
  }
  return m ?? 0;
}

/** 方案是否在各分项上声明了项目质保（用于评价页核验等） */
function planItemsAllHaveWarrantyMonths(plan) {
  if (!plan || !Array.isArray(plan.items) || plan.items.length === 0) return false;
  return plan.items.every((it) => {
    const wm = parseInt(it && it.warranty_months, 10);
    return !Number.isNaN(wm) && wm >= 0;
  });
}

module.exports = {
  getQuoteTemplatePayload,
  parseQuoteImportCsv,
  parseQuoteImportXlsx,
  sanitizeQuoteItemsStrict,
  maxWarrantyMonthsFromItems,
  planItemsAllHaveWarrantyMonths,
  TEMPLATE_CSV,
};
