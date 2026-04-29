const {
  CAPABILITY_SETTING_KEYS,
  CAPABILITY_DEFAULTS,
} = require('../constants/capabilities');
const { tableExists } = require('./openapi-auth-service');

function parseBoolSetting(value, fallback) {
  if (value == null) return fallback;
  const s = String(value).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return fallback;
}

async function getSetting(pool, key) {
  const [rows] = await pool.execute('SELECT `value` FROM settings WHERE `key` = ? LIMIT 1', [key]);
  return rows && rows.length ? rows[0].value : null;
}

/**
 * Phase1：仅全局 settings 开关
 * 返回：{ enabled: string[], map: { [capabilityKey]: boolean } }
 */
async function getEnabledCapabilities(pool) {
  const map = { ...CAPABILITY_DEFAULTS };
  const entries = Object.entries(CAPABILITY_SETTING_KEYS);
  for (const [capKey, settingKey] of entries) {
    try {
      const v = await getSetting(pool, settingKey);
      map[capKey] = parseBoolSetting(v, CAPABILITY_DEFAULTS[capKey] === true);
    } catch (_) {
      map[capKey] = CAPABILITY_DEFAULTS[capKey] === true;
    }
  }
  const enabled = Object.keys(map).filter((k) => map[k]);
  return { enabled, map };
}

/**
 * Phase2 预留：主体级 entitlement（user/shop/tenant）。
 * 目前先返回全局能力；后续可在此处叠加：
 * - settings 全局 default
 * - tenant/shop plan 覆盖
 * - user 试用/付费覆盖
 */
async function getEnabledCapabilitiesForSubject(pool, subject) {
  const base = await getEnabledCapabilities(pool);
  const apiKeyId = subject && subject.api_key_id ? String(subject.api_key_id).trim() : '';
  if (!apiKeyId) return base;

  const hasEntitlements = await tableExists(pool, 'api_key_capabilities');
  if (!hasEntitlements) return base;

  const [rows] = await pool.execute(
    `SELECT capability_key FROM api_key_capabilities
     WHERE api_key_id = ? AND status = 1`,
    [apiKeyId]
  );
  const allowed = new Set((rows || []).map((r) => String(r.capability_key || '').trim()).filter(Boolean));
  // 若未配置任何 capability，则默认不开放（避免误放开）
  const map = {};
  for (const [k, v] of Object.entries(base.map || {})) {
    map[k] = v === true && allowed.has(k);
  }
  const enabled = Object.keys(map).filter((k) => map[k]);
  return { enabled, map };
}

async function ensureCapability(pool, capabilityKey) {
  const { map } = await getEnabledCapabilities(pool);
  return map[capabilityKey] === true;
}

module.exports = {
  getEnabledCapabilities,
  getEnabledCapabilitiesForSubject,
  ensureCapability,
};

