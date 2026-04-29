/**
 * 从 AI repair_suggestions 的 item 文案抽出「损失部位」短名（api-server 内建，勿依赖小程序 utils 目录，便于生产仅部署 api-server）。
 */

function stripVehiclePrefixFromItem(item) {
  const s = String(item || '').trim();
  const m = s.match(/^车辆\d+[-：]\s*(.+)$/);
  return m ? m[1].trim() : s;
}

/**
 * 去掉与「维修方式」重复的换/修动词、去掉括号内损伤程度等说明。
 * 与小程序 utils/merchant-quote-import-helpers.js 保持语义一致。
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

module.exports = {
  stripVehiclePrefixFromItem,
  extractDamagePartFromAiSuggestionItem
};
