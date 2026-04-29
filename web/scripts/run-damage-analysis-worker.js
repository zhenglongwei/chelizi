#!/usr/bin/env node
/**
 * 异步 AI 定损分析 worker
 *
 * - 拉取 damage_analysis_tasks（queued/failed），claim 后执行分析
 * - 根据 repair_related 过滤（irrelevant → 拒绝分发）
 * - 失败重试最多 3 次，超过后进入人工审核（manual_review）
 *
 * 用法：
 *   node web/scripts/run-damage-analysis-worker.js --once
 *   node web/scripts/run-damage-analysis-worker.js --loop
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createRequire } = require('module');

const requireApi = createRequire(path.join(__dirname, '..', 'api-server', 'server.js'));
const mysql = requireApi('mysql2/promise');
requireApi('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const envApiServer = path.join(__dirname, '..', 'api-server', '.env');
if (fs.existsSync(envApiServer)) {
  requireApi('dotenv').config({ path: envApiServer, override: true });
}

const qwenAnalyzer = require('../api-server/qwen-analyzer');
const { enhanceAnalysisWithKnowledge } = require('../api-server/knowledge-base');
const { applySupplementaryRiskFallback } = require('../api-server/utils/supplementary-risk-fallback');
const { sanitizeAnalysisResultForRead } = require('../api-server/utils/analysis-result-sanitize');
const { enrichAnalysisResultHumanDisplay } = require('../api-server/utils/human-display');
const biddingDistribution = require('../api-server/services/bidding-distribution');

const WORKER_ID = `${os.hostname()}_${process.pid}`;
const MAX_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function claimOneTask(pool) {
  const [rows] = await pool.execute(
    `SELECT id, task_id, report_id, status, attempts
     FROM damage_analysis_tasks
     WHERE status IN ('queued','failed')
       AND (locked_at IS NULL OR locked_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE))
     ORDER BY created_at ASC
     LIMIT 1`
  );
  if (!rows.length) return null;
  const t = rows[0];
  const [res] = await pool.execute(
    `UPDATE damage_analysis_tasks
     SET status = 'running', locked_at = NOW(), locked_by = ?
     WHERE id = ?
       AND status IN ('queued','failed')
       AND (locked_at IS NULL OR locked_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE))`,
    [WORKER_ID, t.id]
  );
  if (!res.affectedRows) return null;
  return { ...t, attempts: parseInt(t.attempts, 10) || 0 };
}

async function loadReport(pool, reportId) {
  const [rows] = await pool.execute(
    `SELECT report_id, user_id, vehicle_info, images, user_description, analysis_attempts
     FROM damage_reports
     WHERE report_id = ?
     LIMIT 1`,
    [reportId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  const images = typeof r.images === 'string' ? JSON.parse(r.images || '[]') : (r.images || []);
  const vehicleInfo = typeof r.vehicle_info === 'string' ? JSON.parse(r.vehicle_info || '{}') : (r.vehicle_info || {});
  return {
    report_id: r.report_id,
    user_id: r.user_id,
    vehicleInfo,
    images,
    user_description: r.user_description || '',
    analysis_attempts: parseInt(r.analysis_attempts, 10) || 0,
  };
}

async function setBiddingsDistributionStatus(pool, reportId, status) {
  await pool.execute(
    `UPDATE biddings SET distribution_status = ?
     WHERE report_id = ? AND status = 0`,
    [status, reportId]
  );
}

async function distributePendingBiddings(pool, reportId) {
  const [rows] = await pool.execute(
    `SELECT bidding_id FROM biddings
     WHERE report_id = ? AND status = 0 AND (distribution_status IS NULL OR distribution_status = 'pending')`,
    [reportId]
  );
  for (const r of rows || []) {
    const bid = r.bidding_id;
    try {
      await biddingDistribution.runBiddingDistribution(pool, bid);
      await pool.execute('UPDATE biddings SET distribution_status = ? WHERE bidding_id = ?', ['done', bid]);
      console.log('[damage-worker] distributed bidding', bid);
    } catch (e) {
      console.warn('[damage-worker] distribute failed', bid, e.message);
      await pool.execute('UPDATE biddings SET distribution_status = ? WHERE bidding_id = ?', ['pending', bid]);
    }
  }
}

async function runOne(pool) {
  const task = await claimOneTask(pool);
  if (!task) return false;

  const report = await loadReport(pool, task.report_id);
  if (!report) {
    await pool.execute(
      `UPDATE damage_analysis_tasks SET status='failed', attempts=attempts+1, last_error=?, locked_at=NULL, locked_by=NULL WHERE id=?`,
      ['report_not_found', task.id]
    );
    return true;
  }

  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const apiKey = (process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '').trim();
  const nextAttempt = Math.max(report.analysis_attempts, task.attempts) + 1;
  try {
    const analysisRaw = await qwenAnalyzer.analyzeWithQwen(report.images, report.vehicleInfo, report.report_id, apiKey, report.user_description);
    const afterRiskFallback = applySupplementaryRiskFallback(analysisRaw, report.user_description || '', report.vehicleInfo);
    const enhanced = enhanceAnalysisWithKnowledge(afterRiskFallback);
    enhanced.report_id = report.report_id;
    const toStore = sanitizeAnalysisResultForRead(enhanced);
    enrichAnalysisResultHumanDisplay(toStore);
    if (toStore && typeof toStore === 'object' && '_analysis_source' in toStore) {
      delete toStore._analysis_source;
    }

    const repairRelated = typeof enhanced.repair_related === 'boolean' ? enhanced.repair_related : true;
    const relevance = repairRelated ? 'relevant' : 'irrelevant';
    const rejectReason =
      !repairRelated
        ? (typeof enhanced.repair_related_reason === 'string' && enhanced.repair_related_reason.trim()
          ? enhanced.repair_related_reason.trim().slice(0, 200)
          : '图片与修车无关')
        : null;
    if (!repairRelated && toStore && typeof toStore === 'object') {
      toStore.repair_related = false;
      if (rejectReason) toStore.repair_related_reason = rejectReason;
    }

    if (repairRelated) {
      await pool.execute(
        `UPDATE damage_reports
         SET analysis_result=?, analysis_relevance=?, analysis_attempts=?, analysis_error=NULL, status=1, updated_at=NOW()
         WHERE report_id=?`,
        [JSON.stringify(toStore), relevance, nextAttempt, report.report_id]
      );
      await pool.execute(
        `UPDATE damage_analysis_tasks
         SET status='done', attempts=?, last_error=NULL, locked_at=NULL, locked_by=NULL, updated_at=NOW()
         WHERE id=?`,
        [nextAttempt, task.id]
      );
      await distributePendingBiddings(pool, report.report_id);
      return true;
    }

    // irrelevant：拒绝分发
    await pool.execute(
      `UPDATE damage_reports
       SET analysis_result=?, analysis_relevance=?, analysis_attempts=?, analysis_error=NULL, status=3, updated_at=NOW()
       WHERE report_id=?`,
      [JSON.stringify(toStore), relevance, nextAttempt, report.report_id]
    );
    await pool.execute(
      `UPDATE damage_analysis_tasks
       SET status='done', attempts=?, last_error=NULL, locked_at=NULL, locked_by=NULL, updated_at=NOW()
       WHERE id=?`,
      [nextAttempt, task.id]
    );
    await setBiddingsDistributionStatus(pool, report.report_id, 'rejected');
    console.log('[damage-worker] rejected report', report.report_id, rejectReason || '');
    return true;
  } catch (e) {
    const msg = String(e && e.message ? e.message : 'qwen_error').slice(0, 255);
    await pool.execute(
      `UPDATE damage_reports
       SET analysis_attempts=?, analysis_error=?, status=0, updated_at=NOW()
       WHERE report_id=?`,
      [nextAttempt, msg, report.report_id]
    );

    if (nextAttempt >= MAX_ATTEMPTS) {
      await pool.execute(
        `UPDATE damage_reports SET status=4, analysis_relevance='unknown', updated_at=NOW() WHERE report_id=?`,
        [report.report_id]
      );
      await pool.execute(
        `UPDATE damage_analysis_tasks
         SET status='manual_review', attempts=?, last_error=?, locked_at=NULL, locked_by=NULL, updated_at=NOW()
         WHERE id=?`,
        [nextAttempt, msg, task.id]
      );
      await setBiddingsDistributionStatus(pool, report.report_id, 'manual_review');
      console.warn('[damage-worker] manual_review report', report.report_id, msg);
    } else {
      await pool.execute(
        `UPDATE damage_analysis_tasks
         SET status='failed', attempts=?, last_error=?, locked_at=NULL, locked_by=NULL, updated_at=NOW()
         WHERE id=?`,
        [nextAttempt, msg, task.id]
      );
      await setBiddingsDistributionStatus(pool, report.report_id, 'pending');
      console.warn('[damage-worker] failed attempt', nextAttempt, report.report_id, msg);
    }
    return true;
  }
}

async function main() {
  const once = process.argv.includes('--once');
  const loop = process.argv.includes('--loop') || !once;
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'zhejian',
    connectionLimit: 4,
  });

  try {
    if (once) {
      const worked = await runOne(pool);
      process.exit(worked ? 0 : 2);
    }
    while (loop) {
      const worked = await runOne(pool);
      if (!worked) {
        await sleep(1500);
      }
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

