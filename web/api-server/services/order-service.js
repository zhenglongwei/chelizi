/**
 * 订单服务
 * 用户端：取消、确认完成、撤单申请、提交人工、维修方案确认
 * 服务商端：接单、更新状态（维修中→待确认，含维修凭证）、修改维修方案
 * 按《订单撤单与维修完成流程.md》《维修方案调整与确认流程.md》
 */

const crypto = require('crypto');
const CANCEL_30_MIN_MS = 30 * 60 * 1000;

function validateCompletionEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return { ok: false, msg: '请上传维修完成凭证' };
  const repair = evidence.repair_photos;
  const settlement = evidence.settlement_photos;
  const material = evidence.material_photos;
  const arr = (v) => (Array.isArray(v) ? v : []);
  if (arr(repair).length < 1) return { ok: false, msg: '请上传至少 1 张修复后照片' };
  if (arr(settlement).length < 1) return { ok: false, msg: '请上传至少 1 张定损单或结算单照片' };
  if (arr(material).length < 1) return { ok: false, msg: '请上传至少 1 张物料照片' };
  return { ok: true };
}

/**
 * 用户取消订单（直接撤销或创建撤单申请）
 * 未接单/接单≤30分钟：直接撤销
 * 接单>30分钟：创建撤单申请，需填写理由
 */
async function cancelOrder(pool, orderId, userId, reason = '') {
  const [orders] = await pool.execute(
    'SELECT order_id, bidding_id, status, accepted_at FROM orders WHERE order_id = ? AND user_id = ?',
    [orderId, userId]
  );
  if (orders.length === 0) {
    return { success: false, error: '订单不存在', statusCode: 404 };
  }
  const order = orders[0];
  if (order.status === 3) {
    return { success: false, error: '订单已完成，无法撤销', statusCode: 400 };
  }
  if (order.status === 4) {
    return { success: false, error: '订单已取消', statusCode: 400 };
  }

  const needRequest = order.status >= 1 && order.accepted_at;
  let acceptedAt = order.accepted_at;
  if (acceptedAt && typeof acceptedAt === 'string') acceptedAt = new Date(acceptedAt);
  const within30 = needRequest && acceptedAt && (Date.now() - acceptedAt.getTime() <= CANCEL_30_MIN_MS);

  if (!needRequest || within30) {
    await doCancelOrder(pool, orderId, order.bidding_id);
    return { success: true, data: { order_id: orderId, direct: true } };
  }

  const reasonTrim = (reason || '').trim();
  if (!reasonTrim) {
    return { success: false, error: '接单超过 30 分钟，请填写撤单理由', statusCode: 400 };
  }

  const [existing] = await pool.execute(
    'SELECT request_id, status FROM order_cancel_requests WHERE order_id = ? AND status IN (0, 3)',
    [orderId]
  );
  if (existing.length > 0) {
    if (existing[0].status === 0) {
      return { success: false, error: '已有待处理的撤单申请', statusCode: 400 };
    }
    return { success: false, error: '已提交人工通道，请等待处理', statusCode: 400 };
  }

  const requestId = 'OCR' + Date.now();
  await pool.execute(
    'INSERT INTO order_cancel_requests (request_id, order_id, user_id, reason, status) VALUES (?, ?, ?, ?, 0)',
    [requestId, orderId, userId, reasonTrim]
  );
  return {
    success: true,
    data: { order_id: orderId, cancel_request_id: requestId, direct: false, status: 'pending' },
  };
}

async function doCancelOrder(pool, orderId, biddingId) {
  await pool.execute('UPDATE orders SET status = 4, updated_at = NOW() WHERE order_id = ?', [orderId]);
  if (biddingId) {
    await pool.execute(
      'UPDATE biddings SET status = 0, selected_shop_id = NULL, updated_at = NOW() WHERE bidding_id = ?',
      [biddingId]
    );
  }
}

/**
 * 用户确认完成（维修厂完成后，用户确认，状态 2->3）
 */
async function confirmOrder(pool, orderId, userId) {
  const [orders] = await pool.execute(
    'SELECT order_id, status, quoted_amount, actual_amount, commission_rate FROM orders WHERE order_id = ? AND user_id = ?',
    [orderId, userId]
  );
  if (orders.length === 0) {
    return { success: false, error: '订单不存在', statusCode: 404 };
  }
  const order = orders[0];
  if (order.status !== 2) {
    return { success: false, error: '当前状态不可确认完成', statusCode: 400 };
  }

  const amount = parseFloat(order.actual_amount || order.quoted_amount) || 0;
  const rate = (parseFloat(order.commission_rate) || 0) / 100;
  const commission = Math.round(amount * rate * 100) / 100;
  await pool.execute(
    'UPDATE orders SET status = 3, completed_at = NOW(), updated_at = NOW(), commission = ? WHERE order_id = ?',
    [commission, orderId]
  );
  return { success: true, data: { order_id: orderId } };
}

/**
 * 服务商接单（0->1），写入 accepted_at，复制 quote 到 repair_plan
 */
async function acceptOrder(pool, orderId, shopId) {
  const [orders] = await pool.execute(
    'SELECT order_id, status, quote_id FROM orders WHERE order_id = ? AND shop_id = ?',
    [orderId, shopId]
  );
  if (orders.length === 0) {
    return { success: false, error: '订单不存在', statusCode: 404 };
  }
  if (orders[0].status !== 0) {
    return { success: false, error: '该订单已接单或已结束', statusCode: 400 };
  }

  const hasRepairPlan = await hasColumn(pool, 'orders', 'repair_plan');
  let repairPlanJson = null;
  if (hasRepairPlan && orders[0].quote_id) {
    const [quotes] = await pool.execute(
      'SELECT amount, items, value_added_services, duration, warranty FROM quotes WHERE quote_id = ?',
      [orders[0].quote_id]
    );
    if (quotes.length > 0) {
      const q = quotes[0];
      const items = typeof q.items === 'string' ? JSON.parse(q.items || '[]') : (q.items || []);
      const valueAdded = typeof q.value_added_services === 'string' ? JSON.parse(q.value_added_services || '[]') : (q.value_added_services || []);
      repairPlanJson = JSON.stringify({
        items,
        value_added_services: valueAdded,
        amount: parseFloat(q.amount) || 0,
        duration: parseInt(q.duration, 10) || 3,
        warranty: parseInt(q.warranty, 10) || 12
      });
    }
  }

  const hasAcceptedAt = await hasColumn(pool, 'orders', 'accepted_at');
  if (hasRepairPlan && repairPlanJson) {
    await pool.execute(
      `UPDATE orders SET status = 1, accepted_at = NOW(), repair_plan = ?, repair_plan_status = 0, updated_at = NOW() WHERE order_id = ?`,
      [repairPlanJson, orderId]
    );
  } else if (hasAcceptedAt) {
    await pool.execute(
      'UPDATE orders SET status = 1, accepted_at = NOW(), updated_at = NOW() WHERE order_id = ?',
      [orderId]
    );
  } else {
    await pool.execute(
      'UPDATE orders SET status = 1, updated_at = NOW() WHERE order_id = ?',
      [orderId]
    );
  }
  return { success: true, data: { order_id: orderId } };
}

async function hasColumn(pool, table, col) {
  try {
    const [rows] = await pool.execute(
      `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, col]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * 服务商更新订单状态（维修中 1->待确认 2）
 * 1->2 时 completion_evidence 必传：repair_photos、settlement_photos、material_photos 各至少 1 张
 * 材料 AI 审核：数量校验通过后创建审核任务，status 保持 1，返回 auditing；后台 AI 通过则更新为 2
 * repair_plan_status=1（待车主确认）时不可点击维修完成
 */
async function updateOrderStatus(pool, orderId, shopId, targetStatus, completionEvidence) {
  const [orders] = await pool.execute(
    'SELECT order_id, status as current_status, repair_plan_status FROM orders WHERE order_id = ? AND shop_id = ?',
    [orderId, shopId]
  );
  if (orders.length === 0) {
    return { success: false, error: '订单不存在', statusCode: 404 };
  }

  const current = parseInt(orders[0].current_status, 10);
  const target = parseInt(targetStatus, 10);
  const repairPlanStatus = parseInt(orders[0].repair_plan_status, 10) || 0;

  if (current === 1 && target === 2) {
    if (repairPlanStatus === 1) {
      return { success: false, error: '请等待车主确认维修方案后再提交维修完成', statusCode: 400 };
    }
    const valid = validateCompletionEvidence(completionEvidence);
    if (!valid.ok) {
      return { success: false, error: valid.msg, statusCode: 400 };
    }

    const hasMaterialAuditTable = await hasTable(pool, 'material_audit_tasks');
    if (hasMaterialAuditTable) {
      const taskId = 'mat_' + crypto.randomBytes(12).toString('hex');
      const evidenceJson = JSON.stringify(completionEvidence || {});
      try {
        await pool.execute(
          `INSERT INTO material_audit_tasks (task_id, order_id, shop_id, completion_evidence, status)
           VALUES (?, ?, ?, ?, 'pending')`,
          [taskId, orderId, shopId, evidenceJson]
        );
        return {
          success: true,
          data: {
            order_id: orderId,
            status: 'auditing',
            task_id: taskId,
            message: '材料审核中，请稍后查看结果'
          }
        };
      } catch (err) {
        console.warn('[OrderService] 创建材料审核任务失败，回退为直接通过:', err.message);
      }
    }

    const evidenceJson = JSON.stringify(completionEvidence || {});
    const hasEvidence = await hasColumn(pool, 'orders', 'completion_evidence');
    if (hasEvidence) {
      await pool.execute(
        'UPDATE orders SET status = 2, completion_evidence = ?, updated_at = NOW() WHERE order_id = ?',
        [evidenceJson, orderId]
      );
    } else {
      await pool.execute(
        'UPDATE orders SET status = 2, updated_at = NOW() WHERE order_id = ?',
        [orderId]
      );
    }
    return { success: true, data: { order_id: orderId } };
  }
  return { success: false, error: '当前状态不可更新', statusCode: 400 };
}

async function hasTable(pool, tableName) {
  try {
    const [rows] = await pool.execute(
      `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [tableName]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * 服务商响应撤单申请（同意/拒绝）
 */
async function respondCancelRequest(pool, requestId, shopId, approve) {
  const [reqs] = await pool.execute(
    `SELECT r.request_id, r.order_id, r.status, o.shop_id, o.bidding_id
     FROM order_cancel_requests r
     INNER JOIN orders o ON r.order_id = o.order_id
     WHERE r.request_id = ? AND o.shop_id = ?`,
    [requestId, shopId]
  );
  if (reqs.length === 0) {
    return { success: false, error: '撤单申请不存在', statusCode: 404 };
  }
  const r = reqs[0];
  if (r.status !== 0) {
    return { success: false, error: '该申请已处理', statusCode: 400 };
  }

  const newStatus = approve ? 1 : 2;
  await pool.execute(
    'UPDATE order_cancel_requests SET status = ?, shop_response_at = NOW(), updated_at = NOW() WHERE request_id = ?',
    [newStatus, requestId]
  );

  if (approve) {
    await doCancelOrder(pool, r.order_id, r.bidding_id);
  }
  return {
    success: true,
    data: { request_id: requestId, approved: approve },
  };
}

/**
 * 校验维修方案调整：原 items 中已有项目的 parts_type 不可变更
 */
function validateRepairPlanPartsType(originalItems, newItems) {
  const orig = Array.isArray(originalItems) ? originalItems : [];
  const neu = Array.isArray(newItems) ? newItems : [];
  const origMap = {};
  orig.forEach((it) => {
    const part = (it.damage_part || it.name || it.item || '').trim();
    if (part) origMap[part] = it.parts_type;
  });
  for (const it of neu) {
    const part = (it.damage_part || it.name || it.item || '').trim();
    const origType = origMap[part];
    if (origType != null && origType !== undefined && String(origType).trim() !== '') {
      const newType = (it.parts_type || '').trim();
      if (newType !== String(origType).trim()) {
        return { ok: false, msg: `项目「${part}」的配件类型不可修改` };
      }
    }
  }
  return { ok: true };
}

/**
 * 服务商修改维修方案（仅 status=1 时可调用）
 */
async function updateRepairPlan(pool, orderId, shopId, body) {
  const [orders] = await pool.execute(
    'SELECT order_id, status, user_id, quote_id, repair_plan FROM orders WHERE order_id = ? AND shop_id = ?',
    [orderId, shopId]
  );
  if (orders.length === 0) {
    return { success: false, error: '订单不存在', statusCode: 404 };
  }
  const o = orders[0];
  if (parseInt(o.status, 10) !== 1) {
    return { success: false, error: '仅维修中订单可修改方案', statusCode: 400 };
  }

  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return { success: false, error: '维修项目不能为空', statusCode: 400 };
  }

  let originalItems = [];
  if (o.repair_plan) {
    try {
      const rp = typeof o.repair_plan === 'string' ? JSON.parse(o.repair_plan) : o.repair_plan;
      originalItems = rp.items || [];
    } catch (_) {}
  }
  if (originalItems.length === 0 && o.quote_id) {
    const [quotes] = await pool.execute('SELECT items FROM quotes WHERE quote_id = ?', [o.quote_id]);
    if (quotes.length > 0 && quotes[0].items) {
      try {
        originalItems = typeof quotes[0].items === 'string' ? JSON.parse(quotes[0].items || '[]') : (quotes[0].items || []);
      } catch (_) {}
    }
  }

  const valid = validateRepairPlanPartsType(originalItems, items);
  if (!valid.ok) {
    return { success: false, error: valid.msg, statusCode: 400 };
  }

  const valueAdded = body.value_added_services;
  const amount = parseFloat(body.amount);
  const duration = parseInt(body.duration, 10);
  const warranty = parseInt(body.warranty, 10);

  const repairPlan = {
    items,
    value_added_services: Array.isArray(valueAdded) ? valueAdded : [],
    amount: !Number.isNaN(amount) ? amount : null,
    duration: !Number.isNaN(duration) && duration > 0 ? duration : null,
    warranty: !Number.isNaN(warranty) && warranty > 0 ? warranty : null
  };

  const hasRepairPlan = await hasColumn(pool, 'orders', 'repair_plan');
  if (!hasRepairPlan) {
    return { success: false, error: '当前版本不支持维修方案调整', statusCode: 400 };
  }

  await pool.execute(
    'UPDATE orders SET repair_plan = ?, repair_plan_status = 1, repair_plan_adjusted_at = NOW(), updated_at = NOW() WHERE order_id = ?',
    [JSON.stringify(repairPlan), orderId]
  );

  const hasUserMessages = await hasColumn(pool, 'user_messages', 'message_id');
  if (hasUserMessages) {
    try {
      const msgId = 'umsg_' + crypto.randomBytes(12).toString('hex');
      await pool.execute(
        `INSERT INTO user_messages (message_id, user_id, type, title, content, related_id, is_read)
         VALUES (?, ?, 'order', '维修方案已更新', '服务商已调整维修方案，请前往订单详情确认。', ?, 0)`,
        [msgId, o.user_id, orderId]
      );
    } catch (msgErr) {
      console.warn('[OrderService] 创建车主消息失败:', msgErr && msgErr.message);
    }
  }

  return { success: true, data: { order_id: orderId } };
}

/**
 * 车主确认维修方案（同意/不同意）
 */
async function approveRepairPlan(pool, orderId, userId, approved) {
  const [orders] = await pool.execute(
    'SELECT order_id, status, user_id, repair_plan_status FROM orders WHERE order_id = ? AND user_id = ?',
    [orderId, userId]
  );
  if (orders.length === 0) {
    return { success: false, error: '订单不存在', statusCode: 404 };
  }
  const o = orders[0];
  if (parseInt(o.repair_plan_status, 10) !== 1) {
    return { success: false, error: '当前无待确认的维修方案', statusCode: 400 };
  }

  if (approved) {
    await pool.execute(
      'UPDATE orders SET repair_plan_status = 0, updated_at = NOW() WHERE order_id = ?',
      [orderId]
    );
    return { success: true, data: { order_id: orderId, approved: true } };
  }

  await pool.execute(
    'UPDATE orders SET repair_plan_status = 2, updated_at = NOW() WHERE order_id = ?',
    [orderId]
  );
  return { success: true, data: { order_id: orderId, approved: false }, msg: '如有疑问请联系客服' };
}

/**
 * 车主提交人工通道（服务商拒绝后）
 */
async function escalateCancelRequest(pool, requestId, userId) {
  const [reqs] = await pool.execute(
    'SELECT request_id, order_id, user_id, status FROM order_cancel_requests WHERE request_id = ?',
    [requestId]
  );
  if (reqs.length === 0) {
    return { success: false, error: '撤单申请不存在', statusCode: 404 };
  }
  const r = reqs[0];
  if (r.user_id !== userId) {
    return { success: false, error: '无权操作', statusCode: 403 };
  }
  if (r.status !== 2) {
    return { success: false, error: '仅服务商拒绝后可提交人工', statusCode: 400 };
  }

  await pool.execute(
    'UPDATE order_cancel_requests SET status = 3, escalated_at = NOW(), updated_at = NOW() WHERE request_id = ?',
    [requestId]
  );
  return { success: true, data: { request_id: requestId, status: 'escalated' } };
}

/**
 * 获取订单待处理的撤单申请（服务商用）
 */
async function getPendingCancelRequest(pool, orderId, shopId) {
  try {
    const [rows] = await pool.execute(
      `SELECT r.request_id, r.reason, r.created_at
       FROM order_cancel_requests r
       INNER JOIN orders o ON r.order_id = o.order_id
       WHERE r.order_id = ? AND o.shop_id = ? AND r.status = 0`,
      [orderId, shopId]
    );
    return rows.length > 0 ? rows[0] : null;
  } catch {
    return null;
  }
}

/**
 * 获取订单最新撤单申请（车主用，用于显示「提交人工」入口）
 */
async function getLatestCancelRequestForUser(pool, orderId, userId) {
  try {
    const [rows] = await pool.execute(
      'SELECT request_id, status, reason FROM order_cancel_requests WHERE order_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1',
      [orderId, userId]
    );
    return rows.length > 0 ? rows[0] : null;
  } catch {
    return null;
  }
}

/**
 * 后台：撤单申请列表（status=3 已提交人工）
 */
async function listCancelRequestsForAdmin(pool, status = 3) {
  try {
    const [rows] = await pool.execute(
      `SELECT r.request_id, r.order_id, r.user_id, r.reason, r.status, r.created_at, r.escalated_at,
        o.bidding_id, o.quoted_amount, o.status as order_status
       FROM order_cancel_requests r
       INNER JOIN orders o ON r.order_id = o.order_id
       WHERE r.status = ?
       ORDER BY r.escalated_at DESC, r.created_at DESC`,
      [status]
    );
    return rows || [];
  } catch {
    return [];
  }
}

/**
 * 后台：人工处理撤单申请（同意/拒绝）
 */
async function resolveCancelRequestByAdmin(pool, requestId, approve) {
  const [reqs] = await pool.execute(
    'SELECT r.request_id, r.order_id, r.status, o.bidding_id FROM order_cancel_requests r INNER JOIN orders o ON r.order_id = o.order_id WHERE r.request_id = ?',
    [requestId]
  );
  if (reqs.length === 0) {
    return { success: false, error: '撤单申请不存在', statusCode: 404 };
  }
  const r = reqs[0];
  if (r.status !== 3) {
    return { success: false, error: '仅已提交人工的申请可处理', statusCode: 400 };
  }

  const newStatus = approve ? 4 : 5;
  await pool.execute(
    'UPDATE order_cancel_requests SET status = ?, admin_resolution = ?, admin_resolved_at = NOW(), updated_at = NOW() WHERE request_id = ?',
    [newStatus, approve ? 'approved' : 'rejected', requestId]
  );

  if (approve) {
    await doCancelOrder(pool, r.order_id, r.bidding_id);
  }
  return { success: true, data: { request_id: requestId, approved: approve } };
}

module.exports = {
  cancelOrder,
  confirmOrder,
  acceptOrder,
  updateOrderStatus,
  updateRepairPlan,
  approveRepairPlan,
  respondCancelRequest,
  escalateCancelRequest,
  getPendingCancelRequest,
  getLatestCancelRequestForUser,
  listCancelRequestsForAdmin,
  resolveCancelRequestByAdmin,
};
