/**
 * 管理端服务
 * 按领域拆分：登录、merchants、orders、config、reward-rules、review-audit、complexity-upgrade、antifraud
 */

const crypto = require('crypto');
const antifraud = require('../antifraud');

// ===================== 登录 =====================
async function login(db, req, options = {}) {
  const { username, password } = req.body || {};
  const { JWT_SECRET } = options;
  if (username === 'admin' && password === 'admin123') {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { userId: 'admin', role: 'admin' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    return { success: true, data: { token, user: { username, role: 'admin' } }, message: '登录成功' };
  }
  return { success: false, error: '用户名或密码错误', statusCode: 401 };
}

// ===================== 服务商 merchants =====================
async function getMerchants(db, req) {
  const { page = 1, pageSize = 10, auditStatus, qualificationAuditStatus, keyword } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(pageSize);

  let where = 'WHERE 1=1';
  const params = [];

  if (auditStatus === 'pending') {
    where += ' AND (mu.status = 0 OR mu.status IS NULL)';
  } else if (auditStatus === 'approved') {
    where += ' AND mu.status = 1';
  }
  if (qualificationAuditStatus === 'pending') {
    where += ' AND (s.qualification_status = 0 OR s.qualification_status IS NULL) AND (s.qualification_level IS NOT NULL OR s.technician_certs IS NOT NULL)';
  } else if (qualificationAuditStatus === 'approved') {
    where += ' AND s.qualification_status = 1';
  } else if (qualificationAuditStatus === 'rejected') {
    where += ' AND s.qualification_status = 2';
  }
  if (keyword) {
    where += ' AND (s.name LIKE ? OR mu.phone LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  const [list] = await db.execute(
    `SELECT mu.merchant_id as merchantId, mu.shop_id as shopId, mu.phone, mu.status as auditStatus, s.name as merchantName, s.address,
            s.compliance_rate as complianceRate, s.complaint_rate as complaintRate, s.qualification_level as qualificationLevel,
            s.technician_certs as technicianCerts, s.certifications as certifications, s.qualification_status as qualificationStatus,
            s.qualification_audit_reason as qualificationAuditReason, s.qualification_ai_result as qualificationAiResult
     FROM merchant_users mu
     LEFT JOIN shops s ON mu.shop_id = s.shop_id
     ${where}
     ORDER BY mu.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, parseInt(pageSize), offset]
  );

  const [countRes] = await db.execute(
    `SELECT COUNT(*) as total FROM merchant_users mu LEFT JOIN shops s ON mu.shop_id = s.shop_id ${where}`,
    params
  );

  const listWithCerts = (list || []).map((row) => {
    let technicianCerts = row.technicianCerts;
    if (typeof technicianCerts === 'string') {
      try {
        technicianCerts = technicianCerts ? JSON.parse(technicianCerts) : null;
      } catch (_) {
        technicianCerts = null;
      }
    }
    return { ...row, technicianCerts };
  });

  return { success: true, data: { list: listWithCerts, total: countRes[0].total } };
}

async function qualificationAudit(db, req) {
  const { id } = req.params;
  const { auditStatus, rejectReason } = req.body;

  const [merchants] = await db.execute(
    'SELECT shop_id FROM merchant_users WHERE merchant_id = ?',
    [id]
  );
  if (merchants.length === 0) {
    return { success: false, error: '服务商不存在', statusCode: 404 };
  }
  const shopId = merchants[0].shop_id;

  if (auditStatus === 'approved') {
    await db.execute(
      'UPDATE shops SET qualification_status = 1, qualification_audit_reason = NULL, updated_at = NOW() WHERE shop_id = ?',
      [shopId]
    );
    try {
      const msgId = 'mmsg_' + crypto.randomBytes(12).toString('hex');
      await db.execute(
        `INSERT INTO merchant_messages (message_id, merchant_id, type, title, content, related_id, is_read)
         VALUES (?, ?, 'qualification_audit', ?, ?, ?, 0)`,
        [msgId, id, '资质审核已通过', '恭喜，您的维修资质已审核通过，现可正常接单并在车主端展示。', shopId]
      );
    } catch (msgErr) {
      if (!String(msgErr.message || '').includes('merchant_messages')) console.warn('创建服务商消息失败:', msgErr.message);
    }
    return { success: true, message: '资质审核通过' };
  }

  const reason = String(rejectReason || '').trim() || '资质信息不符合要求，请修改后重新提交';
  await db.execute(
    'UPDATE shops SET qualification_status = 2, qualification_audit_reason = ?, updated_at = NOW() WHERE shop_id = ?',
    [reason, shopId]
  );
  try {
    const msgId = 'mmsg_' + crypto.randomBytes(12).toString('hex');
    await db.execute(
      `INSERT INTO merchant_messages (message_id, merchant_id, type, title, content, related_id, is_read)
       VALUES (?, ?, 'qualification_audit', ?, ?, ?, 0)`,
      [msgId, id, '资质审核被驳回', `您的资质审核未通过。原因：${reason}。请修改后重新提交。`, shopId]
    );
  } catch (msgErr) {
    if (!String(msgErr.message || '').includes('merchant_messages')) console.warn('创建服务商消息失败:', msgErr.message);
  }
  return { success: true, message: '已驳回，服务商可修改后重新提交' };
}

async function merchantAudit(db, req) {
  const { id } = req.params;
  const { auditStatus } = req.body;
  await db.execute(
    'UPDATE merchant_users SET status = ? WHERE merchant_id = ?',
    [auditStatus === 'approved' ? 1 : 0, id]
  );
  return { success: true, message: '审核成功' };
}

// ===================== 订单 orders =====================
async function getOrders(db, req) {
  const { page = 1, pageSize = 20, orderNo, status, ownerId, merchantId, startDate, endDate } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(pageSize);

  let where = 'WHERE 1=1';
  const params = [];

  if (orderNo) { where += ' AND o.order_id = ?'; params.push(orderNo); }
  if (status !== undefined && status !== '') { where += ' AND o.status = ?'; params.push(status); }
  if (ownerId) { where += ' AND o.user_id = ?'; params.push(ownerId); }
  if (merchantId) { where += ' AND o.shop_id = ?'; params.push(merchantId); }
  if (startDate) { where += ' AND DATE(o.created_at) >= ?'; params.push(startDate); }
  if (endDate) { where += ' AND DATE(o.created_at) <= ?'; params.push(endDate); }

  const [list] = await db.execute(
    `SELECT o.order_id as orderNo, o.status, o.quoted_amount as orderAmount, o.created_at as createTime,
            u.nickname as ownerName, s.name as merchantName,
            o.order_tier as orderTier, o.complexity_level as complexityLevel, o.reward_preview as rewardPreview,
            o.commission_rate as commissionRate, o.commission as commission
     FROM orders o
     LEFT JOIN users u ON o.user_id = u.user_id
     LEFT JOIN shops s ON o.shop_id = s.shop_id
     ${where}
     ORDER BY o.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, parseInt(pageSize), offset]
  );

  const [countRes] = await db.execute(
    `SELECT COUNT(*) as total FROM orders o ${where}`,
    params
  );

  return { success: true, data: { list, total: countRes[0].total } };
}

async function getOrderDetail(db, req) {
  const { orderNo } = req.params;
  const [orders] = await db.execute(
    `SELECT o.*, u.nickname as ownerName, u.phone as ownerPhone, s.name as shopName
     FROM orders o
     LEFT JOIN users u ON o.user_id = u.user_id
     LEFT JOIN shops s ON o.shop_id = s.shop_id
     WHERE o.order_id = ?`,
    [orderNo]
  );

  if (orders.length === 0) {
    return { success: false, error: '订单不存在', statusCode: 404 };
  }

  const [rebateRows] = await db.execute(
    `SELECT t.transaction_id, t.amount, t.reward_tier as rewardTier, t.review_stage as reviewStage, t.tax_deducted as taxDeducted, t.created_at
     FROM transactions t
     WHERE t.type = 'rebate' AND t.related_id = ?
     ORDER BY t.created_at`,
    [orderNo]
  );

  const order = orders[0];
  const [quotes] = await db.execute(
    `SELECT q.*, s.name as merchantName FROM quotes q
     LEFT JOIN shops s ON q.shop_id = s.shop_id
     WHERE q.bidding_id = (SELECT bidding_id FROM orders WHERE order_id = ?)`,
    [orderNo]
  );

  let vehicleInfo = {};
  if (order.bidding_id) {
    const [biddings] = await db.execute(
      'SELECT vehicle_info FROM biddings WHERE bidding_id = ?',
      [order.bidding_id]
    );
    if (biddings.length > 0 && biddings[0].vehicle_info) {
      try {
        vehicleInfo = typeof biddings[0].vehicle_info === 'string'
          ? JSON.parse(biddings[0].vehicle_info) : biddings[0].vehicle_info;
      } catch (_) {}
    }
  }

  const orderDetail = {
    order: {
      orderNo: order.order_id,
      status: order.status,
      quotedAmount: order.quoted_amount,
      actualAmount: order.actual_amount,
      orderTier: order.order_tier,
      complexityLevel: order.complexity_level,
      rewardPreview: order.reward_preview,
      commissionRate: order.commission_rate,
      commission: order.commission,
      reviewStageStatus: order.review_stage_status,
      createdAt: order.created_at,
      createTime: order.created_at,
      vehicleInfo: {
        brand: vehicleInfo.brand,
        model: vehicleInfo.model,
        plate_number: vehicleInfo.plate_number,
        plateNumber: vehicleInfo.plate_number,
      },
    },
    ownerInfo: { nickname: order.ownerName, nickName: order.ownerName, phone: order.ownerPhone },
    quotes: quotes.map(q => ({
      quote_id: q.quote_id,
      merchantName: q.merchantName,
      quoteType: 'non-oem',
      amount: q.amount,
      submitTime: q.created_at,
      nonOemQuote: { totalAmount: q.amount, partsCost: q.amount, laborCost: 0, materialCost: 0 },
    })),
    repairOrder: null,
    selectedMerchantInfo: { name: order.shopName },
    refunds: rebateRows.map(r => ({
      transaction_id: r.transaction_id,
      amount: r.amount,
      refundAmount: r.amount,
      reward_tier: r.rewardTier,
      review_stage: r.reviewStage,
      tax_deducted: r.taxDeducted,
      createTime: r.created_at,
      type: 'order',
    })),
    complaints: [],
    review: null,
    settlementProofs: [],
  };

  return { success: true, data: orderDetail };
}

async function auditQuote(db, req) {
  return { success: true, message: '审核成功' };
}

// ===================== 统计 statistics =====================
async function getStatistics(db, req) {
  const { startDate, endDate } = req.query;

  const [userCount] = await db.execute('SELECT COUNT(*) as c FROM users WHERE status = 1');
  const [shopCount] = await db.execute('SELECT COUNT(*) as c FROM shops WHERE status = 1');
  const [orderCount] = await db.execute('SELECT COUNT(*) as c FROM orders');
  const [orderAmount] = await db.execute('SELECT COALESCE(SUM(quoted_amount), 0) as total FROM orders WHERE status = 3');
  const [completedCount] = await db.execute('SELECT COUNT(*) as c FROM orders WHERE status = 3');
  const [todayOrders] = await db.execute(
    "SELECT COUNT(*) as c FROM orders WHERE DATE(created_at) = CURDATE()"
  );
  const [todayAmount] = await db.execute(
    "SELECT COALESCE(SUM(quoted_amount), 0) as total FROM orders WHERE status = 3 AND DATE(COALESCE(completed_at, updated_at)) = CURDATE()"
  );

  let monthlyWhere = '';
  const monthlyParams = [];
  if (startDate) { monthlyWhere += ' AND DATE(created_at) >= ?'; monthlyParams.push(startDate); }
  if (endDate) { monthlyWhere += ' AND DATE(created_at) <= ?'; monthlyParams.push(endDate); }

  const [monthlyRows] = await db.execute(
    `SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as count
     FROM orders WHERE 1=1 ${monthlyWhere}
     GROUP BY DATE_FORMAT(created_at, '%Y-%m')
     ORDER BY month`,
    monthlyParams
  );

  const monthlyOrders = {};
  monthlyRows.forEach(r => { monthlyOrders[r.month] = r.count; });

  const total = orderCount[0].c;
  const completed = completedCount[0].c;
  const completionRate = total > 0 ? ((completed / total) * 100).toFixed(2) : 0;

  const [rewardTotalRow] = await db.execute(
    "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'rebate' AND amount > 0"
  );
  const rewardTotal = parseFloat(rewardTotalRow[0]?.total || 0);

  const [rewardByTier] = await db.execute(
    `SELECT COALESCE(reward_tier, 0) as tier, SUM(amount) as total
     FROM transactions WHERE type = 'rebate' AND amount > 0
     GROUP BY reward_tier`
  );
  const rewardDistributionByTier = {};
  const tierNames = { 0: '未分级', 1: '一级', 2: '二级', 3: '三级', 4: '四级' };
  rewardByTier.forEach(r => {
    rewardDistributionByTier[tierNames[r.tier] || `第${r.tier}级`] = parseFloat(r.total || 0);
  });

  const [rewardByStage] = await db.execute(
    `SELECT COALESCE(review_stage, 'main') as stage, SUM(amount) as total
     FROM transactions WHERE type = 'rebate' AND amount > 0
     GROUP BY review_stage`
  );
  const rewardDistributionByStage = {};
  const stageNames = { main: '主评价', '1m': '1个月追评', '3m': '3个月追评' };
  rewardByStage.forEach(r => {
    rewardDistributionByStage[stageNames[r.stage] || r.stage || '其他'] = parseFloat(r.total || 0);
  });

  return {
    success: true,
    data: {
      totalUsers: userCount[0].c,
      totalMerchants: shopCount[0].c,
      totalOrders: total,
      totalOrderAmount: parseFloat(orderAmount[0].total),
      todayOrders: todayOrders[0].c,
      todayAmount: parseFloat(todayAmount[0]?.total || 0),
      completionRate: parseFloat(completionRate),
      monthlyOrders,
      rewardTotal,
      rewardDistributionByTier,
      rewardDistributionByStage,
    },
  };
}

// ===================== 结算 settlements =====================
async function getSettlements(db, req) {
  const [orders] = await db.execute(
    `SELECT o.order_id as orderNo, s.name as merchantName, o.quoted_amount as orderAmount,
            o.commission as commission, o.completed_at as settlementTime
     FROM orders o
     LEFT JOIN shops s ON o.shop_id = s.shop_id
     WHERE o.status = 3 AND o.completed_at IS NOT NULL
     ORDER BY o.completed_at DESC LIMIT 100`
  );
  const [refunds] = await db.execute(
    `SELECT t.transaction_id, o.order_id as orderNo, u.nickname as ownerName,
            t.amount as refundAmount, t.created_at as arrivalTime,
            t.reward_tier as rewardTier, t.review_stage as reviewStage, t.tax_deducted as taxDeducted
     FROM transactions t
     LEFT JOIN orders o ON t.related_id = o.order_id
     LEFT JOIN users u ON t.user_id = u.user_id
     WHERE t.type = 'rebate' AND t.amount > 0
     ORDER BY t.created_at DESC LIMIT 50`
  );
  return {
    success: true,
    data: {
      settlements: orders,
      refunds: refunds.map(r => ({
        ...r,
        refundType: 'order',
        reward_tier: r.rewardTier,
        review_stage: r.reviewStage,
        tax_deducted: r.taxDeducted,
      })),
      deposits: [],
    },
  };
}

// ===================== 配置 config =====================
async function getConfig(db, req) {
  const [rows] = await db.execute('SELECT `key`, `value` FROM settings');
  const configList = rows.map(r => ({ key: r.key, value: r.value }));
  return { success: true, data: configList };
}

async function putConfig(db, req) {
  const { key, value } = req.body || {};
  if (!key) return { success: false, error: 'key 不能为空', statusCode: 400 };
  await db.execute(
    'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
    [key, String(value), String(value)]
  );
  return { success: true, message: '保存成功' };
}

async function batchConfig(db, req) {
  const items = req.body.items || [];
  for (const item of items) {
    if (item.key) {
      await db.execute(
        'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
        [item.key, String(item.value), String(item.value)]
      );
    }
  }
  return { success: true, message: '保存成功' };
}

// ===================== 奖励金规则 reward-rules =====================
async function getComplexityLevels(db, req) {
  const [rows] = await db.execute(
    'SELECT id, `level`, project_type as projectType, fixed_reward as fixedReward, float_ratio as floatRatio, cap_amount as capAmount FROM repair_complexity_levels ORDER BY `level`'
  );
  return { success: true, data: rows };
}

async function postComplexityLevel(db, req) {
  const { level, projectType, fixedReward, floatRatio, capAmount } = req.body || {};
  if (!level || !projectType) return { success: false, error: 'level、projectType 必填', statusCode: 400 };
  await db.execute(
    'INSERT INTO repair_complexity_levels (`level`, project_type, fixed_reward, float_ratio, cap_amount) VALUES (?, ?, ?, ?, ?)',
    [level, projectType, fixedReward || 0, floatRatio || 0, capAmount || 0]
  );
  return { success: true, message: '添加成功' };
}

async function putComplexityLevel(db, req) {
  const { id } = req.params;
  const { level, projectType, fixedReward, floatRatio, capAmount } = req.body || {};
  await db.execute(
    'UPDATE repair_complexity_levels SET `level`=COALESCE(?,`level`), project_type=COALESCE(?,project_type), fixed_reward=COALESCE(?,fixed_reward), float_ratio=COALESCE(?,float_ratio), cap_amount=COALESCE(?,cap_amount) WHERE id=?',
    [level, projectType, fixedReward, floatRatio, capAmount, id]
  );
  return { success: true, message: '更新成功' };
}

async function deleteComplexityLevel(db, req) {
  await db.execute('DELETE FROM repair_complexity_levels WHERE id = ?', [req.params.id]);
  return { success: true, message: '删除成功' };
}

async function getRewardRules(db, req) {
  const [rows] = await db.execute('SELECT id, rule_key as ruleKey, rule_value as ruleValue, description FROM reward_rules');
  const rules = {};
  rows.forEach(r => { rules[r.ruleKey] = { ...r, value: r.ruleValue ? (typeof r.ruleValue === 'string' ? JSON.parse(r.ruleValue || '{}') : r.ruleValue) : {} }; });
  return { success: true, data: rows };
}

async function postRewardRule(db, req) {
  const { ruleKey, ruleValue, description } = req.body || {};
  if (!ruleKey) return { success: false, error: 'ruleKey 必填', statusCode: 400 };
  const val = typeof ruleValue === 'object' ? JSON.stringify(ruleValue) : String(ruleValue || '{}');
  await db.execute(
    'INSERT INTO reward_rules (rule_key, rule_value, description) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE rule_value=VALUES(rule_value), description=VALUES(description)',
    [ruleKey, val, description || '']
  );
  return { success: true, message: '保存成功' };
}

// ===================== 评价审核 review-audit =====================
async function getReviewAuditList(db, req) {
  const { page = 1, pageSize = 20, status, pool: auditPool } = req.query; // auditPool 避免与 db pool 冲突
  const offset = (parseInt(page) - 1) * parseInt(pageSize);
  let where = 'WHERE 1=1';
  const params = [];

  if (auditPool === 'mandatory') {
    where += ` AND (
      o.complexity_level IN ('L3','L4')
      OR COALESCE(r.reward_amount, r.rebate_amount, 0) > 800
    )`;
  }
  if (auditPool === 'sample') {
    const sampleRate = 5;
    where += ` AND o.complexity_level IN ('L1','L2') AND (CRC32(r.review_id) % 100) < ?`;
    params.push(sampleRate);
  }

  const [list] = await db.execute(
    `SELECT r.review_id as reviewId, r.order_id as orderId, r.type, r.review_stage as reviewStage, r.rating, r.content, r.created_at as createTime,
            r.reward_amount as rewardAmount, o.complexity_level as complexityLevel,
            rl.result as auditResult, rl.missing_items as missingItems, rl.audit_type as auditType
     FROM reviews r
     LEFT JOIN orders o ON r.order_id = o.order_id
     LEFT JOIN (
       SELECT r1.review_id, r1.result, r1.missing_items, r1.audit_type
       FROM review_audit_logs r1
       INNER JOIN (SELECT review_id, MAX(id) as max_id FROM review_audit_logs GROUP BY review_id) r2 ON r1.review_id = r2.review_id AND r1.id = r2.max_id
     ) rl ON r.review_id = rl.review_id
     ${where}
     ORDER BY r.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, parseInt(pageSize), offset]
  );
  const [countRes] = await db.execute(
    `SELECT COUNT(*) as total FROM reviews r LEFT JOIN orders o ON r.order_id = o.order_id ${where}`,
    params
  );

  let resultList = list;
  if (status === 'rejected') {
    resultList = list.filter(r => r.auditResult === 'reject');
  }
  return {
    success: true,
    data: {
      list: resultList,
      total: status === 'rejected' ? resultList.length : (countRes[0]?.total || 0),
    },
  };
}

async function postReviewAuditManual(db, req) {
  const { reviewId } = req.params;
  const { result, missingItems } = req.body || {};
  if (!result || !['pass', 'reject'].includes(result)) {
    return { success: false, error: 'result 必填且为 pass 或 reject', statusCode: 400 };
  }
  const operatorId = req.adminUserId || req.adminUser || 'admin';
  await db.execute(
    'INSERT INTO review_audit_logs (review_id, audit_type, result, missing_items, operator_id) VALUES (?, ?, ?, ?, ?)',
    [reviewId, 'manual', result, missingItems ? JSON.stringify(missingItems) : null, operatorId]
  );
  return { success: true, message: '复核完成' };
}

// ===================== 破格升级 complexity-upgrade =====================
async function getComplexityUpgradeList(db, req) {
  const { page = 1, pageSize = 20, status } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(pageSize);
  let where = 'WHERE 1=1';
  const params = [];
  if (status !== undefined && status !== '') {
    where += ' AND cur.status = ?';
    params.push(parseInt(status));
  }
  const [list] = await db.execute(
    `SELECT cur.id, cur.request_id as requestId, cur.order_id as orderId, cur.user_id as userId, cur.current_level as currentLevel,
            cur.requested_level as requestedLevel, cur.reason, cur.status, cur.created_at as createTime,
            u.nickname as userName
     FROM complexity_upgrade_requests cur
     LEFT JOIN users u ON cur.user_id = u.user_id
     ${where}
     ORDER BY cur.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, parseInt(pageSize), offset]
  );
  const [countRes] = await db.execute(`SELECT COUNT(*) as total FROM complexity_upgrade_requests cur ${where}`, params);
  return { success: true, data: { list, total: countRes[0]?.total || 0 } };
}

async function postComplexityUpgradeAudit(db, req) {
  const { requestId } = req.params;
  const { status } = req.body || {};
  if (![1, 2].includes(parseInt(status))) {
    return { success: false, error: 'status 需为 1(通过) 或 2(拒绝)', statusCode: 400 };
  }
  const operatorId = req.adminUserId || req.adminUser || 'admin';
  await db.execute(
    'UPDATE complexity_upgrade_requests SET status = ?, auditor_id = ?, audited_at = NOW() WHERE request_id = ?',
    [parseInt(status), operatorId, requestId]
  );
  return { success: true, message: '审核完成' };
}

// ===================== 防刷 antifraud =====================
async function getBlacklist(db, req) {
  try {
    const [rows] = await db.execute(
      'SELECT id, blacklist_type as type, blacklist_value as value, reason, created_at as createTime FROM blacklist ORDER BY id DESC'
    );
    return { success: true, data: rows };
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return { success: true, data: [] };
    throw err;
  }
}

async function postBlacklist(db, req) {
  const { type, value, reason } = req.body || {};
  if (!type || !value) return { success: false, error: 'type、value 必填', statusCode: 400 };
  const validTypes = ['user_id', 'phone', 'device_id', 'ip', 'id_card'];
  if (!validTypes.includes(type)) return { success: false, error: 'type 需为 user_id/phone/device_id/ip/id_card', statusCode: 400 };
  try {
    await db.execute(
      'INSERT INTO blacklist (blacklist_type, blacklist_value, reason) VALUES (?, ?, ?)',
      [type, String(value).trim(), reason || null]
    );
    await antifraud.writeAuditLog(db, {
      logType: 'blacklist',
      action: 'create',
      targetTable: 'blacklist',
      newValue: { type, value: String(value).trim(), reason },
      operatorId: req.adminUserId || 'admin',
      ip: req.ip || req.headers?.['x-forwarded-for'],
    });
    return { success: true, message: '添加成功' };
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return { success: false, error: '请先执行防刷迁移脚本 migration-20260215-phase2-antifraud.sql', statusCode: 500 };
    throw err;
  }
}

async function deleteBlacklist(db, req) {
  try {
    const [rows] = await db.execute('SELECT blacklist_type, blacklist_value FROM blacklist WHERE id = ?', [req.params.id]);
    await db.execute('DELETE FROM blacklist WHERE id = ?', [req.params.id]);
    if (rows.length > 0) {
      await antifraud.writeAuditLog(db, {
        logType: 'blacklist',
        action: 'delete',
        targetTable: 'blacklist',
        targetId: req.params.id,
        oldValue: rows[0],
        operatorId: req.adminUserId || 'admin',
        ip: req.ip || req.headers?.['x-forwarded-for'],
      });
    }
    return { success: true, message: '删除成功' };
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return { success: false, error: '请先执行防刷迁移脚本', statusCode: 500 };
    throw err;
  }
}

async function getAntifraudConfig(db, req) {
  const cfg = await antifraud.getAntifraudConfig(db);
  return { success: true, data: cfg };
}

async function putAntifraudConfig(db, req) {
  const mapping = {
    orderSameShopDays: 'antifraud_order_same_shop_days',
    orderSameShopMax: 'antifraud_order_same_shop_max',
    newUserDays: 'antifraud_new_user_days',
    newUserOrderMax: 'antifraud_new_user_order_max',
    l1MonthlyCap: 'antifraud_l1_monthly_cap',
    l1l2FreezeDays: 'antifraud_l1l2_freeze_days',
    l1l2SampleRate: 'antifraud_l1l2_sample_rate',
  };
  for (const [camel, key] of Object.entries(mapping)) {
    if (req.body[camel] !== undefined) {
      await db.execute(
        'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
        [key, String(req.body[camel]), String(req.body[camel])]
      );
    }
  }
  await antifraud.writeAuditLog(db, {
    logType: 'config',
    action: 'update',
    targetTable: 'settings',
    newValue: req.body,
    operatorId: req.adminUserId || 'admin',
    ip: req.ip || req.headers?.['x-forwarded-for'],
  });
  return { success: true, message: '保存成功' };
}

async function getViolations(db, req) {
  try {
    const { page = 1, pageSize = 20, targetType, level, status } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(pageSize);
    let where = 'WHERE 1=1';
    const params = [];
    if (targetType) { where += ' AND target_type = ?'; params.push(targetType); }
    if (level) { where += ' AND violation_level = ?'; params.push(parseInt(level)); }
    if (status !== undefined && status !== '') { where += ' AND status = ?'; params.push(parseInt(status)); }
    const [list] = await db.execute(
      `SELECT record_id as recordId, target_type as targetType, target_id as targetId, violation_level as level,
              violation_type as violationType, related_order_id as orderId, related_review_id as reviewId,
              description, penalty_applied as penaltyApplied, status, created_at as createTime
       FROM violation_records ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(pageSize), offset]
    );
    const [countRes] = await db.execute(`SELECT COUNT(*) as total FROM violation_records ${where}`, params);
    return { success: true, data: { list, total: countRes[0]?.total || 0 } };
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return { success: true, data: { list: [], total: 0 } };
    throw err;
  }
}

async function postViolation(db, req) {
  const { targetType, targetId, level, violationType, orderId, reviewId, description, penalty } = req.body || {};
  if (!targetType || !targetId || !level) return { success: false, error: 'targetType、targetId、level 必填', statusCode: 400 };
  try {
    const recordId = 'VIO' + Date.now();
    await db.execute(
      `INSERT INTO violation_records (record_id, target_type, target_id, violation_level, violation_type,
       related_order_id, related_review_id, description, penalty_applied, status, operator_id, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW())`,
      [recordId, targetType, targetId, parseInt(level), violationType || null, orderId || null, reviewId || null,
        description || null, penalty ? JSON.stringify(penalty) : null, req.adminUserId || 'admin']
    );
    if (targetType === 'user' && [3, 4].includes(parseInt(level))) {
      await db.execute('UPDATE users SET status = 0 WHERE user_id = ?', [targetId]);
      try {
        await db.execute(
          'INSERT IGNORE INTO blacklist (blacklist_type, blacklist_value, reason) VALUES (?, ?, ?)',
          ['user_id', targetId, `违规${level}级处罚`]
        );
      } catch (_) {}
    }
    await antifraud.writeAuditLog(db, {
      logType: 'violation',
      action: 'create',
      targetTable: 'violation_records',
      targetId: recordId,
      newValue: { targetType, targetId, level, description, penalty },
      operatorId: req.adminUserId || 'admin',
      ip: req.ip || req.headers?.['x-forwarded-for'],
    });
    return { success: true, data: { recordId }, message: '处理完成' };
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return { success: false, error: '请先执行 migration-20260215-phase3-antifraud.sql', statusCode: 500 };
    throw err;
  }
}

async function getAuditLogs(db, req) {
  try {
    const { page = 1, pageSize = 50, logType, startDate, endDate } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(pageSize);
    let where = 'WHERE 1=1';
    const params = [];
    if (logType) { where += ' AND log_type = ?'; params.push(logType); }
    if (startDate) { where += ' AND created_at >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND created_at <= ?'; params.push(endDate + ' 23:59:59'); }
    const [list] = await db.execute(
      `SELECT id, log_type as logType, action, target_table as targetTable, target_id as targetId,
              operator_id as operatorId, ip, created_at as createTime
       FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(pageSize), offset]
    );
    const [countRes] = await db.execute(`SELECT COUNT(*) as total FROM audit_logs ${where}`, params);
    return { success: true, data: { list, total: countRes[0]?.total || 0 } };
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return { success: true, data: { list: [], total: 0 } };
    throw err;
  }
}

async function getAntifraudStatistics(db, req) {
  const { startDate, endDate } = req.query;
  const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const end = endDate || new Date().toISOString().slice(0, 10);

  const [orderCount] = await db.execute(
    'SELECT COUNT(*) as c FROM orders WHERE created_at >= ? AND created_at <= ?',
    [start, end + ' 23:59:59']
  );
  const [reviewCount] = await db.execute(
    'SELECT COUNT(*) as c FROM reviews WHERE created_at >= ? AND created_at <= ? AND type = 1',
    [start, end + ' 23:59:59']
  );
  const [violationCount] = await db.execute(
    'SELECT COUNT(*) as c FROM violation_records WHERE created_at >= ? AND created_at <= ?',
    [start, end + ' 23:59:59']
  ).catch(() => [{ c: 0 }]);
  const [blacklistCount] = await db.execute('SELECT COUNT(*) as c FROM blacklist').catch(() => [{ c: 0 }]);
  const [rewardTotal] = await db.execute(
    `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'rebate' AND created_at >= ? AND created_at <= ?`,
    [start, end + ' 23:59:59']
  );

  return {
    success: true,
    data: {
      orderCount: orderCount[0]?.c || 0,
      reviewCount: reviewCount[0]?.c || 0,
      violationCount: violationCount[0]?.c || 0,
      blacklistCount: blacklistCount[0]?.c || 0,
      rewardTotal: parseFloat(rewardTotal[0]?.total || 0),
      dateRange: { start, end },
    },
  };
}

// ===================== 投诉 complaints（占位） =====================
async function getComplaints(db, req) {
  return { success: true, data: [] };
}

async function putComplaint(db, req) {
  return { success: true, message: '处理成功' };
}

module.exports = {
  login,
  getMerchants,
  qualificationAudit,
  merchantAudit,
  getOrders,
  getOrderDetail,
  auditQuote,
  getStatistics,
  getSettlements,
  getConfig,
  putConfig,
  batchConfig,
  getComplexityLevels,
  postComplexityLevel,
  putComplexityLevel,
  deleteComplexityLevel,
  getRewardRules,
  postRewardRule,
  getReviewAuditList,
  postReviewAuditManual,
  getComplexityUpgradeList,
  postComplexityUpgradeAudit,
  getBlacklist,
  postBlacklist,
  deleteBlacklist,
  getAntifraudConfig,
  putAntifraudConfig,
  getViolations,
  postViolation,
  getAuditLogs,
  getAntifraudStatistics,
  getComplaints,
  putComplaint,
};
