/**
 * 维修厂信息页 - 选项常量（参照国家/行业标准）
 */

// 营业时间选项（统一格式）
exports.BUSINESS_HOURS_OPTIONS = [
  '8:00-18:00',
  '8:00-20:00',
  '8:30-17:30',
  '9:00-18:00',
  '9:00-21:00',
  '8:00-21:00',
  '24小时'
];

// 维修资质等级（GB/T 16739 汽车维修业经营业务条件）
exports.QUALIFICATION_LEVEL_OPTIONS = [
  { value: '一类', label: '一类维修企业' },
  { value: '二类', label: '二类维修企业' },
  { value: '三类', label: '三类维修业户（综合小修/专项维修）' }
];

// 技师等级：普通技工为默认（无证书时）；有证书则按证书等级选择
exports.TECHNICIAN_LEVEL_OPTIONS = [
  { value: '普通技工', label: '普通技工（无证书时默认）' },
  { value: '初级工', label: '初级工（五级）' },
  { value: '中级工', label: '中级工（四级）' },
  { value: '高级工', label: '高级工（三级）' },
  { value: '技师', label: '技师（二级）' },
  { value: '高级技师', label: '高级技师（一级）' }
];
