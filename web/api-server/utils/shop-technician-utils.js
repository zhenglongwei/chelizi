/**
 * 店铺持证技师校验：可为空；若填写了列表则须至少 1 人资料完整（姓名 + 证件照 URL）。
 */

function parseTechnicianCerts(tc) {
  if (!tc) return [];
  if (Array.isArray(tc)) return tc;
  if (typeof tc === 'string') {
    try {
      const p = JSON.parse(tc);
      return Array.isArray(p) ? p : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

/**
 * @param {*} technicianCerts — DB 或请求体中的 technician_certs
 * @param {number} minCount — 最少有效人数，默认 1
 * @returns {{ ok: boolean, error?: string }}
 */
function validateMinimumTechnicianCerts(technicianCerts, minCount = 1) {
  const arr = parseTechnicianCerts(technicianCerts);
  if (arr.length < minCount) {
    return { ok: false, error: `请至少维护 ${minCount} 名持证技师（含姓名与证件照）` };
  }
  let valid = 0;
  for (const t of arr) {
    if (!t || typeof t !== 'object') continue;
    const name = String(t.name || t.display_name || t.nickname || '').trim();
    const certUrl = String(t.certificate_url || t.cert_url || '').trim();
    if (name && certUrl.startsWith('http')) valid++;
  }
  if (valid < minCount) {
    return {
      ok: false,
      error: `每名持证技师须填写姓名并上传证件照片（至少 ${minCount} 人）`,
    };
  }
  return { ok: true };
}

/**
 * 选填技师：无记录或通过「至少 1 名完整持证」校验。
 * @returns {{ ok: boolean, error?: string }}
 */
function validateOptionalTechnicianCerts(technicianCerts) {
  const arr = parseTechnicianCerts(technicianCerts);
  if (arr.length === 0) return { ok: true };
  return validateMinimumTechnicianCerts(technicianCerts, 1);
}

module.exports = {
  parseTechnicianCerts,
  validateMinimumTechnicianCerts,
  validateOptionalTechnicianCerts,
};
