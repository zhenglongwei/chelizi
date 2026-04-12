/**
 * 订单服务
 * 用户端：取消、确认完成、撤单申请、提交人工、维修方案确认
 * 服务商端：接单、更新状态（维修中→待确认，含维修凭证）、修改维修方案
 * 按《订单撤单与维修完成流程.md》《维修方案调整与确认流程.md》
 */

const crypto = require('crypto');
const { recalculateOrderRewardPreview } = require('../reward-calculator');
const { hasColumn } = require('../utils/db-utils');
const oqp = require('./order-quote-proposal-service');
const { getShopNthQuoteLabel } = require('../utils/quote-nomenclature');
const quoteImportService = require('./quote-import-service');
const orderWarrantyCardService = require('./order-warranty-card-service');
const { partsTypesEquivalent } = require('../constants/parts-types');
const CANCEL_30_MIN_MS = 30 * 60 * 1000;

const PARTS_VERIFICATION_METHOD_KEYS = new Set([
  'official',
  'qr_scan',
  'face_to_face',
  'paper_proof',
  'other',
]);

function validateCompletionEvidence(evidence, opts = {}) {
  if (!evidence || typeof evidence !== 'object') return { ok: false, msg: '请上传维修完成凭证' };
  const repair = evidence.repair_photos;
  const settlement = evidence.settlement_photos;
  const material = evidence.material_photos;
  const arr = (v) => (Array.isArray(v) ? v : []);
  if (arr(repair).length < 1) return { ok: false, msg: '请上传至少 1 张修复后照片' };
  if (arr(settlement).length < 1) return { ok: false, msg: '请上传至少 1 张定损单或结算单照片' };
  if (arr(material).length < 1) return { ok: false, msg: '请上传至少 1 张物料照片' };
  if (opts.requireLeadTechnician) {
    const lt = evidence.lead_technician;
    if (!lt || typeof lt !== 'object' || !(String(lt.name || '').trim())) {
      return { ok: false, msg: '请选择或填写负责维修的技师或负责人' };
    }
  }
  if (opts.requirePartsVerification) {
    const pv = evidence.parts_verification;
    if (!pv || typeof pv !== 'object') {
      return { ok: false, msg: '请填写配件验真方式，或勾选「暂不填写验真说明」' };
    }
    if (pv.not_provided === true) {
      // 明确放弃填写
    } else {
      const methods = Array.isArray(pv.methods) ? pv.methods.filter((m) => PARTS_VERIFICATION_METHOD_KEYS.has(String(m))) : [];
      if (methods.length < 1) {
        return { ok: false, msg: '请至少选择一种配件验真方式，或勾选暂不填写' };
      }
      if (methods.includes('other')) {
        const note = String(pv.note || '').trim();
        if (note.length < 2) return { ok: false, msg: '选择「其他」时请简短说明验真方式' };
      }
    }
  }
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
    'SELECT order_id, shop_id, quote_id, status, quoted_amount, actual_amount, commission_rate FROM orders WHERE order_id = ? AND user_id = ?',
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

  try {
    const systemViolation = require('./system-violation-service');
    await systemViolation.checkAndRecordOrderViolations(pool, order);
  } catch (err) {
    console.error('[order-service] checkAndRecordOrderViolations error:', err.message);
  }

  let commissionSettlement = null;
  try {
    const commissionWallet = require('./commission-wallet-service');
    const [freshRows] = await pool.execute(
      `SELECT order_id, shop_id, commission_rate, quoted_amount, actual_amount, commission,
              is_insurance_accident
       FROM orders WHERE order_id = ?`,
      [orderId]
    );
    if (freshRows.length) {
      const fr = freshRows[0];
      const isInsurance = fr.is_insurance_accident === 1 || fr.is_insurance_accident === '1';
      if (isInsurance) {
        commissionSettlement = await commissionWallet.afterOrderCompleted(pool, fr);
      }
    }
  } catch (ce) {
    console.error('[order-service] commission settlement:', ce.message);
  }

  return { success: true, data: { order_id: orderId, commission_settlement: commissionSettlement } };
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
      'SELECT amount, items, value_added_services, duration FROM quotes WHERE quote_id = ?',
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
        duration: parseInt(q.duration, 10) || 3
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

/**
 * 服务商更新订单状态（维修中 1->待确认 2）
 * 1->2 时 completion_evidence 必传：repair_photos、settlement_photos、material_photos 各至少 1 张
 * 材料 AI 审核：数量校验通过后创建审核任务，status 保持 1，返回 auditing；后台 AI 通过则更新为 2
 * repair_plan_status=1（待车主确认）时不可点击维修完成
 */
async function resolveWarrantyCardTemplateId(pool, shopId, explicitFromBody, evidenceObj) {
  const fromEv = evidenceObj && evidenceObj.warranty_card_template_id != null
    ? evidenceObj.warranty_card_template_id
    : undefined;
  const raw = explicitFromBody != null ? explicitFromBody : fromEv;
  if (raw != null && raw !== '') {
    return orderWarrantyCardService.normalizeTemplateId(raw);
  }
  if (!(await hasColumn(pool, 'shops', 'warranty_card_template_id'))) {
    return 1;
  }
  const [shops] = await pool.execute(
    'SELECT warranty_card_template_id FROM shops WHERE shop_id = ? LIMIT 1',
    [shopId]
  );
  return orderWarrantyCardService.normalizeTemplateId(shops[0]?.warranty_card_template_id);
}

/**
 * @param {object|any} payload - completion_evidence 对象，或 { completion_evidence, warranty_card_template_id }
 */
async function updateOrderStatus(pool, orderId, shopId, targetStatus, payload) {
  let completionEvidence = payload;
  let warrantyCardTemplateIdFromBody = undefined;
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'completion_evidence' in payload) {
    completionEvidence = payload.completion_evidence;
    warrantyCardTemplateIdFromBody = payload.warranty_card_template_id;
  }
  const extCols = (await hasColumn(pool, 'orders', 'pre_quote_snapshot')) ? ', pre_quote_snapshot, final_quote_status' : '';
  const [orders] = await pool.execute(
    `SELECT order_id, status as current_status, repair_plan_status${extCols} FROM orders WHERE order_id = ? AND shop_id = ?`,
    [orderId, shopId]
  );
  if (orders.length === 0) {
    return { success: false, error: '订单不存在', statusCode: 404 };
  }

  const current = parseInt(orders[0].current_status, 10);
  const target = parseInt(targetStatus, 10);
  const repairPlanStatus = parseInt(orders[0].repair_plan_status, 10) || 0;
  const rawPre = orders[0].pre_quote_snapshot;
  const hasPreQuoteSnapshot = Boolean(extCols && rawPre != null && rawPre !== '');
  const finalQsRaw = orders[0].final_quote_status != null ? parseInt(orders[0].final_quote_status, 10) : 0;
  const finalQs = Number.isNaN(finalQsRaw) ? 0 : finalQsRaw;

  if (current === 1 && target === 2) {
    if (repairPlanStatus === 1) {
      return { success: false, error: '请等待车主确认维修方案后再提交维修完成', statusCode: 400 };
    }
    // 车主选厂即认可预报价：仅当服务商已提交「到店改价」且待车主确认（=1）时拦截完工；=0 以预报价为准、=2 已锁价均可完工
    if (hasPreQuoteSnapshot && finalQs === 1) {
      return { success: false, error: '请等待车主在小程序确认最终报价后再提交维修完成', statusCode: 400 };
    }
    const requireLt = hasPreQuoteSnapshot;
    const valid = validateCompletionEvidence(completionEvidence, {
      requireLeadTechnician: requireLt,
      requirePartsVerification: requireLt,
    });
    if (!valid.ok) {
      return { success: false, error: valid.msg, statusCode: 400 };
    }

    const templateIdResolved = await resolveWarrantyCardTemplateId(
      pool,
      shopId,
      warrantyCardTemplateIdFromBody,
      completionEvidence
    );
    const evidenceForStore = { ...(completionEvidence || {}) };
    evidenceForStore.warranty_card_template_id = templateIdResolved;

    const hasMaterialAuditTable = await hasTable(pool, 'material_audit_tasks');
    if (hasMaterialAuditTable) {
      const taskId = 'mat_' + crypto.randomBytes(12).toString('hex');
      const evidenceJson = JSON.stringify(evidenceForStore);
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

    let evidenceToStore = evidenceForStore;
    try {
      const { enrichCompletionEvidenceWithExteriorRepairAnalysis } = require('../utils/exterior-repair-at-completion');
      const { enrichCompletionEvidenceWithPartsTraceability } = require('../utils/parts-traceability-at-completion');
      const bu = process.env.BASE_URL || 'http://localhost:3000';
      evidenceToStore = await enrichCompletionEvidenceWithExteriorRepairAnalysis(pool, orderId, evidenceForStore, bu);
      evidenceToStore = await enrichCompletionEvidenceWithPartsTraceability(pool, orderId, evidenceToStore, bu);
    } catch (exErr) {
      console.warn('[OrderService] 完工 AI 增强写入失败:', exErr.message);
    }
    const evidenceJson = JSON.stringify(evidenceToStore);
    const hasEvidence = await hasColumn(pool, 'orders', 'completion_evidence');
    const hasOrderWct = await hasColumn(pool, 'orders', 'warranty_card_template_id');
    if (hasEvidence && hasOrderWct) {
      await pool.execute(
        'UPDATE orders SET status = 2, completion_evidence = ?, warranty_card_template_id = ?, updated_at = NOW() WHERE order_id = ?',
        [evidenceJson, templateIdResolved, orderId]
      );
    } else if (hasEvidence) {
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
      if (!partsTypesEquivalent(origType, newType)) {
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

  if (await hasColumn(pool, 'orders', 'pre_quote_snapshot')) {
    const [chk] = await pool.execute('SELECT pre_quote_snapshot FROM orders WHERE order_id = ?', [orderId]);
    if (chk.length && chk[0].pre_quote_snapshot != null) {
      return {
        success: false,
        error: '已启用双阶段报价：请使用「提交最终报价」调整项目与金额',
        statusCode: 400,
      };
    }
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

  const repairPlan = {
    items,
    value_added_services: Array.isArray(valueAdded) ? valueAdded : [],
    amount: !Number.isNaN(amount) ? amount : null,
    duration: !Number.isNaN(duration) && duration > 0 ? duration : null
  };

  const hasRepairPlan = await hasColumn(pool, 'orders', 'repair_plan');
  if (!hasRepairPlan) {
    return { success: false, error: '当前版本不支持维修方案调整', statusCode: 400 };
  }

  await pool.execute(
    'UPDATE orders SET repair_plan = ?, repair_plan_status = 1, repair_plan_adjusted_at = NOW(), updated_at = NOW() WHERE order_id = ?',
    [JSON.stringify(repairPlan), orderId]
  );

  try {
    await recalculateOrderRewardPreview(pool, orderId);
  } catch (e) {
    console.warn('[OrderService] updateRepairPlan reward preview:', e && e.message);
  }

  const hasUserMessages = await hasColumn(pool, 'user_messages', 'message_id');
  if (hasUserMessages) {
    try {
      const msgId = 'umsg_' + crypto.randomBytes(12).toString('hex');
      await pool.execute(
        `INSERT INTO user_messages (message_id, user_id, type, title, content, related_id, is_read)
         VALUES (?, ?, 'order', '维修方案已更新', '服务商已调整维修方案，请前往订单详情确认。', ?, 0)`,
        [msgId, o.user_id, orderId]
      );
      const subMsg = require('./subscribe-message-service');
      subMsg.sendToUser(
        pool,
        o.user_id,
        'user_order_update',
        { title: '方案待确认', content: '方案已调整，请确认', relatedId: orderId },
        process.env.WX_APPID,
        process.env.WX_SECRET
      ).catch(() => {});
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
    try {
      const [orderRows] = await pool.execute('SELECT shop_id FROM orders WHERE order_id = ?', [orderId]);
      if (orderRows.length > 0) {
        const [merchantRows] = await pool.execute(
          'SELECT merchant_id FROM merchant_users WHERE shop_id = ? AND status = 1 LIMIT 1',
          [orderRows[0].shop_id]
        );
        if (merchantRows.length > 0) {
          const subMsg = require('./subscribe-message-service');
          subMsg.sendToMerchant(
            pool,
            merchantRows[0].merchant_id,
            'merchant_order_new',
            { title: '方案已确认', content: '可继续维修完成', relatedId: orderId },
            process.env.WX_APPID,
            process.env.WX_SECRET
          ).catch((e) => console.warn('[OrderService] 维修方案确认订阅消息发送异常:', e));
        }
      }
    } catch (msgErr) {
      console.warn('[OrderService] 维修方案确认订阅消息失败:', msgErr && msgErr.message);
    }
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
/**
 * 服务商提交到店报价（车主确认前；有 order_quote_proposals 表时可多轮，每轮须证明材料）
 */
async function submitFinalQuote(pool, orderId, shopId, body) {
  if (!(await hasColumn(pool, 'orders', 'pre_quote_snapshot'))) {
    return { success: false, error: '当前服务端未升级双阶段报价字段', statusCode: 400 };
  }
  const useOqp = await oqp.proposalsTableExists(pool);
  const [orders] = await pool.execute(
    `SELECT order_id, status, user_id, is_insurance_accident, pre_quote_snapshot, final_quote_status FROM orders WHERE order_id = ? AND shop_id = ?`,
    [orderId, shopId]
  );
  if (orders.length === 0) {
    return { success: false, error: '订单不存在', statusCode: 404 };
  }
  const o = orders[0];
  if (parseInt(o.status, 10) !== 1) {
    return { success: false, error: '仅维修中可提交报价', statusCode: 400 };
  }
  if (o.pre_quote_snapshot == null) {
    return { success: false, error: '当前订单无预报价快照，无法提交到店报价', statusCode: 400 };
  }
  if (!useOqp && parseInt(o.final_quote_status, 10) === 2) {
    return { success: false, error: '已锁价，不可重复提交', statusCode: 400 };
  }

  const rawItems = body.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { success: false, error: '维修项目不能为空', statusCode: 400 };
  }
  const amount = parseFloat(body.amount);
  if (Number.isNaN(amount) || amount <= 0) {
    return { success: false, error: '金额无效', statusCode: 400 };
  }
  const duration = parseInt(body.duration, 10) || 3;
  const valueAdded = Array.isArray(body.value_added_services) ? body.value_added_services : [];

  const strict = quoteImportService.sanitizeQuoteItemsStrict(rawItems);
  if (!strict.ok) {
    return { success: false, error: strict.error, statusCode: 400 };
  }
  if (Math.abs(strict.sumPrice - amount) > 0.51) {
    return {
      success: false,
      error: `分项金额合计 ¥${strict.sumPrice} 与总报价 ¥${amount} 不一致，请核对`,
      statusCode: 400,
    };
  }
  const items = strict.items;

  const isIns = o.is_insurance_accident === 1 || o.is_insurance_accident === '1';

  const snap = {
    items,
    value_added_services: valueAdded,
    amount,
    duration
  };
  const snapJson = JSON.stringify(snap);

  if (useOqp) {
    const pend = await oqp.getPending(pool, orderId);
    if (pend) {
      return { success: false, error: '上一版报价待车主确认，请等待处理后再提交新报价', statusCode: 400 };
    }
    const evRes = oqp.normalizeEvidence(body, isIns);
    if (!evRes.ok) {
      return { success: false, error: evRes.error, statusCode: 400 };
    }
    const rev = await oqp.getNextRevisionNo(pool, orderId);
    const pid = 'oqp_' + crypto.randomBytes(12).toString('hex');
    const lossJson =
      isIns && evRes.evidence.loss_assessment_documents
        ? JSON.stringify(evRes.evidence.loss_assessment_documents)
        : null;

    await pool.execute(
      `INSERT INTO order_quote_proposals (proposal_id, order_id, shop_id, revision_no, quote_snapshot, evidence, status)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [pid, orderId, shopId, rev, snapJson, JSON.stringify(evRes.evidence)]
    );
    await pool.execute(
      `UPDATE orders SET final_quote_snapshot = ?, final_quote_status = 1, final_quote_submitted_at = NOW(),
       repair_plan = ?, loss_assessment_documents = ?, updated_at = NOW() WHERE order_id = ?`,
      [snapJson, snapJson, lossJson, orderId]
    );

    try {
      const hasUserMessages = await hasColumn(pool, 'user_messages', 'message_id');
      if (hasUserMessages) {
        const msgId = 'umsg_' + crypto.randomBytes(12).toString('hex');
        await pool.execute(
          `INSERT INTO user_messages (message_id, user_id, type, title, content, related_id, is_read)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
          [
            msgId,
            o.user_id,
            'order',
            '报价待确认',
            `服务商已提交${getShopNthQuoteLabel(rev)}（附证明材料），请前往订单详情确认。`,
            orderId,
          ]
        );
      }
    } catch (msgErr) {
      console.warn('[OrderService] 报价消息失败:', msgErr && msgErr.message);
    }

    try {
      await recalculateOrderRewardPreview(pool, orderId);
    } catch (e) {
      console.warn('[OrderService] submitFinalQuote reward preview:', e && e.message);
    }

    return {
      success: true,
      data: { order_id: orderId, final_quote_status: 1, revision_no: rev, proposal_id: pid },
    };
  }

  let lossDoc = body.loss_assessment_documents;
  if (isIns) {
    const urls = Array.isArray(lossDoc) ? lossDoc : lossDoc && lossDoc.urls;
    if (!Array.isArray(urls) || urls.length < 1) {
      return { success: false, error: '保险事故车须上传定损单等材料', statusCode: 400 };
    }
    lossDoc = lossDoc && typeof lossDoc === 'object' && !Array.isArray(lossDoc) ? { ...lossDoc } : { urls };
    if (!Array.isArray(lossDoc.urls)) lossDoc.urls = urls;
    const sup = String(body.supplement_note || '').trim();
    if (sup) lossDoc.supplement_note = sup;
  } else {
    lossDoc = lossDoc || null;
  }
  const lossJson = lossDoc ? JSON.stringify(lossDoc) : null;

  await pool.execute(
    `UPDATE orders SET final_quote_snapshot = ?, final_quote_status = 1, final_quote_submitted_at = NOW(),
     repair_plan = ?, loss_assessment_documents = ?, updated_at = NOW() WHERE order_id = ?`,
    [snapJson, snapJson, lossJson, orderId]
  );

  try {
    const hasUserMessages = await hasColumn(pool, 'user_messages', 'message_id');
    if (hasUserMessages) {
      const msgId = 'umsg_' + crypto.randomBytes(12).toString('hex');
      await pool.execute(
        `INSERT INTO user_messages (message_id, user_id, type, title, content, related_id, is_read)
         VALUES (?, ?, 'order', '最终报价待确认', '服务商已提交到店最终报价，请前往订单详情确认。', ?, 0)`,
        [msgId, o.user_id, orderId]
      );
    }
  } catch (msgErr) {
    console.warn('[OrderService] 最终报价消息失败:', msgErr && msgErr.message);
  }

  try {
    await recalculateOrderRewardPreview(pool, orderId);
  } catch (e) {
    console.warn('[OrderService] submitFinalQuote reward preview:', e && e.message);
  }

  return { success: true, data: { order_id: orderId, final_quote_status: 1 } };
}

/**
 * 车主确认或拒绝到店报价（多轮时每轮一条 proposal）
 */
async function confirmFinalQuote(pool, orderId, userId, approved) {
  if (!(await hasColumn(pool, 'orders', 'final_quote_status'))) {
    return { success: false, error: '当前服务端未升级双阶段报价字段', statusCode: 400 };
  }
  const useOqp = await oqp.proposalsTableExists(pool);
  const [orders] = await pool.execute(
    `SELECT order_id, user_id, pre_quote_snapshot, final_quote_snapshot, final_quote_status FROM orders WHERE order_id = ? AND user_id = ?`,
    [orderId, userId]
  );
  if (orders.length === 0) {
    return { success: false, error: '订单不存在', statusCode: 404 };
  }
  const o = orders[0];
  if (parseInt(o.final_quote_status, 10) !== 1) {
    return { success: false, error: '当前无待确认的报价', statusCode: 400 };
  }

  async function notifyMerchantConfirmed() {
    try {
      const [orderRows] = await pool.execute('SELECT shop_id FROM orders WHERE order_id = ?', [orderId]);
      if (orderRows.length > 0) {
        const [merchantRows] = await pool.execute(
          'SELECT merchant_id FROM merchant_users WHERE shop_id = ? AND status = 1 LIMIT 1',
          [orderRows[0].shop_id]
        );
        if (merchantRows.length > 0) {
          const subMsg = require('./subscribe-message-service');
          subMsg.sendToMerchant(
            pool,
            merchantRows[0].merchant_id,
            'merchant_order_new',
            { title: '报价已确认', content: '车主已确认当前轮次报价，可继续维修', relatedId: orderId },
            process.env.WX_APPID,
            process.env.WX_SECRET
          ).catch(() => {});
        }
      }
    } catch (e) {
      console.warn('[OrderService] confirmFinalQuote notify:', e && e.message);
    }
  }

  if (useOqp) {
    const pend = await oqp.getPending(pool, orderId);
    if (!pend) {
      return { success: false, error: '当前无待确认的报价', statusCode: 400 };
    }

    if (!approved) {
      await pool.execute(
        `UPDATE order_quote_proposals SET status = 2, resolved_at = NOW(), resolver_user_id = ? WHERE proposal_id = ?`,
        [userId, pend.proposal_id]
      );
      const lastConf = await oqp.getLastConfirmed(pool, orderId);
      let nextFqs = 0;
      let nextFss = null;
      let restorePlan = null;
      let restoreAmount = null;
      if (lastConf) {
        const snap = oqp.parseJson(lastConf.quote_snapshot);
        restorePlan = JSON.stringify(snap);
        restoreAmount = parseFloat(snap.amount);
        nextFqs = 2;
        nextFss = restorePlan;
        const ev = oqp.parseJson(lastConf.evidence);
        const lossJson = ev && ev.loss_assessment_documents ? JSON.stringify(ev.loss_assessment_documents) : null;
        await pool.execute(
          `UPDATE orders SET final_quote_status = ?, final_quote_snapshot = ?, repair_plan = ?, quoted_amount = ?,
           loss_assessment_documents = ?, updated_at = NOW() WHERE order_id = ?`,
          [nextFqs, nextFss, restorePlan, restoreAmount, lossJson, orderId]
        );
      } else {
        let preJson = o.pre_quote_snapshot;
        if (typeof preJson === 'string') {
          try {
            preJson = JSON.parse(preJson);
          } catch (_) {
            preJson = null;
          }
        }
        if (preJson) {
          restorePlan = JSON.stringify(preJson);
          restoreAmount = parseFloat(preJson.amount);
        }
        await pool.execute(
          `UPDATE orders SET final_quote_status = 0, final_quote_snapshot = NULL, repair_plan = ?, quoted_amount = ?,
           loss_assessment_documents = NULL, updated_at = NOW() WHERE order_id = ?`,
          [restorePlan, restoreAmount, orderId]
        );
      }
      try {
        await recalculateOrderRewardPreview(pool, orderId);
      } catch (e) {
        console.warn('[OrderService] confirmFinalQuote reward preview:', e && e.message);
      }
      return { success: true, data: { order_id: orderId, approved: false } };
    }

    const snap = oqp.parseJson(pend.quote_snapshot);
    if (!snap || snap.amount == null) {
      return { success: false, error: '报价数据异常', statusCode: 500 };
    }
    await pool.execute(
      `UPDATE order_quote_proposals SET status = 1, resolved_at = NOW(), resolver_user_id = ? WHERE proposal_id = ?`,
      [userId, pend.proposal_id]
    );

    let pre = o.pre_quote_snapshot;
    if (typeof pre === 'string') {
      try {
        pre = JSON.parse(pre);
      } catch (_) {
        pre = {};
      }
    }
    const preAmount = parseFloat(pre && pre.amount) || 0;
    const finalAmount = parseFloat(snap.amount) || 0;
    let deviation = null;
    if (preAmount > 0) {
      deviation = Math.round((Math.abs(finalAmount - preAmount) / preAmount) * 10000) / 100;
    }
    const planJson = JSON.stringify(snap);
    const pendEv = oqp.parseJson(pend.evidence);
    const lossJson =
      pendEv && pendEv.loss_assessment_documents ? JSON.stringify(pendEv.loss_assessment_documents) : null;

    await pool.execute(
      `UPDATE orders SET final_quote_status = 2, final_quote_confirmed_at = NOW(), quoted_amount = ?, repair_plan = ?,
       final_quote_snapshot = ?, deviation_rate = ?, loss_assessment_documents = ?, updated_at = NOW() WHERE order_id = ?`,
      [finalAmount, planJson, planJson, deviation, lossJson, orderId]
    );
    try {
      await recalculateOrderRewardPreview(pool, orderId);
    } catch (e) {
      console.warn('[OrderService] confirmFinalQuote reward preview:', e && e.message);
    }
    await notifyMerchantConfirmed();
    return { success: true, data: { order_id: orderId, approved: true, deviation_rate: deviation } };
  }

  if (!approved) {
    let preJson = o.pre_quote_snapshot;
    if (typeof preJson === 'string') {
      try {
        preJson = JSON.parse(preJson);
      } catch (_) {
        preJson = null;
      }
    }
    const restorePlan = preJson ? JSON.stringify(preJson) : null;
    await pool.execute(
      `UPDATE orders SET final_quote_status = 0, final_quote_snapshot = NULL, loss_assessment_documents = NULL, updated_at = NOW() WHERE order_id = ?`,
      [orderId]
    );
    if (restorePlan) {
      await pool.execute(`UPDATE orders SET repair_plan = ?, updated_at = NOW() WHERE order_id = ?`, [restorePlan, orderId]);
    }
    try {
      await recalculateOrderRewardPreview(pool, orderId);
    } catch (e) {
      console.warn('[OrderService] confirmFinalQuote reward preview:', e && e.message);
    }
    return { success: true, data: { order_id: orderId, approved: false } };
  }

  let snap = o.final_quote_snapshot;
  if (typeof snap === 'string') {
    try {
      snap = JSON.parse(snap);
    } catch (_) {
      return { success: false, error: '最终报价数据异常', statusCode: 500 };
    }
  }
  let pre = o.pre_quote_snapshot;
  if (typeof pre === 'string') {
    try {
      pre = JSON.parse(pre);
    } catch (_) {
      pre = {};
    }
  }
  const preAmount = parseFloat(pre && pre.amount) || 0;
  const finalAmount = parseFloat(snap && snap.amount) || 0;
  let deviation = null;
  if (preAmount > 0) {
    deviation = Math.round((Math.abs(finalAmount - preAmount) / preAmount) * 10000) / 100;
  }
  const planJson = JSON.stringify(snap);

  await pool.execute(
    `UPDATE orders SET final_quote_status = 2, final_quote_confirmed_at = NOW(), quoted_amount = ?, repair_plan = ?, final_quote_snapshot = ?, deviation_rate = ?, updated_at = NOW() WHERE order_id = ?`,
    [finalAmount, planJson, planJson, deviation, orderId]
  );
  try {
    await recalculateOrderRewardPreview(pool, orderId);
  } catch (e) {
    console.warn('[OrderService] confirmFinalQuote reward preview:', e && e.message);
  }
  await notifyMerchantConfirmed();
  return { success: true, data: { order_id: orderId, approved: true, deviation_rate: deviation } };
}

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
  submitFinalQuote,
  confirmFinalQuote,
  respondCancelRequest,
  escalateCancelRequest,
  getPendingCancelRequest,
  getLatestCancelRequestForUser,
  listCancelRequestsForAdmin,
  resolveCancelRequestByAdmin,
};
