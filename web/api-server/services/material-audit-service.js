/**
 * 材料 AI 审核服务
 * 1→2 异步：服务商提交维修完成凭证后，创建审核任务，后台 AI 审核通过则 status=2
 */

const crypto = require('crypto');
const { analyzeCompletionEvidenceWithQwen } = require('../qwen-analyzer');

const LOG_PREFIX = '[material-audit]';

/**
 * 发送服务商站内消息
 * @param {Object} pool - 数据库连接池
 * @param {string} shopId - 店铺 ID
 * @param {string} type - 消息类型
 * @param {string} title - 标题（thing1，直接结果如审核通过/失败/异常）
 * @param {string} content - 站内消息完整内容
 * @param {string} [relatedId] - 关联 ID（如 order_id）
 * @param {string} [subscribeContent] - 订阅消息 thing2，简短操作指引（≤20字），缺省用 content
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
  subMsg.sendToMerchant(
    pool,
    merchantId,
    'merchant_material_audit',
    { title, content: subscribeContent || content, relatedId },
    process.env.WX_APPID,
    process.env.WX_SECRET
  ).catch((e) => {
    console.warn(`${LOG_PREFIX} 订阅消息发送异常:`, e && e.message);
  });
}

/**
 * 处理单个材料审核任务（同步执行）
 * @param {Object} pool - 数据库连接池
 * @param {string} taskId - 任务 ID
 * @param {string} baseUrl - 图片 URL 基准（用于相对路径转绝对）
 */
async function processMaterialAuditTask(pool, taskId, baseUrl) {
  const apiKey = process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '';
  if (!apiKey) {
    console.warn(`${LOG_PREFIX} 未配置千问 API Key，跳过审核任务 ${taskId}`);
    return;
  }

  const [tasks] = await pool.execute(
    `SELECT task_id, order_id, shop_id, completion_evidence, status
     FROM material_audit_tasks WHERE task_id = ? AND status = 'pending'`,
    [taskId]
  );
  if (tasks.length === 0) return;

  const task = tasks[0];
  let evidence = {};
  try {
    evidence = typeof task.completion_evidence === 'string'
      ? JSON.parse(task.completion_evidence || '{}')
      : (task.completion_evidence || {});
  } catch (_) {}

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
    repairPlan = typeof order.repair_plan === 'string'
      ? JSON.parse(order.repair_plan || '{}')
      : (order.repair_plan || {});
  } catch (_) {}
  try {
    vehicleInfo = typeof order.vehicle_info === 'string'
      ? JSON.parse(order.vehicle_info || '{}')
      : (order.vehicle_info || {});
  } catch (_) {}

  const orderForAi = {
    repair_plan: repairPlan,
    quoted_amount: order.quoted_amount,
    vehicle_info: vehicleInfo
  };

  let result;
  try {
    result = await analyzeCompletionEvidenceWithQwen({
      order: orderForAi,
      evidence,
      baseUrl: baseUrl || process.env.BASE_URL || 'http://localhost:3000',
      apiKey
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} AI 审核异常 task=${taskId}:`, err.message);
    await pool.execute(
      `UPDATE material_audit_tasks SET status = 'rejected', reject_reason = ?, completed_at = NOW() WHERE task_id = ?`,
      ['审核服务异常，请稍后重试', taskId]
    );
    await sendMerchantMessage(
      pool, task.shop_id, 'material_audit',
      '审核异常',
      '材料审核服务暂时异常，请稍后重新提交维修完成。',
      task.order_id,
      '请稍后重试'
    );
    return;
  }

  const detailsJson = JSON.stringify(result.details || {});

  if (result.pass) {
    const evidenceJson = JSON.stringify(evidence);
    const hasEvidence = await hasColumn(pool, 'orders', 'completion_evidence');
    const updateSql = hasEvidence
      ? 'UPDATE orders SET status = 2, completion_evidence = ?, updated_at = NOW() WHERE order_id = ?'
      : 'UPDATE orders SET status = 2, updated_at = NOW() WHERE order_id = ?';
    const updateParams = hasEvidence ? [evidenceJson, task.order_id] : [task.order_id];
    await pool.execute(updateSql, updateParams);
    await pool.execute(
      `UPDATE material_audit_tasks SET status = 'passed', ai_details = ?, completed_at = NOW() WHERE task_id = ?`,
      [detailsJson, taskId]
    );
    await sendMerchantMessage(
      pool, task.shop_id, 'material_audit',
      '审核通过',
      '订单已进入待确认，请通知车主验收。',
      task.order_id,
      '请通知车主验收'
    );
    try {
      const [orderRows] = await pool.execute('SELECT user_id FROM orders WHERE order_id = ?', [task.order_id]);
      if (orderRows.length > 0) {
        const subMsg = require('./subscribe-message-service');
        subMsg.sendToUser(
          pool,
          orderRows[0].user_id,
          'user_order_update',
          { title: '待验收', content: '维修完成，请验收', relatedId: task.order_id },
          process.env.WX_APPID,
          process.env.WX_SECRET
        ).catch((e) => console.warn(`${LOG_PREFIX} 车主订阅消息发送异常:`, e && e.message));
      }
    } catch (userMsgErr) {
      console.warn(`${LOG_PREFIX} 车主订阅消息失败:`, userMsgErr && userMsgErr.message);
    }
  } else {
    await pool.execute(
      `UPDATE material_audit_tasks SET status = 'rejected', reject_reason = ?, ai_details = ?, completed_at = NOW() WHERE task_id = ?`,
      [result.rejectReason || '材料未通过审核', detailsJson, taskId]
    );
    await sendMerchantMessage(
      pool, task.shop_id, 'material_audit',
      '审核失败',
      (result.rejectReason || '材料未通过审核') + '，请修改后重新提交维修完成。',
      task.order_id,
      '请修改后重交'
    );
  }
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
 * 异步执行材料审核（fire-and-forget）
 */
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
  sendMerchantMessage
};
