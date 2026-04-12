/**
 * 竞价预报价 Excel 模板（含中文使用说明 + 报价明细表）
 * 与 quote-import-service.parseQuoteImportCsv 列顺序一致（表头为中文）
 */

const ExcelJS = require('exceljs');
const { CANONICAL_PARTS_TYPES } = require('../constants/parts-types');

const TEMPLATE_FILENAME = '辙见-竞价报价明细模板.xlsx';

const INSTRUCTION_LINES = [
  ['辙见 · 竞价预报价明细表（Excel 模板）'],
  [''],
  ['一、用途'],
  ['本文件用于在电脑上用 Excel / WPS 填写维修项目明细，保存后再导入辙见小程序「竞价详情」页的报价单。'],
  [''],
  ['二、如何填写'],
  ['1. 点击下方工作表标签，切换到「报价明细」。'],
  ['2. 第 1 行为表头（中文列名），请勿删除或改动列顺序。'],
  ['3. 从第 2 行开始逐行填写每一条维修项目；可删除示例行后按实际需要增删行。'],
  ['4. 各列填写规则如下（均为中文填写）：'],
  [''],
  ['列名', '是否必填', '填写说明'],
  [
    '损失部位',
    '必填',
    '填写车辆受损部位名称，例如：前保险杠、左前门、右后翼子板。',
  ],
  [
    '维修方式',
    '必填',
    '只能填写「换」或「修」两个字，不要加其它符号。',
  ],
  [
    '配件类型',
    '按规则',
    '当维修方式为「换」时本列必填，且须为以下五类之一（请完整照抄名称）：' +
      CANONICAL_PARTS_TYPES.join('、') +
      '。当维修方式为「修」时本列请留空，不要填写任何内容。',
  ],
  [
    '分项金额（元）',
    '必填',
    '该行维修项目的金额，仅填数字，可带小数（如 1200 或 850.5）。',
  ],
  [
    '项目质保（月）',
    '必填',
    '该项目质保月数，填非负整数，例如 6、12。',
  ],
  [''],
  ['三、填完后如何导入小程序'],
  [
    '1. 在电脑或手机上用 Excel / WPS 填好并保存为 .xlsx（勿删「报价明细」表第 1 行表头）。',
  ],
  [
    '2. 将 .xlsx 文件通过微信「文件传输助手」等发到手机。',
  ],
  ['3. 打开辙见小程序竞价详情页，点击「导入 Excel」，从聊天记录中选择该 .xlsx 文件即可。'],
  [
    '（说明）若需使用 CSV，可调用服务端接口 /api/v1/merchant/quote-import/preview 传入 csv_text；小程序内请以 .xlsx 导入为主。',
  ],
  [''],
  ['四、其它方式'],
  [
    '您也可直接在小程序里手工录入、使用「采用 AI 建议」或「拍照识别」，与 Excel 填表可同时使用或二选一。',
  ],
  [''],
  ['五、合规提示'],
  [
    '报价须真实、分项金额之和须与小程序内填写的总报价一致；换件时配件类型须与完工物料照等证明材料一致，详见《配件类型和极简证明材料》。',
  ],
];

/**
 * @returns {Promise<Buffer>}
 */
async function buildQuoteTemplateXlsxBuffer() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '辙见';
  workbook.created = new Date();

  const help = workbook.addWorksheet('使用说明', {
    properties: { defaultRowHeight: 18 },
    views: [{ showGridLines: true }],
  });
  help.getColumn(1).width = 36;
  help.getColumn(2).width = 12;
  help.getColumn(3).width = 62;
  INSTRUCTION_LINES.forEach((cells, idx) => {
    const row = help.getRow(idx + 1);
    const list = Array.isArray(cells) ? cells : [cells];
    list.forEach((val, ci) => {
      const cell = row.getCell(ci + 1);
      cell.value = val;
      cell.alignment = { vertical: 'top', wrapText: true };
    });
    if (idx === 0) {
      row.getCell(1).font = { bold: true, size: 14 };
      row.height = 28;
    }
  });
  help.mergeCells(1, 1, 1, 3);
  help.getRow(1).getCell(1).alignment = { vertical: 'middle', wrapText: true };

  const detailHeaders = ['损失部位', '维修方式', '配件类型', '分项金额（元）', '项目质保（月）'];
  const sheet = workbook.addWorksheet('报价明细', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  const headerRow = sheet.addRow(detailHeaders);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE8F4FF' },
    };
    cell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };
  });
  sheet.addRow(['前保险杠', '换', '原厂件', 1200, 12]);
  sheet.addRow(['左前门', '修', '', 800, 6]);
  sheet.columns = [
    { width: 18 },
    { width: 10 },
    { width: 14 },
    { width: 16 },
    { width: 16 },
  ];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };
    });
  });

  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

module.exports = {
  TEMPLATE_FILENAME,
  buildQuoteTemplateXlsxBuffer,
};
