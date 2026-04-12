#!/usr/bin/env node
/**
 * 根据 web/.env 中的 ZHEJIAN_MINIPROGRAM 生成根目录 config.local.js。
 * 小程序无法读取 .env，故由本脚本同步。
 *
 * 用法：在项目根目录执行  node scripts/sync-miniprogram-config.js
 * 或：npm run sync:config
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, 'web', '.env');
const OUT_PATH = path.join(ROOT, 'config.local.js');

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function main() {
  if (!fs.existsSync(ENV_PATH)) {
    console.warn(
      `[sync-miniprogram-config] 未找到 ${ENV_PATH}，将按 cloud 生成 config.local.js（请确认 .env 在 web 目录下，不是项目根目录）`
    );
  } else {
    console.log(`[sync-miniprogram-config] 读取: ${ENV_PATH}`);
  }
  const env = parseEnvFile(ENV_PATH);
  const mode = String(env.ZHEJIAN_MINIPROGRAM || 'cloud')
    .trim()
    .toLowerCase();
  const localBase =
    String(env.ZHEJIAN_LOCAL_API_BASE || 'http://127.0.0.1:3000').trim() ||
    'http://127.0.0.1:3000';

  let body;
  if (mode === 'local') {
    body = `module.exports = {\n  BASE_URL: ${JSON.stringify(localBase)},\n};`;
  } else {
    if (mode !== 'cloud') {
      console.warn(
        `[sync-miniprogram-config] 未知 ZHEJIAN_MINIPROGRAM="${mode}"，按 cloud 处理（可用 cloud | local）`
      );
    }
    body = 'module.exports = {};';
  }

  const header = `/**\n * 本文件由 scripts/sync-miniprogram-config.js 根据 web/.env 生成，请勿手改。\n * 切换：修改 web/.env 中 ZHEJIAN_MINIPROGRAM=cloud|local 后执行 npm run sync:config\n * local 时需在开发者工具勾选「不校验合法域名」。\n */\n`;

  fs.writeFileSync(OUT_PATH, header + body + '\n', 'utf8');
  console.log(
    `[sync-miniprogram-config] 已写入 config.local.js：模式=${mode === 'local' ? 'local → ' + localBase : 'cloud（走 config.js 默认线上地址）'}`
  );
}

main();
