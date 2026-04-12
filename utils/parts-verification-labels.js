/**
 * 配件验真方式（与 web/api-server/services/order-service.js PARTS_VERIFICATION_METHOD_KEYS 一致）
 */
const PARTS_VERIFICATION_METHODS = [
  { key: 'official', label: '官方渠道' },
  { key: 'qr_scan', label: '二维码/防伪码' },
  { key: 'face_to_face', label: '当面验货' },
  { key: 'paper_proof', label: '纸质凭证' },
  { key: 'other', label: '其他（请说明）' }
];

function labelForKey(k) {
  const row = PARTS_VERIFICATION_METHODS.find((m) => m.key === k);
  return row ? row.label : k;
}

function formatMethodsSummary(methods) {
  if (!Array.isArray(methods) || !methods.length) return '';
  return methods.map(labelForKey).join('、');
}

module.exports = {
  PARTS_VERIFICATION_METHODS,
  labelForKey,
  formatMethodsSummary
};
