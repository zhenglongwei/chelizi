#!/usr/bin/env node
/**
 * 将线上/本地库中 reward_rules.rewardRules 的 JSON 规范为「基础轨简化」后的中性值
 *（与 web/api-server/utils/normalize-reward-rules-json.js、后台 RewardRulesConfig 保存逻辑一致）。
 *
 * 用法（仓库根目录或任意目录，需已安装 web/api-server 依赖）：
 *   node web/scripts/normalize-reward-rules-db.js           # 执行更新
 *   node web/scripts/normalize-reward-rules-db.js --dry-run # 只打印规范化后的 JSON
 *   node web/scripts/normalize-reward-rules-db.js --info    # 只打印当前连接的库与 reward_rules 中的 rule_key
 *
 * 环境变量：与 API 相同（DB_HOST、DB_PORT、DB_USER、DB_PASSWORD、DB_NAME），
 * 自动读取 web/.env 与 web/api-server/.env（后者覆盖）。
 */

const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');

/** 从 api-server 解析 mysql2/dotenv（请在任意目录执行，无需 cd api-server） */
const requireApi = createRequire(path.join(__dirname, '..', 'api-server', 'server.js'));
const mysql = requireApi('mysql2/promise');

const envWebRoot = path.join(__dirname, '..', '.env');
const envApiServer = path.join(__dirname, '..', 'api-server', '.env');
requireApi('dotenv').config({ path: envWebRoot });
if (fs.existsSync(envApiServer)) {
  requireApi('dotenv').config({ path: envApiServer, override: true });
}

const { normalizeRewardRulesRoot } = require('../api-server/utils/normalize-reward-rules-json.js');

function printConnectionHint(toStderr) {
  const log = toStderr ? console.error.bind(console) : console.log.bind(console);
  const host = process.env.DB_HOST || 'localhost';
  const port = parseInt(process.env.DB_PORT, 10) || 3306;
  const db = process.env.DB_NAME || 'zhejian';
  const user = process.env.DB_USER || 'root';
  log(`[连接] ${user}@${host}:${port}  database=${db}`);
  log('[提示] 规则来自 web/.env 与 web/api-server/.env（后者覆盖）；找不到行时请核对是否连错库。');
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const infoOnly = process.argv.includes('--info');
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'zhejian',
  });

  try {
    if (infoOnly) {
      printConnectionHint(false);
      const [all] = await pool.execute(
        'SELECT rule_key AS k, description AS d FROM reward_rules ORDER BY rule_key LIMIT 50'
      );
      console.log(JSON.stringify(all, null, 2));
      const has = Array.isArray(all) && all.some((r) => r && String(r.k) === 'rewardRules');
      console.log(has ? '\n已存在 rule_key = rewardRules' : '\n当前库中无 rule_key = rewardRules（需后台保存或执行 migration-20260309-reward-rules-unified.sql）');
      return;
    }

    const [rows] = await pool.execute(
      'SELECT rule_value FROM reward_rules WHERE rule_key = ? LIMIT 1',
      ['rewardRules']
    );
    if (!rows.length) {
      printConnectionHint(true);
      let existing = [];
      try {
        const [all] = await pool.execute(
          'SELECT rule_key AS k FROM reward_rules ORDER BY rule_key LIMIT 50'
        );
        existing = all || [];
      } catch (_) {
        /* 表可能不存在 */
      }
      if (existing.length) {
        console.error('本库 reward_rules 中现有 rule_key：', existing.map((r) => r.k).join(', ') || '(无)');
      } else {
        console.error('reward_rules 表无数据或不存在；请先建表并写入配置（schema + 迁移或后台「奖励金规则」保存）。');
      }
      console.error('未找到 rule_key = rewardRules。');
      process.exit(1);
    }
    let val = rows[0].rule_value;
    if (typeof val === 'string') {
      val = JSON.parse(val);
    }
    const next = normalizeRewardRulesRoot(val);
    if (dry) {
      console.log(JSON.stringify(next, null, 2));
      return;
    }
    const json = JSON.stringify(next);
    await pool.execute('UPDATE reward_rules SET rule_value = ? WHERE rule_key = ?', [json, 'rewardRules']);
    console.log('已更新 reward_rules（rule_key=rewardRules），废止字段已清零 / complexityLevels 已统一 float_ratio=0、cap_amount=0。');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
