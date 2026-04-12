/**
 * 星级 vs AI 矛盾检测阈值：存 settings 表，管理端可配置
 */

const KEYS = {
  enabled: 'review_star_ai_anomaly_enabled',
  userLowMax: 'review_star_ai_anomaly_user_low_max',
  userHighMin: 'review_star_ai_anomaly_user_high_min',
  quotePctGoodMax: 'review_star_ai_anomaly_quote_pct_good_max',
  quotePctBadMin: 'review_star_ai_anomaly_quote_pct_bad_min',
  repairGoodMin: 'review_star_ai_anomaly_repair_good_min',
  repairBadMax: 'review_star_ai_anomaly_repair_bad_max',
};

const DEFAULTS = {
  enabled: true,
  userLowMax: 2,
  userHighMin: 4,
  quotePctGoodMax: 8,
  quotePctBadMin: 18,
  repairGoodMin: 72,
  repairBadMax: 45,
};

function parseBool(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'no') return false;
  return null;
}

function parseIntBounded(raw, min, max, fallback) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<typeof DEFAULTS>}
 */
async function getStarAiAnomalyConfig(pool) {
  const keyList = Object.values(KEYS);
  try {
    const [rows] = await pool.execute(
      `SELECT \`key\`, \`value\` FROM settings WHERE \`key\` IN (${keyList.map(() => '?').join(',')})`,
      keyList
    );
    const map = {};
    for (const r of rows || []) map[r.key] = r.value;
    const en = parseBool(map[KEYS.enabled]);
    return {
      enabled: en === null ? DEFAULTS.enabled : en,
      userLowMax: parseIntBounded(map[KEYS.userLowMax], 1, 4, DEFAULTS.userLowMax),
      userHighMin: parseIntBounded(map[KEYS.userHighMin], 2, 5, DEFAULTS.userHighMin),
      quotePctGoodMax: parseIntBounded(map[KEYS.quotePctGoodMax], 0, 100, DEFAULTS.quotePctGoodMax),
      quotePctBadMin: parseIntBounded(map[KEYS.quotePctBadMin], 0, 100, DEFAULTS.quotePctBadMin),
      repairGoodMin: parseIntBounded(map[KEYS.repairGoodMin], 0, 100, DEFAULTS.repairGoodMin),
      repairBadMax: parseIntBounded(map[KEYS.repairBadMax], 0, 100, DEFAULTS.repairBadMax),
    };
  } catch (e) {
    console.error('[review-star-ai-anomaly-config] getStarAiAnomalyConfig:', e.message);
    return { ...DEFAULTS };
  }
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {Partial<typeof DEFAULTS>} body
 */
async function saveStarAiAnomalyConfig(pool, body) {
  const cur = await getStarAiAnomalyConfig(pool);
  const next = {
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : cur.enabled,
    userLowMax:
      body.userLowMax !== undefined
        ? parseIntBounded(body.userLowMax, 1, 4, cur.userLowMax)
        : cur.userLowMax,
    userHighMin:
      body.userHighMin !== undefined
        ? parseIntBounded(body.userHighMin, 2, 5, cur.userHighMin)
        : cur.userHighMin,
    quotePctGoodMax:
      body.quotePctGoodMax !== undefined
        ? parseIntBounded(body.quotePctGoodMax, 0, 100, cur.quotePctGoodMax)
        : cur.quotePctGoodMax,
    quotePctBadMin:
      body.quotePctBadMin !== undefined
        ? parseIntBounded(body.quotePctBadMin, 0, 100, cur.quotePctBadMin)
        : cur.quotePctBadMin,
    repairGoodMin:
      body.repairGoodMin !== undefined
        ? parseIntBounded(body.repairGoodMin, 0, 100, cur.repairGoodMin)
        : cur.repairGoodMin,
    repairBadMax:
      body.repairBadMax !== undefined
        ? parseIntBounded(body.repairBadMax, 0, 100, cur.repairBadMax)
        : cur.repairBadMax,
  };
  if (next.userLowMax >= next.userHighMin) {
    next.userHighMin = Math.min(5, next.userLowMax + 1);
  }
  if (next.quotePctGoodMax >= next.quotePctBadMin) {
    next.quotePctBadMin = Math.min(100, next.quotePctGoodMax + 1);
  }
  if (next.repairGoodMin <= next.repairBadMax) {
    next.repairBadMax = Math.max(0, next.repairGoodMin - 1);
  }

  const pairs = [
    [KEYS.enabled, next.enabled ? '1' : '0'],
    [KEYS.userLowMax, String(next.userLowMax)],
    [KEYS.userHighMin, String(next.userHighMin)],
    [KEYS.quotePctGoodMax, String(next.quotePctGoodMax)],
    [KEYS.quotePctBadMin, String(next.quotePctBadMin)],
    [KEYS.repairGoodMin, String(next.repairGoodMin)],
    [KEYS.repairBadMax, String(next.repairBadMax)],
  ];
  for (const [k, v] of pairs) {
    await pool.execute(
      'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
      [k, v, v]
    );
  }
  return next;
}

/** 与 DEFAULTS 合并，避免缺字段导致运行期异常 */
function mergeStarAiAnomalyConfig(cfg) {
  return { ...DEFAULTS, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
}

module.exports = {
  KEYS,
  DEFAULTS,
  getStarAiAnomalyConfig,
  saveStarAiAnomalyConfig,
  mergeStarAiAnomalyConfig,
};
