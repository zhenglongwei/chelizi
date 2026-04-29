const crypto = require('crypto');
const { hasColumn } = require('../utils/db-utils');

function nowEventId(prefix) {
  return prefix + '_' + crypto.randomBytes(12).toString('hex');
}

async function logEvent(pool, orderId, actorType, actorId, eventType, payload) {
  try {
    if (!(await hasColumn(pool, 'order_lifecycle_events', 'event_id'))) return;
    const eid = nowEventId('ole');
    await pool.execute(
      `INSERT INTO order_lifecycle_events (event_id, order_id, actor_type, actor_id, event_type, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [eid, orderId, actorType, actorId || null, eventType, payload != null ? JSON.stringify(payload) : null]
    );
  } catch (e) {
    if (!String((e && e.message) || '').includes('order_lifecycle_events')) {
      console.warn('[order-lifecycle] logEvent failed:', e && e.message);
    }
  }
}

async function initOnOrderCreated(pool, orderId) {
  if (!(await hasColumn(pool, 'orders', 'lifecycle_main'))) return;
  // 选厂生成订单后：进入「待到店」窗口；48h 无到店/无进展则自动取消（对齐文档摘要）
  await pool.execute(
    `UPDATE orders
     SET lifecycle_main = 'pending_arrival',
         lifecycle_sub = 'pending_arrival',
         lifecycle_started_at = NOW(),
         lifecycle_deadline_at = DATE_ADD(NOW(), INTERVAL 48 HOUR),
         updated_at = NOW()
     WHERE order_id = ?`,
    [orderId]
  );
  await logEvent(pool, orderId, 'system', null, 'init', { lifecycle_main: 'pending_arrival', deadline_hours: 48 });
}

async function ownerMarkArrived(pool, orderId, userId) {
  const [rows] = await pool.execute(
    `SELECT order_id, status, lifecycle_main, lifecycle_started_at, owner_arrived_at
     FROM orders WHERE order_id = ? AND user_id = ?`,
    [orderId, userId]
  );
  if (!rows.length) return { success: false, error: '订单不存在', statusCode: 404 };
  const o = rows[0];
  if (parseInt(o.status, 10) === 4) return { success: false, error: '订单已取消', statusCode: 400 };
  if (!(await hasColumn(pool, 'orders', 'owner_arrived_at'))) {
    return { success: false, error: '系统未启用到店流程字段', statusCode: 400 };
  }
  if (o.owner_arrived_at) return { success: true, data: { order_id: orderId, already: true } };
  // 文档约束：仅可使用 1 次，且需在接单/选定后 7 天内使用（用 lifecycle_started_at 兜底）
  if (o.lifecycle_started_at) {
    const started = new Date(o.lifecycle_started_at).getTime();
    if (started > 0 && Date.now() - started > 7 * 24 * 3600 * 1000) {
      return { success: false, error: '已超过可自助到店的时间窗口', statusCode: 400 };
    }
  }

  // 到店后：给服务商 24h 确认/推进，否则系统强推（后续定时任务处理）
  await pool.execute(
    `UPDATE orders
     SET owner_arrived_at = NOW(),
         lifecycle_main = 'pending_arrival',
         lifecycle_sub = 'owner_marked_arrived',
         lifecycle_started_at = NOW(),
         lifecycle_deadline_at = DATE_ADD(NOW(), INTERVAL 24 HOUR),
         updated_at = NOW()
     WHERE order_id = ?`,
    [orderId]
  );
  await logEvent(pool, orderId, 'user', userId, 'arrived', { next_deadline_hours: 24 });
  return { success: true, data: { order_id: orderId } };
}

async function merchantConfirmArrived(pool, orderId, shopId) {
  const [rows] = await pool.execute(
    `SELECT order_id, status, owner_arrived_at, shop_arrival_confirmed_at
     FROM orders WHERE order_id = ? AND shop_id = ?`,
    [orderId, shopId]
  );
  if (!rows.length) return { success: false, error: '订单不存在', statusCode: 404 };
  const o = rows[0];
  if (parseInt(o.status, 10) === 4) return { success: false, error: '订单已取消', statusCode: 400 };
  if (o.shop_arrival_confirmed_at) return { success: true, data: { order_id: orderId, already: true } };

  // 维修商可直接确认到店（若车主未点“我已到店”，则以维修商确认时间作为到店时间）
  if (!(await hasColumn(pool, 'orders', 'owner_arrived_at'))) {
    return { success: false, error: '系统未启用到店流程字段', statusCode: 400 };
  }
  if (!o.owner_arrived_at) {
    await pool.execute(`UPDATE orders SET owner_arrived_at = NOW(), updated_at = NOW() WHERE order_id = ?`, [orderId]);
    await logEvent(pool, orderId, 'merchant', String(shopId), 'arrived_filled_by_merchant', {});
  }

  // 确认到店后：进入「待拆解」窗口，默认 72h（更细分的 72h/96h 规则由定时任务/运营处理扩展）
  await pool.execute(
    `UPDATE orders
     SET shop_arrival_confirmed_at = NOW(),
         lifecycle_main = 'pending_disassembly',
         lifecycle_sub = 'pending_disassembly',
         lifecycle_started_at = NOW(),
         lifecycle_deadline_at = DATE_ADD(NOW(), INTERVAL 72 HOUR),
         updated_at = NOW()
     WHERE order_id = ?`,
    [orderId]
  );
  await logEvent(pool, orderId, 'merchant', String(shopId), 'arrival_confirmed', { next_deadline_hours: 72 });
  return { success: true, data: { order_id: orderId } };
}

async function systemAutoConfirmArrivedAfterOwnerMarked(pool) {
  if (!(await hasColumn(pool, 'orders', 'shop_arrival_confirmed_at'))) return { affected: 0 };
  const [rows] = await pool.execute(
    `SELECT order_id, shop_id
     FROM orders
     WHERE status != 4
       AND lifecycle_main = 'pending_arrival'
       AND lifecycle_sub = 'owner_marked_arrived'
       AND lifecycle_deadline_at IS NOT NULL
       AND lifecycle_deadline_at <= NOW()
       AND shop_arrival_confirmed_at IS NULL
       AND owner_arrived_at IS NOT NULL
     LIMIT 200`
  );
  let affected = 0;
  const pushed = [];
  for (const r of rows) {
    await pool.execute(
      `UPDATE orders
       SET shop_arrival_confirmed_at = NOW(),
           lifecycle_main = 'pending_disassembly',
           lifecycle_sub = 'pending_disassembly',
           lifecycle_started_at = NOW(),
           lifecycle_deadline_at = DATE_ADD(NOW(), INTERVAL 72 HOUR),
           updated_at = NOW()
       WHERE order_id = ?`,
      [r.order_id]
    );
    await logEvent(pool, r.order_id, 'system', null, 'arrival_confirmed_auto', { next_deadline_hours: 72 });
    affected++;
    pushed.push({ order_id: r.order_id, shop_id: r.shop_id });
  }
  return { affected, pushed };
}

async function markDisassemblyOverdue72h(pool) {
  if (!(await hasColumn(pool, 'orders', 'lifecycle_deadline_at'))) return { affected: 0 };
  const [rows] = await pool.execute(
    `SELECT order_id, shop_id
     FROM orders
     WHERE status != 4
       AND lifecycle_main = 'pending_disassembly'
       AND lifecycle_sub = 'pending_disassembly'
       AND lifecycle_deadline_at IS NOT NULL
       AND lifecycle_deadline_at <= NOW()
     LIMIT 200`
  );
  let affected = 0;
  const overdue = [];
  for (const r of rows) {
    await pool.execute(
      `UPDATE orders SET lifecycle_sub = 'disassembly_overdue_72h', updated_at = NOW() WHERE order_id = ?`,
      [r.order_id]
    );
    await logEvent(pool, r.order_id, 'system', null, 'disassembly_overdue_72h', { penalty_points: -10 });
    affected++;
    overdue.push({ order_id: r.order_id, shop_id: r.shop_id });
  }
  return { affected, overdue };
}

async function markDisassemblyOverdue96h(pool) {
  if (!(await hasColumn(pool, 'orders', 'lifecycle_started_at'))) return { affected: 0 };
  const [rows] = await pool.execute(
    `SELECT order_id, shop_id
     FROM orders
     WHERE status != 4
       AND lifecycle_main = 'pending_disassembly'
       AND lifecycle_started_at IS NOT NULL
       AND lifecycle_started_at <= DATE_SUB(NOW(), INTERVAL 96 HOUR)
       AND lifecycle_sub IN ('pending_disassembly','disassembly_overdue_72h')
     LIMIT 200`
  );
  let affected = 0;
  const overdue = [];
  for (const r of rows) {
    await pool.execute(
      `UPDATE orders SET lifecycle_sub = 'disassembly_overdue_96h', updated_at = NOW() WHERE order_id = ?`,
      [r.order_id]
    );
    await logEvent(pool, r.order_id, 'system', null, 'disassembly_overdue_96h', { penalty_points: -15, compensation_amount: 150 });
    affected++;
    overdue.push({ order_id: r.order_id, shop_id: r.shop_id });
  }
  return { affected, overdue };
}

async function syncPendingDecisionFromFinalQuote(pool) {
  if (!(await hasColumn(pool, 'orders', 'final_quote_status'))) return { affected: 0 };
  const [rows] = await pool.execute(
    `SELECT order_id, final_quote_submitted_at
     FROM orders
     WHERE status != 4
       AND final_quote_status = 1
       AND (lifecycle_main IS NULL OR lifecycle_main != 'pending_decision')`
  );
  let affected = 0;
  for (const r of rows) {
    const start = r.final_quote_submitted_at ? new Date(r.final_quote_submitted_at) : null;
    await pool.execute(
      `UPDATE orders
       SET lifecycle_main = 'pending_decision',
           lifecycle_sub = 'pending_decision',
           lifecycle_started_at = ${start ? '?' : 'NOW()'},
           lifecycle_deadline_at = DATE_ADD(${start ? '?' : 'NOW()'}, INTERVAL 48 HOUR),
           updated_at = NOW()
       WHERE order_id = ?`,
      start ? [start, start, r.order_id] : [r.order_id]
    );
    await logEvent(pool, r.order_id, 'system', null, 'enter_pending_decision', { deadline_hours: 48 });
    affected++;
  }
  return { affected };
}

async function cancelDecisionOverdue72h(pool) {
  if (!(await hasColumn(pool, 'orders', 'lifecycle_started_at'))) return { affected: 0 };
  const [rows] = await pool.execute(
    `SELECT order_id, bidding_id, shop_id
     FROM orders
     WHERE status != 4
       AND lifecycle_main = 'pending_decision'
       AND lifecycle_started_at IS NOT NULL
       AND lifecycle_started_at <= DATE_SUB(NOW(), INTERVAL 72 HOUR)
     LIMIT 200`
  );
  let affected = 0;
  const cancelled = [];
  for (const r of rows) {
    await pool.execute(
      `UPDATE orders SET status = 4, lifecycle_main = 'cancelled', lifecycle_sub = 'decision_timeout_cancel', updated_at = NOW() WHERE order_id = ?`,
      [r.order_id]
    );
    if (r.bidding_id) {
      await pool.execute(`UPDATE biddings SET status = 0, selected_shop_id = NULL, updated_at = NOW() WHERE bidding_id = ?`, [r.bidding_id]);
    }
    await logEvent(pool, r.order_id, 'system', null, 'decision_timeout_cancel', { from: 'pending_decision' });
    affected++;
    cancelled.push({ order_id: r.order_id, shop_id: r.shop_id });
  }
  return { affected, cancelled };
}

async function markPendingDeliveryFromStatus2(pool) {
  if (!(await hasColumn(pool, 'orders', 'delivery_confirmed_at'))) return { affected: 0 };
  const [rows] = await pool.execute(
    `SELECT order_id
     FROM orders
     WHERE status = 2
       AND (lifecycle_main IS NULL OR lifecycle_main != 'pending_delivery')
     LIMIT 200`
  );
  let affected = 0;
  for (const r of rows) {
    await pool.execute(
      `UPDATE orders
       SET lifecycle_main = 'pending_delivery',
           lifecycle_sub = 'pending_delivery',
           lifecycle_started_at = NOW(),
           lifecycle_deadline_at = DATE_ADD(NOW(), INTERVAL 48 HOUR),
           updated_at = NOW()
       WHERE order_id = ?`,
      [r.order_id]
    );
    await logEvent(pool, r.order_id, 'system', null, 'enter_pending_delivery', { deadline_hours: 48 });
    affected++;
  }
  return { affected };
}

async function autoConfirmDeliveryAfter48h(pool) {
  if (!(await hasColumn(pool, 'orders', 'lifecycle_deadline_at'))) return { affected: 0, autoConfirmed: [] };
  const [rows] = await pool.execute(
    `SELECT order_id
     FROM orders
     WHERE status = 2
       AND lifecycle_main = 'pending_delivery'
       AND lifecycle_deadline_at IS NOT NULL
       AND lifecycle_deadline_at <= NOW()
     LIMIT 200`
  );
  let affected = 0;
  const autoConfirmed = [];
  for (const r of rows) {
    autoConfirmed.push({ order_id: r.order_id });
    affected++;
  }
  return { affected, autoConfirmed };
}

async function enterPendingReview(pool, orderId) {
  if (!(await hasColumn(pool, 'orders', 'review_due_at'))) return;
  await pool.execute(
    `UPDATE orders
     SET lifecycle_main = 'pending_review',
         lifecycle_sub = 'pending_review',
         lifecycle_started_at = NOW(),
         review_due_at = DATE_ADD(NOW(), INTERVAL 7 DAY),
         lifecycle_deadline_at = DATE_ADD(NOW(), INTERVAL 7 DAY),
         updated_at = NOW()
     WHERE order_id = ?`,
    [orderId]
  );
  await logEvent(pool, orderId, 'system', null, 'enter_pending_review', { deadline_days: 7 });
}

async function autoCloseReviewAfter7d(pool) {
  if (!(await hasColumn(pool, 'orders', 'review_due_at'))) return { affected: 0 };
  const [rows] = await pool.execute(
    `SELECT order_id
     FROM orders
     WHERE status = 3
       AND review_due_at IS NOT NULL
       AND review_due_at <= NOW()
       AND (lifecycle_main IS NULL OR lifecycle_main != 'completed')
     LIMIT 200`
  );
  let affected = 0;
  for (const r of rows) {
    await pool.execute(
      `UPDATE orders
       SET lifecycle_main = 'completed',
           lifecycle_sub = 'auto_closed_no_review',
           appeal_until = DATE_ADD(NOW(), INTERVAL 15 DAY),
           updated_at = NOW()
       WHERE order_id = ?`,
      [r.order_id]
    );
    await logEvent(pool, r.order_id, 'system', null, 'auto_close_no_review', {});
    affected++;
  }
  return { affected };
}

async function markZombieOrders15d(pool) {
  if (!(await hasColumn(pool, 'orders', 'lifecycle_main'))) return { affected: 0 };
  const [rows] = await pool.execute(
    `SELECT order_id
     FROM orders
     WHERE status != 4
       AND status != 3
       AND updated_at <= DATE_SUB(NOW(), INTERVAL 15 DAY)
       AND (lifecycle_sub IS NULL OR lifecycle_sub NOT IN ('zombie_marked','zombie_cancelled'))
       AND NOT (status = 1 AND promised_delivery_at IS NOT NULL AND promised_delivery_at > NOW())
     LIMIT 200`
  );
  let affected = 0;
  for (const r of rows) {
    await pool.execute(
      `UPDATE orders
       SET lifecycle_sub = 'zombie_marked',
           lifecycle_deadline_at = DATE_ADD(NOW(), INTERVAL 24 HOUR),
           updated_at = NOW()
       WHERE order_id = ?`,
      [r.order_id]
    );
    await logEvent(pool, r.order_id, 'system', null, 'zombie_marked', { cancel_in_hours: 24 });
    affected++;
  }
  return { affected };
}

async function cancelZombieOrdersAfter24h(pool) {
  if (!(await hasColumn(pool, 'orders', 'lifecycle_deadline_at'))) return { affected: 0, cancelled: [] };
  const [rows] = await pool.execute(
    `SELECT order_id, bidding_id, user_id, shop_id
     FROM orders
     WHERE status != 4
       AND lifecycle_sub = 'zombie_marked'
       AND lifecycle_deadline_at IS NOT NULL
       AND lifecycle_deadline_at <= NOW()
     LIMIT 200`
  );
  let affected = 0;
  const cancelled = [];
  for (const r of rows) {
    await pool.execute(
      `UPDATE orders
       SET status = 4,
           lifecycle_main = 'cancelled',
           lifecycle_sub = 'zombie_cancelled',
           updated_at = NOW()
       WHERE order_id = ?`,
      [r.order_id]
    );
    if (r.bidding_id) {
      await pool.execute(`UPDATE biddings SET status = 0, selected_shop_id = NULL, updated_at = NOW() WHERE bidding_id = ?`, [r.bidding_id]);
    }
    await logEvent(pool, r.order_id, 'system', null, 'zombie_cancelled', {});
    affected++;
    cancelled.push({ order_id: r.order_id, user_id: r.user_id, shop_id: r.shop_id });
  }
  return { affected, cancelled };
}
async function timeoutCancelPendingArrival(pool, now = null) {
  if (!(await hasColumn(pool, 'orders', 'lifecycle_deadline_at'))) return { affected: 0 };
  const [rows] = await pool.execute(
    `SELECT order_id, bidding_id, user_id, shop_id
     FROM orders
     WHERE status != 4
       AND lifecycle_main = 'pending_arrival'
       AND lifecycle_sub = 'pending_arrival'
       AND lifecycle_deadline_at IS NOT NULL
       AND lifecycle_deadline_at <= ${now ? '?' : 'NOW()'}`,
    now ? [now] : []
  );
  let affected = 0;
  const cancelled = [];
  for (const r of rows) {
    await pool.execute(`UPDATE orders SET status = 4, lifecycle_main = 'cancelled', lifecycle_sub = 'timeout_cancel', updated_at = NOW() WHERE order_id = ?`, [r.order_id]);
    if (r.bidding_id) {
      await pool.execute(`UPDATE biddings SET status = 0, selected_shop_id = NULL, updated_at = NOW() WHERE bidding_id = ?`, [r.bidding_id]);
    }
    await logEvent(pool, r.order_id, 'system', null, 'timeout_cancel', { from: 'pending_arrival' });
    affected++;
    cancelled.push({ order_id: r.order_id, bidding_id: r.bidding_id, user_id: r.user_id, shop_id: r.shop_id });
  }
  return { affected, cancelled };
}

async function ownerClaimMerchantNotHandled(pool, orderId, userId, payload) {
  const [rows] = await pool.execute(
    `SELECT order_id, status, shop_id, lifecycle_main, lifecycle_started_at, owner_arrived_at, shop_arrival_confirmed_at
     FROM orders WHERE order_id = ? AND user_id = ?`,
    [orderId, userId]
  );
  if (!rows.length) return { success: false, error: '订单不存在', statusCode: 404 };
  const o = rows[0];
  if (parseInt(o.status, 10) === 4) return { success: false, error: '订单已取消', statusCode: 400 };
  if (o.lifecycle_main !== 'pending_disassembly') return { success: false, error: '当前状态不可使用该入口', statusCode: 400 };
  if (!o.owner_arrived_at || !o.shop_arrival_confirmed_at) return { success: false, error: '请先完成到店确认', statusCode: 400 };
  // 文档：到店后48h未处理才可点
  const started = o.lifecycle_started_at ? new Date(o.lifecycle_started_at).getTime() : 0;
  if (started > 0 && Date.now() - started < 48 * 3600 * 1000) {
    return { success: false, error: '到店后未满 48 小时，暂不可使用该入口', statusCode: 400 };
  }
  if (!(await hasColumn(pool, 'orders', 'lifecycle_deadline_at'))) {
    return { success: false, error: '系统未启用生命周期字段', statusCode: 400 };
  }

  const note = payload && payload.note != null ? String(payload.note).trim() : '';
  const urlsRaw = payload && payload.image_urls;
  const urls = Array.isArray(urlsRaw) ? urlsRaw.map((u) => String(u || '').trim()).filter(Boolean) : [];

  // 记录自救请求（不依赖该表存在）
  try {
    if (await hasColumn(pool, 'order_self_help_requests', 'request_id')) {
      const reqId = 'oshr_' + crypto.randomBytes(12).toString('hex');
      await pool.execute(
        `INSERT INTO order_self_help_requests (request_id, order_id, user_id, request_type, note, image_urls, status)
         VALUES (?, ?, ?, 'merchant_not_handled', ?, ?, 'submitted')`,
        [reqId, orderId, userId, note || null, urls.length ? JSON.stringify(urls) : null]
      );
    }
  } catch (e) {
    if (!String((e && e.message) || '').includes('order_self_help_requests')) {
      console.warn('[order-lifecycle] save self-help request failed:', e && e.message);
    }
  }

  // 最后通牒 24h：若仍不处理，则系统自动取消（定时任务执行）
  await pool.execute(
    `UPDATE orders
     SET lifecycle_main = 'pending_disassembly',
         lifecycle_sub = 'merchant_not_handled_claimed',
         lifecycle_started_at = NOW(),
         lifecycle_deadline_at = DATE_ADD(NOW(), INTERVAL 24 HOUR),
         updated_at = NOW()
     WHERE order_id = ?`,
    [orderId]
  );
  await logEvent(pool, orderId, 'user', userId, 'merchant_not_handled_claimed', { next_deadline_hours: 24, note, image_count: urls.length });
  return { success: true, data: { order_id: orderId } };
}

async function cancelAfterMerchantNotHandledClaim(pool) {
  if (!(await hasColumn(pool, 'orders', 'lifecycle_deadline_at'))) return { affected: 0, cancelled: [] };
  const [rows] = await pool.execute(
    `SELECT order_id, bidding_id, user_id, shop_id
     FROM orders
     WHERE status != 4
       AND lifecycle_main = 'pending_disassembly'
       AND lifecycle_sub = 'merchant_not_handled_claimed'
       AND lifecycle_deadline_at IS NOT NULL
       AND lifecycle_deadline_at <= NOW()
     LIMIT 200`
  );
  let affected = 0;
  const cancelled = [];
  for (const r of rows) {
    await pool.execute(
      `UPDATE orders
       SET status = 4,
           lifecycle_main = 'cancelled',
           lifecycle_sub = 'merchant_not_handled_cancel',
           updated_at = NOW()
       WHERE order_id = ?`,
      [r.order_id]
    );
    if (r.bidding_id) {
      await pool.execute(`UPDATE biddings SET status = 0, selected_shop_id = NULL, updated_at = NOW() WHERE bidding_id = ?`, [r.bidding_id]);
    }
    await logEvent(pool, r.order_id, 'system', null, 'merchant_not_handled_cancel', { compensation_amount: 100, penalty_points: -10 });
    affected++;
    cancelled.push({ order_id: r.order_id, user_id: r.user_id, shop_id: r.shop_id });
  }
  return { affected, cancelled };
}

async function ownerForceCloseOrder(pool, orderId, userId, payload) {
  const [rows] = await pool.execute(
    `SELECT order_id, status, shop_id, lifecycle_main, lifecycle_started_at, promised_delivery_at
     FROM orders WHERE order_id = ? AND user_id = ?`,
    [orderId, userId]
  );
  if (!rows.length) return { success: false, error: '订单不存在', statusCode: 404 };
  const o = rows[0];
  if (parseInt(o.status, 10) === 4) return { success: false, error: '订单已取消', statusCode: 400 };
  // 仅允许：维修中/待交车阶段
  const st = parseInt(o.status, 10);
  if (![1, 2].includes(st)) return { success: false, error: '当前状态不可强制结单', statusCode: 400 };

  const urlsRaw = payload && payload.image_urls;
  const urls = Array.isArray(urlsRaw) ? urlsRaw.map((u) => String(u || '').trim()).filter(Boolean) : [];
  if (!urls.length) return { success: false, error: '请至少上传 1 张取车/车辆外观凭证图', statusCode: 400 };
  const note = payload && payload.note != null ? String(payload.note).trim() : '';

  // 文档：超承诺交车 7 天后可强制结单；这里用 promised_delivery_at 或 pending_delivery 起算兜底
  let ok = false;
  if (o.promised_delivery_at) {
    const t = new Date(o.promised_delivery_at).getTime();
    if (t > 0 && Date.now() - t >= 7 * 24 * 3600 * 1000) ok = true;
  }
  if (!ok && o.lifecycle_main === 'pending_delivery' && o.lifecycle_started_at) {
    const t = new Date(o.lifecycle_started_at).getTime();
    if (t > 0 && Date.now() - t >= 7 * 24 * 3600 * 1000) ok = true;
  }
  if (!ok) {
    return { success: false, error: '未达到强制结单条件（需超承诺交车 7 天）', statusCode: 400 };
  }

  // 留痕自救请求
  try {
    if (await hasColumn(pool, 'order_self_help_requests', 'request_id')) {
      const reqId = 'oshr_' + crypto.randomBytes(12).toString('hex');
      await pool.execute(
        `INSERT INTO order_self_help_requests (request_id, order_id, user_id, request_type, note, image_urls, status)
         VALUES (?, ?, ?, 'force_close', ?, ?, 'approved')`,
        [reqId, orderId, userId, note || null, JSON.stringify(urls)]
      );
    }
  } catch (e) {
    if (!String((e && e.message) || '').includes('order_self_help_requests')) {
      console.warn('[order-lifecycle] save force_close request failed:', e && e.message);
    }
  }

  // 直接进入待评价（status=3），并设置评价/申诉窗口
  if (!(await hasColumn(pool, 'orders', 'review_due_at'))) {
    return { success: false, error: '系统未启用评价窗口字段', statusCode: 400 };
  }
  await pool.execute(
    `UPDATE orders
     SET status = 3,
         completed_at = NOW(),
         delivery_confirmed_at = NOW(),
         lifecycle_main = 'pending_review',
         lifecycle_sub = 'force_closed',
         lifecycle_started_at = NOW(),
         review_due_at = DATE_ADD(NOW(), INTERVAL 7 DAY),
         appeal_until = DATE_ADD(NOW(), INTERVAL 15 DAY),
         updated_at = NOW()
     WHERE order_id = ?`,
    [orderId]
  );
  await logEvent(pool, orderId, 'user', userId, 'force_close', { image_count: urls.length, penalty_points: -15, note });
  try {
    const systemViolation = require('./system-violation-service');
    if (o.shop_id) await systemViolation.recordSystemViolation(pool, o.shop_id, orderId, 'delivery_overdue_force_close', 15);
  } catch (_) {}
  return { success: true, data: { order_id: orderId } };
}

module.exports = {
  initOnOrderCreated,
  ownerMarkArrived,
  merchantConfirmArrived,
  timeoutCancelPendingArrival,
  systemAutoConfirmArrivedAfterOwnerMarked,
  markDisassemblyOverdue72h,
  markDisassemblyOverdue96h,
  syncPendingDecisionFromFinalQuote,
  cancelDecisionOverdue72h,
  markPendingDeliveryFromStatus2,
  autoConfirmDeliveryAfter48h,
  enterPendingReview,
  autoCloseReviewAfter7d,
  ownerClaimMerchantNotHandled,
  cancelAfterMerchantNotHandledClaim,
  ownerForceCloseOrder,
  markZombieOrders15d,
  cancelZombieOrdersAfter24h,
};

