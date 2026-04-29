#!/usr/bin/env node
/**
 * 自检：读取并打印 settings.shopSortWeightsV1（店铺列表排序配置）
 *
 * 用法：
 *   node web/scripts/check-shop-sort-weights.js
 *   node web/scripts/check-shop-sort-weights.js --pretty
 *
 * 环境变量：与 API 相同（DB_HOST、DB_PORT、DB_USER、DB_PASSWORD、DB_NAME）
 * 会自动读取 web/.env 与 web/api-server/.env（后者覆盖）
 */
const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');

const requireApi = createRequire(path.join(__dirname, '..', 'api-server', 'server.js'));
const mysql = requireApi('mysql2/promise');
requireApi('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const envApi = path.join(__dirname, '..', 'api-server', '.env');
if (fs.existsSync(envApi)) requireApi('dotenv').config({ path: envApi, override: true });

const KEY = 'shopSortWeightsV1';
const DEFAULTS = {
  version: 1,
  scenes: {
    L1L2: {
      default: { shop: 0.35, distance: 0.3, price: 0.25, response: 0.1 },
      self_pay: { shop: 0.33, distance: 0.22, price: 0.35, response: 0.1 },
    },
    L3L4: {
      default: { shop: 0.6, distance: 0.05, price: 0.2, response: 0.15 },
      self_pay: { shop: 0.55, distance: 0.05, price: 0.28, response: 0.12 },
    },
    brand: {
      default: { shop: 0.5, distance: 0.1, price: 0.2, response: 0.2 },
      self_pay: { shop: 0.45, distance: 0.08, price: 0.3, response: 0.17 },
    },
  },
};

function mergeDeep(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object') {
      out[k] = mergeDeep(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function diffWeight(defaultVal, currentVal) {
  const a = Number(defaultVal);
  const b = Number(currentVal);
  if (!isFinite(a) || !isFinite(b)) return '';
  const d = Math.round((b - a) * 10000) / 10000;
  if (d === 0) return ' (=)';
  return d > 0 ? ` (+${d})` : ` (${d})`;
}

function printTable(cfg) {
  const scenes = ['L1L2', 'L3L4', 'brand'];
  const payers = ['default', 'self_pay'];
  const dims = ['shop', 'distance', 'price', 'response'];
  for (const s of scenes) {
    console.log(`\n[场景] ${s}`);
    for (const p of payers) {
      console.log(`  - 付款意图: ${p}`);
      for (const d of dims) {
        const cur = cfg?.scenes?.[s]?.[p]?.[d];
        const def = DEFAULTS.scenes[s][p][d];
        console.log(`      ${d}: ${cur}  (default=${def})${diffWeight(def, cur)}`);
      }
    }
  }
}

async function main() {
  const pretty = process.argv.includes('--pretty');
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'zhejian',
  });
  try {
    const [rows] = await pool.execute('SELECT `value` FROM settings WHERE `key` = ? LIMIT 1', [KEY]);
    let parsed = null;
    if (rows?.length && rows[0]?.value) {
      try {
        parsed = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
      } catch (e) {
        console.error(`[错误] settings.${KEY} 不是合法 JSON：`, e?.message || e);
        process.exit(1);
      }
    }
    if (!parsed) {
      console.log(`[未配置] settings.${KEY} 不存在，将按代码默认值生效。`);
      printTable(DEFAULTS);
      return;
    }
    const merged = mergeDeep(DEFAULTS, parsed);
    console.log(`[OK] 已读取 settings.${KEY}（version=${merged.version || '?'}, updatedAt=${merged.updatedAt || '-' }）`);
    if (pretty) console.log('\n' + JSON.stringify(merged, null, 2));
    printTable(merged);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

