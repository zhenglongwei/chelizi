#!/usr/bin/env node
/**
 * 运维脚本：写入/更新 settings.shopSortWeightsV1（店铺列表排序配置）
 *
 * 支持：
 * - --dry-run：只打印将要写入的 JSON，不落库
 * - --from-file <path>：从 JSON 文件导入（可包含 version/scenes/...）
 * - --set <scene> <payer> <dim> <value>：局部更新一个权重（可重复传多次）
 * - --pretty：打印 JSON（含最终写入值）
 *
 * 用法示例：
 *   node web/scripts/set-shop-sort-weights.js --dry-run --pretty
 *   node web/scripts/set-shop-sort-weights.js --from-file ./weights.json --dry-run
 *   node web/scripts/set-shop-sort-weights.js --set L1L2 default distance 0.5 --set L1L2 default shop 0.2
 *
 * 环境变量：与 API 相同（DB_HOST、DB_PORT、DB_USER、DB_PASSWORD、DB_NAME）
 * 会自动读取 web/.env 与 web/api-server/.env（后者覆盖）
 */

const fs = require('fs');
const path = require('path');
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
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && base[k] != null) {
      out[k] = mergeDeep(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function clamp01(x) {
  const v = Number(x);
  if (!isFinite(v)) return null;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return Math.round(v * 10000) / 10000;
}

function normalizeSceneKey(scene) {
  const s = String(scene || '').trim();
  if (s === 'L1L2' || s === 'L3L4' || s === 'brand') return s;
  return null;
}

function normalizePayerKey(payer) {
  const p = String(payer || '').trim();
  if (p === 'default' || p === 'insurance') return 'default';
  if (p === 'self_pay') return 'self_pay';
  return null;
}

function normalizeDim(dim) {
  const d = String(dim || '').trim();
  if (d === 'shop' || d === 'distance' || d === 'price' || d === 'response') return d;
  return null;
}

function parseArgs(argv) {
  const out = { dry: false, pretty: false, fromFile: null, sets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dry = true;
    else if (a === '--pretty') out.pretty = true;
    else if (a === '--from-file') out.fromFile = argv[++i];
    else if (a === '--set') {
      const scene = argv[++i];
      const payer = argv[++i];
      const dim = argv[++i];
      const value = argv[++i];
      out.sets.push({ scene, payer, dim, value });
    }
  }
  return out;
}

async function loadCurrent(pool) {
  const [rows] = await pool.execute('SELECT `value` FROM settings WHERE `key` = ? LIMIT 1', [KEY]);
  if (!rows?.length || !rows[0]?.value) return null;
  const raw = rows[0].value;
  if (typeof raw === 'string') return JSON.parse(raw);
  return raw;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'zhejian',
  });

  try {
    const current = await loadCurrent(pool);
    let next = mergeDeep(DEFAULTS, current || {});

    if (args.fromFile) {
      const p = path.isAbsolute(args.fromFile) ? args.fromFile : path.join(process.cwd(), args.fromFile);
      const txt = fs.readFileSync(p, 'utf8');
      const imported = JSON.parse(txt);
      next = mergeDeep(next, imported || {});
    }

    for (const s of args.sets) {
      const scene = normalizeSceneKey(s.scene);
      const payer = normalizePayerKey(s.payer);
      const dim = normalizeDim(s.dim);
      const v = clamp01(s.value);
      if (!scene || !payer || !dim || v == null) {
        console.error('[参数错误] --set <scene> <payer> <dim> <value>，其中 scene=L1L2/L3L4/brand，payer=default/self_pay，dim=shop/distance/price/response，value=0..1');
        process.exit(1);
      }
      next.scenes = next.scenes || {};
      next.scenes[scene] = next.scenes[scene] || {};
      next.scenes[scene][payer] = next.scenes[scene][payer] || {};
      next.scenes[scene][payer][dim] = v;
    }

    next.version = 1;
    next.updatedAt = new Date().toISOString();

    const json = JSON.stringify(next);
    if (args.pretty) {
      console.log(JSON.stringify(next, null, 2));
    } else {
      console.log(`[准备写入] settings.${KEY}（len=${json.length}）`);
    }

    if (args.dry) {
      console.log('[dry-run] 未写入数据库。');
      return;
    }

    await pool.execute(
      'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
      [KEY, json]
    );
    console.log('[OK] 已写入 settings.shopSortWeightsV1（保存后立即生效，无需重启）。');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

