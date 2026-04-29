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

/** 完工凭证：仅校验为对象；张数、技师、验真等由端上引导，接口不强制 */
function validateCompletionEvidence(evidence) {
  if (evidence === undefined || evidence === null) return { ok: true };
  if (typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { ok: false, msg: '完工凭证格式无效' };
  }
  return { ok: true };
}

function countCompletionEvidenceImages(evidence) {
  const e = evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  return arr(e.repair_photos).length + arr(e.settlement_photos).length + arr(e.material_photos).length;
}

function hasSettlementDocs(evidence) {
  const e = evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  return arr(e.settlement_photos).length > 0;
}

/**
 * 车主取消交易（新口径：以“拆检留痕”为锚点）
 * 规则（方案2）：
 * - 若订单已存在拆检费/拆检收据等线下留痕（order_offline_fee_proofs），视为已发生拆检，禁止直接取消；
 *   引导走“拆检费处置/结案”流程（后台/客服）。
 * - 若无任何拆检留痕：允许取消交易（直接取消订单并释放竞价）。
 */
async function cancelOrder(pool, orderId, userId) {
  const [orders] = await pool.execute(
    'SELECT order_id, bidding_id, status FROM orders WHERE order_id = ? AND user_id = ?',
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

  // 若已发生拆检留痕，禁止直接取消
  try {
    const [proofRows] = await pool.execute(
      'SELECT 1 FROM order_offline_fee_proofs WHERE order_id = ? LIMIT 1',
      [orderId]
    );
    if (proofRows && proofRows.length > 0) {
      return {
        success: false,
        error: '已产生拆检费/拆检收据等留痕，无法直接取消交易。请按拆检费处置流程处理（上传凭证/联系客服）。',
        statusCode: 400,
      };
    }
  } catch (e) {
    // 若未创建该表（早期环境），按“允许取消”兜底，避免阻断正常取消
    if (!String((e && e.message) || '').includes('order_offline_fee_proofs')) {
      console.warn('[cancelOrder] check order_offline_fee_proofs error:', e && e.message);
    }
  }

  await doCancelOrder(pool, orderId, order.bidding_id);
  // 生命周期字段若存在，补写 cancelled（不依赖 order-lifecycle-service，避免循环依赖）
  try {
    const { hasColumn } = require('../utils/db-utils');
    if (await hasColumn(pool, 'orders', 'lifecycle_main')) {
      await pool.execute(
        `UPDATE orders
         SET lifecycle_main = 'cancelled',
             lifecycle_sub = 'owner_cancelled',
             updated_at = NOW()
         WHERE order_id = ?`,
        [orderId]
      );
    }
  } catch (_) {}

  return { success: true, data: { order_id: orderId, direct: true } };
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
 * 系统自动确认交车（待交车超48h）
 * 与 confirmOrder 同口径计算佣金，但不要求 userId 匹配。
 */
async function confirmOrderBySystem(pool, orderId) {
  const [orders] = await pool.execute(
    'SELECT order_id, shop_id, quote_id, status, quoted_amount, actual_amount, commission_rate FROM orders WHERE order_id = ?',
    [orderId]
  );
  if (!orders.length) {
    return { success: false, error: '订单不存在', statusCode: 404 };
  }
  const order = orders[0];
  if (parseInt(order.status, 10) !== 2) {
    return { success: false, error: '当前状态不可自动确认交车', statusCode: 400 };
  }

  const amount = parseFloat(order.actual_amount || order.quoted_amount) || 0;
  const rate = (parseFloat(order.commission_rate) || 0) / 100;
  const commission = Math.round(amount * rate * 100) / 100;
  await pool.execute(
    'UPDATE orders SET status = 3, completed_at = NOW(), updated_at = NOW(), commission = ?, delivery_confirmed_at = NOW() WHERE order_id = ?',
    [commission, orderId]
  );

  return { success: true, data: { order_id: orderId, auto: true } };
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
 * 1->2 时 completion_evidence 可选；若含至少 1 张凭证图则**仍立即**落库为待验收（status=2），并创建 `material_audit_tasks` 供后台异步质检，**不阻塞**完工。
 * 材料审核仅更新任务状态与可选回写 `completion_evidence`，不再负责把订单从 1 推到 2。
 * repair_plan_status=1（待车主确认）时不可点击维修完成。
 * 若已启用 `order_repair_milestones`：须已存在至少一条 `after_process` 留痕后才允许 1→2（非完工节点仅更新进展）。
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
    try {
      const repairMilestoneService = require('./repair-milestone-service');
      if (await repairMilestoneService.milestonesTableExists(pool)) {
        const milestones = await repairMilestoneService.listForOrder(pool, orderId);
        const hasAfterProcess = milestones.some(
          (m) => m && String(m.milestone_code || '') === 'after_process'
        );
        if (!hasAfterProcess) {
          return {
            success: false,
            error:
              '请先在「更新关键节点」中上传并提交「完工」环节过程照片后，再申请待验收；其他节点留痕不会结束维修',
            statusCode: 400,
          };
        }
      }
    } catch (mErr) {
      console.warn('[OrderService] 完工前置校验（milestones）:', mErr && mErr.message);
    }
    const valid = validateCompletionEvidence(completionEvidence);
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

    const imageCount = countCompletionEvidenceImages(completionEvidence);
    const hasMaterialAuditTable = await hasTable(pool, 'material_audit_tasks');
    let auditTaskId = null;
    if (hasMaterialAuditTable && imageCount > 0) {
      auditTaskId = 'mat_' + crypto.randomBytes(12).toString('hex');
      const evidenceJsonEarly = JSON.stringify(evidenceForStore);
      try {
        await pool.execute(
          `INSERT INTO material_audit_tasks (task_id, order_id, shop_id, completion_evidence, status)
           VALUES (?, ?, ?, ?, 'pending')`,
          [auditTaskId, orderId, shopId, evidenceJsonEarly]
        );
      } catch (err) {
        console.warn('[OrderService] 创建材料审核任务失败:', err.message);
        auditTaskId = null;
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
    // 新流程：完工提交不再立即推进到 status=2（待验收）；先落库凭证 + 创建材料审核任务，
    // 待 AI/人工确认（结算单存在且金额一致性无异常）后再由 material-audit-service 推进到 2。
    if (hasEvidence && hasOrderWct) {
      await pool.execute(
        'UPDATE orders SET completion_evidence = ?, warranty_card_template_id = ?, updated_at = NOW() WHERE order_id = ?',
        [evidenceJson, templateIdResolved, orderId]
      );
    } else if (hasEvidence) {
      await pool.execute(
        'UPDATE orders SET completion_evidence = ?, updated_at = NOW() WHERE order_id = ?',
        [evidenceJson, orderId]
      );
    } else {
      await pool.execute('UPDATE orders SET updated_at = NOW() WHERE order_id = ?', [orderId]);
    }

    // 结算单/定损单必传：缺失则直接转人工审核（订单保持维修中）
    if (hasMaterialAuditTable && auditTaskId && !hasSettlementDocs(completionEvidence)) {
      try {
        await pool.execute(
          `UPDATE material_audit_tasks
           SET status = 'manual_review',
               reject_reason = '缺失定损单/结算单（结算金额无法核验），请补充后重新提交',
               completed_at = NULL
           WHERE task_id = ?`,
          [auditTaskId]
        );
      } catch (_) {}
      return { success: true, data: { order_id: orderId, task_id: auditTaskId, hold_status: 1, need_manual: true } };
    }
    const outData = { order_id: orderId };
    if (auditTaskId) outData.task_id = auditTaskId;
    try {
      const rpa = require('./repair-process-ai-service');
      if (typeof rpa.scheduleRepairProcessAiForOrder === 'function') {
        rpa.scheduleRepairProcessAiForOrder(pool, orderId);
      }
    } catch (e) {
      console.warn('[OrderService] scheduleRepairProcessAiForOrder:', e && e.message);
    }
    return { success: true, data: outData };
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

// 撤单申请（order_cancel_requests）旧链路已废弃：不再支持服务商响应、车主升级人工、后台列表/处理。
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

module.exports = {
  cancelOrder,
  confirmOrder,
  confirmOrderBySystem,
  acceptOrder,
  updateOrderStatus,
  updateRepairPlan,
  approveRepairPlan,
  submitFinalQuote,
  confirmFinalQuote,
};
