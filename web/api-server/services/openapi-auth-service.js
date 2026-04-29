const crypto = require('crypto');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

async function tableExists(pool, tableName) {
  try {
    const [rows] = await pool.execute(
      `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [tableName]
    );
    return rows.length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * 允许两种来源：
 * - DB: api_keys 表（优先）
 * - ENV: OPEN_API_KEYS=key1,key2,...（用于迁移前快速启用）
 */
async function resolveApiKey(pool, rawKey) {
  const key = String(rawKey || '').trim();
  if (!key) return null;

  const hasTable = await tableExists(pool, 'api_keys');
  if (hasTable) {
    const hash = sha256Hex(key);
    const [rows] = await pool.execute(
      `SELECT api_key_id, owner_type, owner_id, status, daily_limit
       FROM api_keys WHERE api_key_hash = ? LIMIT 1`,
      [hash]
    );
    if (!rows.length) return null;
    const r = rows[0];
    if (String(r.status) !== '1') return null;
    return {
      api_key_id: r.api_key_id,
      owner_type: r.owner_type,
      owner_id: r.owner_id,
      daily_limit: r.daily_limit != null ? parseInt(r.daily_limit, 10) : 0,
      source: 'db',
    };
  }

  const env = String(process.env.OPEN_API_KEYS || '').trim();
  if (!env) return null;
  const list = env
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.includes(key)) return null;
  return {
    api_key_id: 'env_' + sha256Hex(key).slice(0, 16),
    owner_type: 'system',
    owner_id: 'env',
    daily_limit: 0,
    source: 'env',
  };
}

module.exports = {
  resolveApiKey,
  sha256Hex,
  tableExists,
};

