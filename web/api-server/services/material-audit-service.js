/**
 * 材料 AI 审核服务
 * 1→2：服务商提交维修完成凭证后创建审核任务；AI 通过则 status=2；
 * AI 未通过 / 异常 / 未配置 Key → manual_review，由后台人工处理（不直接驳回给商户重提）
 */

const crypto = require('crypto');
const { analyzeCompletionEvidenceWithQwen } = require('../qwen-analyzer');
const orderWarrantyCardService = require('./order-warranty-card-service');
const {
  enrichCompletionEvidenceWithExteriorRepairAnalysis,
} = require('../utils/exterior-repair-at-completion');
const {
  enrichCompletionEvidenceWithPartsTraceability,
} = require('../utils/parts-traceability-at-completion');

const LOG_PREFIX = '[material-audit]';

const MANUAL_REVIEW_NOTE =
  '材料已提交；自动审核未通过或暂不可用，已转后台人工处理，请耐心等待，无需重复提交。';

/**
 * 发送服务商站内消息
 */
async function sendMerchantMessage(pool, shopId, type, title, content, relatedId, subscribeContent) {
  const [rows] = await pool.execute(
    'SELECT merchant_id FROM merchant_users WHERE shop_id = ? AND status = 1 LIMIT 1',
    [shopId]
  );
  if (rows.length === 0) return;
  const merchantId = rows[0].merchant_id;
  const msgId = 'mmsg_' + crypto.randomBytes(12).toString('hex');
  try {
    await pool.execute(
      `INSERT INTO merchant_messages (message_id, merchant_id, type, title, content, related_id, is_read)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [msgId, merchantId, type, title, content, relatedId || null]
    );
  } catch (err) {
    if (!String(err.message || '').includes('Duplicate')) {
      console.warn(`${LOG_PREFIX} sendMerchantMessage error:`, err.message);
    }
  }
  const subMsg = require('./subscribe-message-service');
  subMsg
    .sendToMerchant(
      pool,
      merchantId,
      'merchant_material_audit',
      { title, content: subscribeContent || content, relatedId },
      process.env.WX_APPID,
      process.env.WX_SECRET
    )
    .catch((e) => {
      console.warn(`${LOG_PREFIX} 订阅消息发送异常:`, e && e.message);
    });
}

async function hasColumn(pool, table, col) {
  try {
    const [rows] = await pool.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, col]
    );
    return rows.length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * 审核通过：写订单待确认 + 任务 passed + 通知商户与车主
 * @param {object} aiDetailsObj 写入 material_audit_tasks.ai_details
 */
async function finalizeMaterialAuditPass(pool, task, evidence, aiDetailsObj) {
  const taskId = task.task_id;
  const detailsJson = JSON.stringify(aiDetailsObj && typeof aiDetailsObj === 'object' ? aiDetailsObj : {});
  const evidenceJson = JSON.stringify(evidence || {});
  const hasEvidence = await hasColumn(pool, 'orders', 'completion_evidence');
  const hasOrderWct = await hasColumn(pool, 'orders', 'warranty_card_template_id');
  let templateId = null;
  if (evidence && evidence.warranty_card_template_id != null) {
    templateId = orderWarrantyCardService.normalizeTemplateId(evidence.warranty_card_template_id);
  }
  let updateSql;
  let updateParams;
  if (hasEvidence && hasOrderWct && templateId != null) {
    updateSql =
      'UPDATE orders SET status = 2, completion_evidence = ?, warranty_card_template_id = ?, updated_at = NOW() WHERE order_id = ?';
    updateParams = [evidenceJson, templateId, task.order_id];
  } else if (hasEvidence) {
    updateSql = 'UPDATE orders SET status = 2, completion_evidence = ?, updated_at = NOW() WHERE order_id = ?';
    updateParams = [evidenceJson, task.order_id];
  } else {
    updateSql = 'UPDATE orders SET status = 2, updated_at = NOW() WHERE order_id = ?';
    updateParams = [task.order_id];
  }
  await pool.execute(updateSql, updateParams);
  await pool.execute(
    `UPDATE material_audit_tasks SET status = 'passed', ai_details = ?, completed_at = NOW() WHERE task_id = ?`,
    [detailsJson, taskId]
  );
  await sendMerchantMessage(
    pool,
    task.shop_id,
    'material_audit',
    '审核通过',
    '订单已进入待确认，请通知车主验收。',
    task.order_id,
    '请通知车主验收'
  );
  try {
    const [orderRows] = await pool.execute('SELECT user_id FROM orders WHERE order_id = ?', [task.order_id]);
    if (orderRows.length > 0) {
      const subMsg = require('./subscribe-message-service');
      subMsg
        .sendToUser(
          pool,
          orderRows[0].user_id,
          'user_order_update',
          { title: '待验收', content: '维修完成，请验收', relatedId: task.order_id },
          process.env.WX_APPID,
          process.env.WX_SECRET
        )
        .catch((e) => console.warn(`${LOG_PREFIX} 车主订阅消息发送异常:`, e && e.message));
    }
  } catch (userMsgErr) {
    console.warn(`${LOG_PREFIX} 车主订阅消息失败:`, userMsgErr && userMsgErr.message);
  }
}

async function setTaskManualReview(pool, taskId, aiDetailsObj, rejectReasonForAdmin) {
  const d = JSON.stringify(aiDetailsObj && typeof aiDetailsObj === 'object' ? aiDetailsObj : {});
  const r = String(rejectReasonForAdmin || '待人工审核').slice(0, 500);
  await pool.execute(
    `UPDATE material_audit_tasks SET status = 'manual_review', ai_details = ?, reject_reason = ?, completed_at = NULL WHERE task_id = ?`,
    [d, r, taskId]
  );
}

async function notifyMerchantManualReview(pool, task) {
  await sendMerchantMessage(
    pool,
    task.shop_id,
    'material_audit',
    '已转人工审核',
    MANUAL_REVIEW_NOTE,
    task.order_id,
    '请耐心等待'
  );
}

/**
 * 后台人工：通过（仅 manual_review）
 */
async function approveMaterialAuditManual(pool, taskId) {
  const [tasks] = await pool.execute(`SELECT * FROM material_audit_tasks WHERE task_id = ? AND status = 'manual_review'`, [
    taskId,
  ]);
  if (tasks.length === 0) {
    return { ok: false, error: '任务不存在或已处理' };
  }
  const task = tasks[0];
  const [orders] = await pool.execute('SELECT status FROM orders WHERE order_id = ?', [task.order_id]);
  if (orders.length === 0) {
    return { ok: false, error: '订单不存在' };
  }
  if (parseInt(orders[0].status, 10) !== 1) {
    return { ok: false, error: '订单状态已不是维修中，无法完成审核' };
  }
  let evidence = {};
  try {
    evidence =
      typeof task.completion_evidence === 'string'
        ? JSON.parse(task.completion_evidence || '{}')
        : task.completion_evidence || {};
  } catch (_) {}
  let prevDetails = {};
  try {
    prevDetails =
      typeof task.ai_details === 'string' ? JSON.parse(task.ai_details || '{}') : task.ai_details || {};
  } catch (_) {}
  let evidenceOut = evidence;
  try {
    const bu = process.env.BASE_URL || 'http://localhost:3000';
    evidenceOut = await enrichCompletionEvidenceWithExteriorRepairAnalysis(pool, task.order_id, evidence, bu);
    evidenceOut = await enrichCompletionEvidenceWithPartsTraceability(pool, task.order_id, evidenceOut, bu);
  } catch (exErr) {
    console.warn(`${LOG_PREFIX} 人工通过-完工 AI 增强写入失败:`, exErr.message);
  }
  await finalizeMaterialAuditPass(pool, task, evidenceOut, {
    ...prevDetails,
    manual_approved: true,
    manual_approved_at: new Date().toISOString(),
  });
  return { ok: true };
}

/**
 * 后台人工：驳回（仅 manual_review），订单保持维修中，商户可重提
 */
async function rejectMaterialAuditManual(pool, taskId, rejectReason) {
  const reason = String(rejectReason || '').trim() || '未通过人工审核';
  const [tasks] = await pool.execute(`SELECT * FROM material_audit_tasks WHERE task_id = ? AND status = 'manual_review'`, [
    taskId,
  ]);
  if (tasks.length === 0) {
    return { ok: false, error: '任务不存在或已处理' };
  }
  const task = tasks[0];
  let prevDetails = {};
  try {
    prevDetails =
      typeof task.ai_details === 'string' ? JSON.parse(task.ai_details || '{}') : task.ai_details || {};
  } catch (_) {}
  await pool.execute(
    `UPDATE material_audit_tasks SET status = 'rejected', reject_reason = ?, ai_details = ?, completed_at = NOW() WHERE task_id = ?`,
    [reason.slice(0, 500), JSON.stringify({ ...prevDetails, manual_rejected: true }), taskId]
  );
  await sendMerchantMessage(
    pool,
    task.shop_id,
    'material_audit',
    '人工审核未通过',
    reason + '。请修改凭证后重新提交「维修完成」。',
    task.order_id,
    '请修改后重交'
  );
  return { ok: true };
}

/**
 * 处理单个材料审核任务（异步执行）
 */
async function processMaterialAuditTask(pool, taskId, baseUrl) {
  const [tasks] = await pool.execute(
    `SELECT task_id, order_id, shop_id, completion_evidence, status
     FROM material_audit_tasks WHERE task_id = ? AND status = 'pending'`,
    [taskId]
  );
  if (tasks.length === 0) return;

  const task = tasks[0];
  let evidence = {};
  try {
    evidence =
      typeof task.completion_evidence === 'string'
        ? JSON.parse(task.completion_evidence || '{}')
        : task.completion_evidence || {};
  } catch (_) {}

  const apiKey = process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '';
  if (!apiKey) {
    console.warn(`${LOG_PREFIX} 未配置千问 API Key，任务 ${taskId} 转人工审核`);
    await setTaskManualReview(pool, taskId, { reason: 'no_api_key' }, '未配置自动审核接口，待人工处理');
    await notifyMerchantManualReview(pool, task);
    return;
  }

  const [orders] = await pool.execute(
    `SELECT o.order_id, o.repair_plan, o.quoted_amount, o.bidding_id, b.vehicle_info
     FROM orders o
     LEFT JOIN biddings b ON o.bidding_id = b.bidding_id
     WHERE o.order_id = ?`,
    [task.order_id]
  );
  if (orders.length === 0) {
    await pool.execute(
      `UPDATE material_audit_tasks SET status = 'rejected', reject_reason = '订单不存在', completed_at = NOW() WHERE task_id = ?`,
      [taskId]
    );
    return;
  }

  const order = orders[0];
  let repairPlan = null;
  let vehicleInfo = {};
  try {
    repairPlan = typeof order.repair_plan === 'string' ? JSON.parse(order.repair_plan || '{}') : order.repair_plan || {};
  } catch (_) {}
  try {
    vehicleInfo =
      typeof order.vehicle_info === 'string' ? JSON.parse(order.vehicle_info || '{}') : order.vehicle_info || {};
  } catch (_) {}

  const orderForAi = {
    repair_plan: repairPlan,
    quoted_amount: order.quoted_amount,
    vehicle_info: vehicleInfo,
  };

  let result;
  try {
    result = await analyzeCompletionEvidenceWithQwen({
      order: orderForAi,
      evidence,
      baseUrl: baseUrl || process.env.BASE_URL || 'http://localhost:3000',
      apiKey,
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} AI 审核异常 task=${taskId}:`, err.message);
    await setTaskManualReview(
      pool,
      taskId,
      { error: String(err.message || 'unknown'), stage: 'ai_exception' },
      'AI 审核服务异常，待人工处理'
    );
    await notifyMerchantManualReview(pool, task);
    return;
  }

  const detailsJson = result.details || {};

  if (result.pass) {
    let evidenceOut = evidence;
    try {
      const bu = baseUrl || process.env.BASE_URL || 'http://localhost:3000';
      evidenceOut = await enrichCompletionEvidenceWithExteriorRepairAnalysis(pool, task.order_id, evidence, bu);
      evidenceOut = await enrichCompletionEvidenceWithPartsTraceability(pool, task.order_id, evidenceOut, bu);
    } catch (exErr) {
      console.warn(`${LOG_PREFIX} 完工 AI 增强写入失败 task=${taskId}:`, exErr.message);
    }
    await finalizeMaterialAuditPass(pool, task, evidenceOut, detailsJson);
  } else {
    const adminHint = (result.rejectReason || 'AI 未自动通过').slice(0, 500);
    await setTaskManualReview(
      pool,
      taskId,
      { ...detailsJson, ai_pass: false, ai_reject_hint: result.rejectReason || null },
      adminHint
    );
    await notifyMerchantManualReview(pool, task);
  }
}

function runMaterialAuditAsync(pool, taskId, baseUrl) {
  setImmediate(() => {
    processMaterialAuditTask(pool, taskId, baseUrl).catch((err) => {
      console.error(`${LOG_PREFIX} runMaterialAuditAsync error:`, err);
    });
  });
}

module.exports = {
  processMaterialAuditTask,
  runMaterialAuditAsync,
  sendMerchantMessage,
  finalizeMaterialAuditPass,
  approveMaterialAuditManual,
  rejectMaterialAuditManual,
};
