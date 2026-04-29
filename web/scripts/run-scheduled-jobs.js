#!/usr/bin/env node
/**
 * 定时任务入口（分钟/小时/每日）
 *
 * 用法：
 *   node web/scripts/run-scheduled-jobs.js --mode minute
 *   node web/scripts/run-scheduled-jobs.js --mode hourly
 *   node web/scripts/run-scheduled-jobs.js --mode daily
 */
const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');

const requireApi = createRequire(path.join(__dirname, '..', 'api-server', 'server.js'));
const mysql = requireApi('mysql2/promise');
requireApi('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const envApiServer = path.join(__dirname, '..', 'api-server', '.env');
if (fs.existsSync(envApiServer)) {
  requireApi('dotenv').config({ path: envApiServer, override: true });
}

const { hasColumn } = require('../api-server/utils/db-utils');
const orderLifecycle = require('../api-server/services/order-lifecycle-service');
const orderService = require('../api-server/services/order-service');
const systemViolation = require('../api-server/services/system-violation-service');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') args.mode = argv[++i];
  }
  return args;
}

async function insertUserMessage(pool, userId, title, content, relatedId) {
  if (!(await hasColumn(pool, 'user_messages', 'message_id'))) return;
  const crypto = require('crypto');
  const msgId = 'umsg_' + crypto.randomBytes(12).toString('hex');
  await pool.execute(
    `INSERT INTO user_messages (message_id, user_id, type, title, content, related_id, is_read)
     VALUES (?, ?, 'order', ?, ?, ?, 0)`,
    [msgId, userId, title, content, relatedId || null]
  );
}

async function insertMerchantMessageByShop(pool, shopId, title, content, relatedId) {
  try {
    if (!(await hasColumn(pool, 'merchant_messages', 'message_id'))) return;
    const [rows] = await pool.execute(
      'SELECT merchant_id FROM merchant_users WHERE shop_id = ? AND status = 1 LIMIT 1',
      [shopId]
    );
    if (!rows.length) return;
    const crypto = require('crypto');
    const msgId = 'mmsg_' + crypto.randomBytes(12).toString('hex');
    await pool.execute(
      `INSERT INTO merchant_messages (message_id, merchant_id, type, title, content, related_id, is_read)
       VALUES (?, ?, 'order', ?, ?, ?, 0)`,
      [msgId, rows[0].merchant_id, title, content, relatedId || null]
    );
  } catch (e) {
    if (!String((e && e.message) || '').includes('merchant_messages')) {
      console.warn('[scheduled-jobs] insertMerchantMessageByShop:', e && e.message);
    }
  }
}

async function runMinute(pool) {
  const out = {};

  // 状态2：待到店（48h 超时取消）
  const r0 = await orderLifecycle.timeoutCancelPendingArrival(pool);
  out.timeout_cancel_pending_arrival = r0.affected || 0;
  for (const it of r0.cancelled || []) {
    if (it.user_id) await insertUserMessage(pool, it.user_id, '订单取消', '待到店超时，系统已自动取消', it.order_id);
    if (it.shop_id) await insertMerchantMessageByShop(pool, it.shop_id, '订单取消', '待到店超时，系统已自动取消', it.order_id);
  }

  // 状态2：车主点“我已到店”后 24h 未确认 → 系统强推到店确认，进入待拆解
  const r1 = await orderLifecycle.systemAutoConfirmArrivedAfterOwnerMarked(pool);
  out.auto_confirm_arrived = r1.affected || 0;
  for (const it of r1.pushed || []) {
    if (it.shop_id) {
      await systemViolation.recordSystemViolation(pool, it.shop_id, it.order_id, 'arrival_confirm_timeout', 5);
    }
  }

  // 状态3：待拆解（72h 标记超时，96h 标记严重超时）
  const r2 = await orderLifecycle.markDisassemblyOverdue72h(pool);
  const r3 = await orderLifecycle.markDisassemblyOverdue96h(pool);
  out.disassembly_overdue_72h = r2.affected || 0;
  out.disassembly_overdue_96h = r3.affected || 0;
  for (const it of r2.overdue || []) {
    if (it.shop_id) await systemViolation.recordSystemViolation(pool, it.shop_id, it.order_id, 'disassembly_overdue_72h', 10);
  }
  for (const it of r3.overdue || []) {
    if (it.shop_id) await systemViolation.recordSystemViolation(pool, it.shop_id, it.order_id, 'disassembly_overdue_96h', 15);
  }

  // 自救：维修商未处理（最后通牒 24h 到期自动取消 + 留痕赔付）
  const r3b = await orderLifecycle.cancelAfterMerchantNotHandledClaim(pool);
  out.cancel_after_not_handled_claim = r3b.affected || 0;
  for (const it of r3b.cancelled || []) {
    if (it.shop_id) await systemViolation.recordSystemViolation(pool, it.shop_id, it.order_id, 'arrival_no_followup_48h', 10);
    if (it.user_id) await insertUserMessage(pool, it.user_id, '订单取消', '维修商超时未处理，系统已取消并按规则留痕处理', it.order_id);
    if (it.shop_id) await insertMerchantMessageByShop(pool, it.shop_id, '订单取消', '超时未处理，系统已自动取消本单', it.order_id);
  }

  // 状态4：待决策（final_quote_status=1 → 48h/72h）
  const r4 = await orderLifecycle.syncPendingDecisionFromFinalQuote(pool);
  const r5 = await orderLifecycle.cancelDecisionOverdue72h(pool);
  out.enter_pending_decision = r4.affected || 0;
  out.cancel_decision_overdue_72h = r5.affected || 0;

  // 状态6：待交车（status=2 → 48h 自动确认交车）
  const r6 = await orderLifecycle.markPendingDeliveryFromStatus2(pool);
  out.enter_pending_delivery = r6.affected || 0;
  const r7 = await orderLifecycle.autoConfirmDeliveryAfter48h(pool);
  out.auto_confirm_delivery_candidates = r7.affected || 0;
  let autoConfirmed = 0;
  for (const it of r7.autoConfirmed || []) {
    const r = await orderService.confirmOrderBySystem(pool, it.order_id);
    if (r && r.success) {
      autoConfirmed++;
      // 进入待评价（7天）
      await orderLifecycle.enterPendingReview(pool, it.order_id);
    }
  }
  out.auto_confirm_delivery_done = autoConfirmed;

  // 状态7：待评价（7天未评自动完结 + 15天申诉期）
  const r8 = await orderLifecycle.autoCloseReviewAfter7d(pool);
  out.auto_close_no_review = r8.affected || 0;

  return out;
}

async function runHourly(_pool) {
  const out = {};
  // 超承诺交车 48h：记录扣分（仅记录一次）
  try {
    const [rows] = await _pool.execute(
      `SELECT order_id, shop_id
       FROM orders
       WHERE status IN (1,2)
         AND promised_delivery_at IS NOT NULL
         AND promised_delivery_at <= DATE_SUB(NOW(), INTERVAL 48 HOUR)
       LIMIT 200`
    );
    let affected = 0;
    for (const r of rows) {
      if (r.shop_id) {
        await systemViolation.recordSystemViolation(_pool, r.shop_id, r.order_id, 'delivery_overdue_48h', 10);
        affected++;
      }
    }
    out.delivery_overdue_48h = affected;
  } catch (e) {
    out.delivery_overdue_48h = 0;
  }
  return out;
}

async function runDaily(pool) {
  const out = {};
  const r0 = await orderLifecycle.markZombieOrders15d(pool);
  out.zombie_marked = r0.affected || 0;
  const r1 = await orderLifecycle.cancelZombieOrdersAfter24h(pool);
  out.zombie_cancelled = r1.affected || 0;
  for (const it of r1.cancelled || []) {
    if (it.user_id) await insertUserMessage(pool, it.user_id, '订单取消', '订单长期未处理，系统已自动取消', it.order_id);
    if (it.shop_id) await insertMerchantMessageByShop(pool, it.shop_id, '订单取消', '订单长期未处理，系统已自动取消', it.order_id);
  }
  return out;
}

async function main() {
  const { mode } = parseArgs(process.argv);
  const m = (mode || '').trim();
  if (!m || !['minute', 'hourly', 'daily'].includes(m)) {
    console.error('Usage: node web/scripts/run-scheduled-jobs.js --mode minute|hourly|daily');
    process.exit(2);
  }

  const pool = await mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'zhejian',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });

  try {
    let out = {};
    if (m === 'minute') out = await runMinute(pool);
    else if (m === 'hourly') out = await runHourly(pool);
    else out = await runDaily(pool);
    console.log('[scheduled-jobs]', m, JSON.stringify(out));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[scheduled-jobs] fatal:', e);
    process.exit(1);
  });
}

