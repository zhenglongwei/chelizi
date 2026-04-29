/**
 * 管理端服务
 * 按领域拆分：登录、merchants、orders、config、reward-rules、antifraud
 */

const crypto = require('crypto');
const antifraud = require('../antifraud');
const reviewStarAiAnomalyConfig = require('../utils/review-star-ai-anomaly-config');

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

/**
 * Express 的 req.query 里 page/pageSize 常为字符串；若为 '' 则 parseInt 为 NaN，
 * 传入 LIMIT ? OFFSET ? 会触发 MySQL：Incorrect arguments to mysqld_stmt_execute
 */
function normalizePagination(query, defaultPage = 1, defaultPageSize = 20, maxPageSize = 100) {
  const q = query || {};
  let page = parseInt(q.page, 10);
  let pageSize = parseInt(q.pageSize, 10);
  if (!Number.isFinite(page) || page < 1) page = defaultPage;
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = defaultPageSize;
  pageSize = Math.min(maxPageSize, pageSize);
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}

/**
 * mysql2 的 execute（二进制协议）在部分 MySQL/MariaDB 上对 LIMIT/OFFSET 占位符支持差，
 * 会报 Incorrect arguments to mysqld_stmt_execute。分页数字已由 normalizePagination 约束为安全整数，
 * 此处写入 SQL 字面量（非用户原始字符串拼接）。
 */
function sqlLimitOffsetFragment(pageSize, offset, maxLimit = 500) {
  const lim = Math.trunc(Number(pageSize));
  const off = Math.trunc(Number(offset));
  if (!Number.isFinite(lim) || !Number.isFinite(off) || lim < 1 || lim > maxLimit || off < 0) {
    throw new Error('分页参数非法');
  }
  return ` LIMIT ${lim} OFFSET ${off}`;
}

// ===================== 服务商 merchants =====================
async function getMerchants(db, req) {
  const { auditStatus, qualificationAuditStatus, keyword } = req.query;
  const { pageSize, offset } = normalizePagination(req.query, 1, 10, 100);

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
     ${sqlLimitOffsetFragment(pageSize, offset)}`,
    [...params]
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

  return { success: true, data: { list: listWithCerts, total: Number(countRes[0].total) } };
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
    const [shopRow] = await db.execute(
      'SELECT qualification_ai_recognized FROM shops WHERE shop_id = ?',
      [shopId]
    );
    const qualLevel = shopRow[0]?.qualification_ai_recognized || null;
    await db.execute(
      'UPDATE shops SET qualification_status = 1, qualification_level = COALESCE(qualification_level, ?), qualification_audit_reason = NULL, updated_at = NOW() WHERE shop_id = ?',
      [qualLevel, shopId]
    );
    try {
      const msgId = 'mmsg_' + crypto.randomBytes(12).toString('hex');
      await db.execute(
        `INSERT INTO merchant_messages (message_id, merchant_id, type, title, content, related_id, is_read)
         VALUES (?, ?, 'qualification_audit', ?, ?, ?, 0)`,
        [msgId, id, '资质审核已通过', '恭喜，您的维修资质已审核通过，现可正常接单并在车主端展示。', shopId]
      );
      const subMsg = require('./subscribe-message-service');
      subMsg.sendToMerchant(
        db,
        id,
        'merchant_qualification_audit',
        { title: '审核通过', content: '现可接单', relatedId: shopId },
        process.env.WX_APPID,
        process.env.WX_SECRET
      ).catch(() => {});
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
    const content = `您的资质审核未通过。原因：${reason}。请修改后重新提交。`;
    await db.execute(
      `INSERT INTO merchant_messages (message_id, merchant_id, type, title, content, related_id, is_read)
       VALUES (?, ?, 'qualification_audit', ?, ?, ?, 0)`,
      [msgId, id, '资质审核被驳回', content, shopId]
    );
    const subMsg = require('./subscribe-message-service');
    subMsg.sendToMerchant(
      db,
      id,
      'merchant_qualification_audit',
      { title: '审核驳回', content: '请修改后重交', relatedId: shopId },
      process.env.WX_APPID,
      process.env.WX_SECRET
    ).catch(() => {});
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
  const { orderNo, status, ownerId, merchantId, startDate, endDate } = req.query;
  const { pageSize, offset } = normalizePagination(req.query, 1, 20, 100);

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
     ${sqlLimitOffsetFragment(pageSize, offset)}`,
    [...params]
  );

  const [countRes] = await db.execute(
    `SELECT COUNT(*) as total FROM orders o ${where}`,
    params
  );

  return { success: true, data: { list, total: Number(countRes[0].total) } };
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

  const order = orders[0];

  // 拆检费/拆检收据等线下留痕（用于“取消交易处置”判断）
  let offlineFeeProofs = [];
  try {
    const [proofRows] = await db.execute(
      `SELECT proof_id, uploader_type, uploader_id, proof_kind, amount, note, image_urls, created_at
       FROM order_offline_fee_proofs
       WHERE order_id = ?
       ORDER BY created_at DESC`,
      [orderNo]
    );
    offlineFeeProofs = (proofRows || []).map((r) => {
      let urls = r.image_urls;
      if (typeof urls === 'string') {
        try { urls = JSON.parse(urls || '[]'); } catch (_) { urls = []; }
      }
      return { ...r, image_urls: Array.isArray(urls) ? urls : [] };
    });
  } catch (_) {
    offlineFeeProofs = [];
  }

  // 最近一次“取消交易处置结案”事件摘要（可选展示）
  let cancelDisposal = null;
  try {
    const [evtRows] = await db.execute(
      `SELECT event_id, event_type, actor_type, actor_id, payload, created_at
       FROM order_lifecycle_events
       WHERE order_id = ? AND event_type IN ('cancel_disposal_closed')
       ORDER BY created_at DESC
       LIMIT 1`,
      [orderNo]
    );
    if (evtRows && evtRows.length > 0) {
      const e = evtRows[0];
      let payload = e.payload;
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload || '{}'); } catch (_) { payload = {}; }
      }
      cancelDisposal = {
        event_id: e.event_id,
        event_type: e.event_type,
        actor_type: e.actor_type,
        actor_id: e.actor_id,
        payload: payload && typeof payload === 'object' ? payload : {},
        created_at: e.created_at,
      };
    }
  } catch (_) {
    cancelDisposal = null;
  }

  // 奖励金记录：transactions.related_id 存的是 review_id，需通过 reviews 关联
  const [rebateRows] = await db.execute(
    `SELECT t.transaction_id, t.type, t.amount, t.reward_tier as rewardTier, t.review_stage as reviewStage,
            t.tax_deducted as taxDeducted, t.created_at
     FROM transactions t
     JOIN reviews r ON t.related_id = r.review_id
     WHERE t.type IN ('rebate', 'upgrade_diff', 'like_bonus') AND r.order_id = ?
     ORDER BY t.created_at`,
    [orderNo]
  );

  // 实际奖励金合计（已完成订单）
  let actualReward = null;
  if (order.status === 3 && rebateRows.length > 0) {
    actualReward = rebateRows.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);
  }

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

  // 成交信息：从 orders + 选中报价构建
  let repairOrder = null;
  const selectedQuote = quotes.find(q => q.quote_id === order.quote_id) || quotes[0];
  if (selectedQuote) {
    repairOrder = {
      merchantName: selectedQuote.merchantName || order.shopName,
      selectedQuote: {
        type: 'non-oem',
        totalAmount: order.quoted_amount,
      },
      finalSettlement: {
        finalAmount: order.actual_amount,
        additionalAmount: 0,
        commission: {
          platform: order.commission,
          ownerRefund: null,
        },
        settlementTime: order.completed_at,
      },
      progress: { steps: [] },
      additionalItems: [],
      completion_evidence: order.completion_evidence,
    };
  }

  // 评价信息
  const [reviewRows] = await db.execute(
    `SELECT review_id, order_id, rating, content, type, review_stage, created_at
     FROM reviews WHERE order_id = ? ORDER BY type, created_at`,
    [orderNo]
  );
  const reviewList = reviewRows.map(r => ({ ...r, createTime: r.created_at }));
  const review = reviewList.length > 0 ? reviewList[0] : null;

  // 定损材料：orders -> biddings -> damage_reports
  let settlementProofs = [];
  if (order.bidding_id) {
    const [biddingRows] = await db.execute(
      'SELECT report_id FROM biddings WHERE bidding_id = ?',
      [order.bidding_id]
    );
    if (biddingRows.length > 0 && biddingRows[0].report_id) {
      const [damageRows] = await db.execute(
        'SELECT images FROM damage_reports WHERE report_id = ?',
        [biddingRows[0].report_id]
      );
      if (damageRows.length > 0 && damageRows[0].images) {
        let imgs = damageRows[0].images;
        if (typeof imgs === 'string') {
          try { imgs = JSON.parse(imgs); } catch (_) { imgs = []; }
        }
        if (Array.isArray(imgs) && imgs.length > 0) {
          settlementProofs = [{ title: '事故照片', files: imgs }];
        }
      }
    }
  }

  const orderDetail = {
    order: {
      orderNo: order.order_id,
      status: order.status,
      lifecycle_main: order.lifecycle_main || null,
      lifecycle_sub: order.lifecycle_sub || null,
      quotedAmount: order.quoted_amount,
      actualAmount: order.actual_amount,
      orderTier: order.order_tier,
      complexityLevel: order.complexity_level,
      rewardPreview: order.reward_preview,
      actualReward,
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
    repairOrder,
    selectedMerchantInfo: { name: order.shopName },
    refunds: rebateRows.map(r => ({
      _id: r.transaction_id,
      transaction_id: r.transaction_id,
      amount: r.amount,
      refundAmount: r.amount,
      reward_tier: r.rewardTier,
      review_stage: r.reviewStage,
      tax_deducted: r.taxDeducted,
      createTime: r.created_at,
      type: r.type === 'rebate' ? 'order' : r.type,
      status: 'paid',
    })),
    complaints: [],
    review,
    reviewList: reviewList || [],
    settlementProofs,
    offline_fee_proofs: offlineFeeProofs,
    cancel_disposal: cancelDisposal,
  };

  return { success: true, data: orderDetail };
}

async function auditQuote(db, req) {
  return { success: true, message: '审核成功' };
}

// ===================== 统计 statistics =====================
async function getStatistics(db, req) {
  const startRaw = req.query.startDate;
  const endRaw = req.query.endDate;
  const startDate = Array.isArray(startRaw) ? startRaw[0] : startRaw;
  const endDate = Array.isArray(endRaw) ? endRaw[0] : endRaw;

  // 统计类聚合走 query（文本协议），避免部分环境下 execute 预处理与 GROUP BY 等组合触发 stmt_execute 异常
  const [userCount] = await db.query('SELECT COUNT(*) as c FROM users WHERE status = 1');
  const [shopCount] = await db.query('SELECT COUNT(*) as c FROM shops WHERE status = 1');
  const [orderCount] = await db.query('SELECT COUNT(*) as c FROM orders');
  const [orderAmount] = await db.query('SELECT COALESCE(SUM(quoted_amount), 0) as total FROM orders WHERE status = 3');
  const [completedCount] = await db.query('SELECT COUNT(*) as c FROM orders WHERE status = 3');
  const [todayOrders] = await db.query(
    "SELECT COUNT(*) as c FROM orders WHERE DATE(created_at) = CURDATE()"
  );
  const [todayAmount] = await db.query(
    "SELECT COALESCE(SUM(quoted_amount), 0) as total FROM orders WHERE status = 3 AND DATE(COALESCE(completed_at, updated_at)) = CURDATE()"
  );

  let monthlyWhere = '';
  const monthlyParams = [];
  if (startDate) {
    monthlyWhere += ' AND DATE(created_at) >= ?';
    monthlyParams.push(String(startDate).slice(0, 10));
  }
  if (endDate) {
    monthlyWhere += ' AND DATE(created_at) <= ?';
    monthlyParams.push(String(endDate).slice(0, 10));
  }

  const [monthlyRows] = await db.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as count
     FROM orders WHERE 1=1 ${monthlyWhere}
     GROUP BY DATE_FORMAT(created_at, '%Y-%m')
     ORDER BY month`,
    monthlyParams
  );

  const monthlyOrders = {};
  monthlyRows.forEach(r => { monthlyOrders[r.month] = r.count; });

  const total = Number(orderCount[0].c);
  const completed = Number(completedCount[0].c);
  const completionRate = total > 0 ? ((completed / total) * 100).toFixed(2) : 0;

  const [rewardTotalRow] = await db.query(
    "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'rebate' AND amount > 0"
  );
  const rewardTotal = parseFloat(rewardTotalRow[0]?.total || 0);

  const [rewardByTier] = await db.query(
    `SELECT COALESCE(reward_tier, 0) as tier, SUM(amount) as total
     FROM transactions WHERE type = 'rebate' AND amount > 0
     GROUP BY reward_tier`
  );
  const rewardDistributionByTier = {};
  const tierNames = { 0: '未分级', 1: '一级', 2: '二级', 3: '三级', 4: '四级' };
  rewardByTier.forEach(r => {
    rewardDistributionByTier[tierNames[r.tier] || `第${r.tier}级`] = parseFloat(r.total || 0);
  });

  const [rewardByStage] = await db.query(
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
      totalUsers: Number(userCount[0].c),
      totalMerchants: Number(shopCount[0].c),
      totalOrders: total,
      totalOrderAmount: parseFloat(orderAmount[0].total),
      todayOrders: Number(todayOrders[0].c),
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
function parseSettlementDateRange(req) {
  const q = req.query || {};
  let start = q.start || q.dateStart || null;
  let end = q.end || q.dateEnd || null;
  if (start) start = String(start).slice(0, 10);
  if (end) end = String(end).slice(0, 10);
  if (!start && !end) {
    const e = new Date();
    const s = new Date(e);
    s.setDate(s.getDate() - 90);
    start = s.toISOString().slice(0, 10);
    end = e.toISOString().slice(0, 10);
  }
  return { start, end };
}

async function getSettlements(db, req) {
  const { start, end } = parseSettlementDateRange(req);
  const startTs = `${start} 00:00:00`;
  const endTs = `${end} 23:59:59`;

  const [repairRows] = await db.execute(
    `SELECT 'repair' as orderKind, o.order_id as orderNo, s.name as merchantName,
            COALESCE(o.actual_amount, o.quoted_amount, 0) as orderAmount,
            COALESCE(o.commission_final, o.commission, 0) as commission,
            o.completed_at as settlementTime, o.commission_status as commissionStatus
     FROM orders o
     LEFT JOIN shops s ON o.shop_id = s.shop_id
     WHERE o.status = 3 AND o.completed_at IS NOT NULL
       AND o.completed_at >= ? AND o.completed_at <= ?
     ORDER BY o.completed_at DESC
     LIMIT 3000`,
    [startTs, endTs]
  );

  let productRows = [];
  try {
    const [pr] = await db.execute(
      `SELECT 'product' as orderKind, po.product_order_id as orderNo, s.name as merchantName,
              po.amount_total as orderAmount,
              COALESCE(po.platform_fee_yuan, 0) as commission,
              COALESCE(po.settled_at, po.paid_at, po.updated_at) as settlementTime,
              CONCAT('标品-', COALESCE(po.settlement_status, po.payment_status, '')) as commissionStatus
       FROM product_orders po
       JOIN shops s ON po.shop_id = s.shop_id
       WHERE po.payment_status = 'paid'
         AND COALESCE(po.settled_at, po.paid_at, po.created_at) >= ?
         AND COALESCE(po.settled_at, po.paid_at, po.created_at) <= ?
       ORDER BY COALESCE(po.settled_at, po.paid_at, po.updated_at) DESC
       LIMIT 3000`,
      [startTs, endTs]
    );
    productRows = pr;
  } catch (e) {
    console.warn('[getSettlements] product_orders:', e.message);
  }

  const settlements = [...repairRows, ...productRows].sort((a, b) => {
    const ta = a.settlementTime ? new Date(a.settlementTime).getTime() : 0;
    const tb = b.settlementTime ? new Date(b.settlementTime).getTime() : 0;
    return tb - ta;
  });

  let refunds = [];
  try {
    const [revRows] = await db.execute(
      `SELECT r.review_id as reviewId,
              COALESCE(o.order_id, po.product_order_id, r.order_id) as orderNo,
              CASE
                WHEN o.order_id IS NOT NULL THEN 'repair'
                WHEN po.product_order_id IS NOT NULL THEN 'product'
                ELSE 'unknown'
              END as orderKind,
              u.nickname as ownerName,
              COALESCE(t.amount, 0) as refundAmount,
              COALESCE(t.created_at, r.created_at) as arrivalTime,
              t.reward_tier as rewardTier,
              COALESCE(t.review_stage, r.review_stage, 'main') as reviewStage,
              COALESCE(t.tax_deducted, r.tax_deducted, 0) as taxDeducted,
              t.transaction_id as transaction_id
       FROM reviews r
       LEFT JOIN transactions t ON t.related_id = r.review_id AND t.type = 'rebate'
       LEFT JOIN users u ON r.user_id = u.user_id
       LEFT JOIN orders o ON r.order_id = o.order_id
       LEFT JOIN product_orders po ON r.order_id = po.product_order_id
       WHERE r.status = 1
         AND COALESCE(t.created_at, r.created_at) >= ?
         AND COALESCE(t.created_at, r.created_at) <= ?
       ORDER BY COALESCE(t.created_at, r.created_at) DESC
       LIMIT 3000`,
      [startTs, endTs]
    );
    refunds = revRows;
  } catch (e) {
    console.warn('[getSettlements] reviews rewards:', e.message);
    const [legacy] = await db.execute(
      `SELECT t.transaction_id, rev.review_id as reviewId,
              COALESCE(o.order_id, po.product_order_id, rev.order_id, t.related_id) as orderNo,
              CASE WHEN o.order_id IS NOT NULL THEN 'repair' WHEN po.product_order_id IS NOT NULL THEN 'product' ELSE 'unknown' END as orderKind,
              u.nickname as ownerName,
              COALESCE(t.amount, 0) as refundAmount, t.created_at as arrivalTime,
              t.reward_tier as rewardTier, t.review_stage as reviewStage, t.tax_deducted as taxDeducted
       FROM transactions t
       LEFT JOIN reviews rev ON t.related_id = rev.review_id
       LEFT JOIN orders o ON rev.order_id = o.order_id
       LEFT JOIN product_orders po ON rev.order_id = po.product_order_id
       LEFT JOIN users u ON t.user_id = u.user_id
       WHERE t.type = 'rebate'
         AND t.created_at >= ? AND t.created_at <= ?
       ORDER BY t.created_at DESC
       LIMIT 3000`,
      [startTs, endTs]
    );
    refunds = legacy;
  }

  let deposits = [];
  let commissionLedger = [];
  try {
    const [wallets] = await db.execute(
      `SELECT s.name as merchantName, w.shop_id as shopId, w.balance, w.frozen, w.deduct_mode as deductMode, w.updated_at as updateTime
       FROM merchant_commission_wallets w
       JOIN shops s ON w.shop_id = s.shop_id
       ORDER BY w.updated_at DESC LIMIT 200`
    );
    deposits = wallets;
  } catch (e) {
    console.warn('[getSettlements] commission wallets:', e.message);
  }
  try {
    const [led] = await db.execute(
      `SELECT l.ledger_id as ledgerId, l.shop_id as shopId, s.name as merchantName, l.type, l.amount,
              l.order_id as orderId, l.remark, l.created_at as createdAt
       FROM merchant_commission_ledger l
       JOIN shops s ON l.shop_id = s.shop_id
       WHERE l.created_at >= ? AND l.created_at <= ?
       ORDER BY l.id DESC
       LIMIT 2000`,
      [startTs, endTs]
    );
    commissionLedger = led;
  } catch (e) {
    console.warn('[getSettlements] commission ledger:', e.message);
  }

  return {
    success: true,
    data: {
      settlements,
      refunds: refunds.map((r) => ({
        ...r,
        refundType: 'order',
        reward_tier: r.rewardTier,
        review_stage: r.reviewStage,
        tax_deducted: r.taxDeducted,
      })),
      deposits,
      commissionLedger,
      dateRange: { start, end },
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

/** 获取完整奖励金规则配置（reward_rules.rewardRules） */
async function getRewardRulesConfig(db, req) {
  const rewardRulesLoader = require('./reward-rules-loader');
  const config = await rewardRulesLoader.getRewardRulesConfig(db);
  return { success: true, data: config };
}

/** 保存完整奖励金规则配置到 reward_rules 表（未提交 commissionRepair 时保留库内原值，避免与佣金规则页互相覆盖） */
async function saveRewardRulesConfig(db, req) {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object') {
    return { success: false, error: '配置不能为空', statusCode: 400 };
  }
  const rewardRulesLoader = require('./reward-rules-loader');
  let existing = {};
  try {
    existing = await rewardRulesLoader.getRewardRulesConfig(db);
  } catch (_) {
    existing = {};
  }
  const merged = { ...existing, ...incoming };
  if (!Object.prototype.hasOwnProperty.call(incoming, 'commissionRepair')) {
    if (existing.commissionRepair !== undefined) {
      merged.commissionRepair = existing.commissionRepair;
    }
  }
  if (
    typeof incoming.platformIncentiveV1 === 'object' &&
    incoming.platformIncentiveV1 !== null &&
    typeof existing.platformIncentiveV1 === 'object' &&
    existing.platformIncentiveV1 !== null
  ) {
    merged.platformIncentiveV1 = { ...existing.platformIncentiveV1, ...incoming.platformIncentiveV1 };
  } else if (!Object.prototype.hasOwnProperty.call(incoming, 'platformIncentiveV1') && existing.platformIncentiveV1) {
    merged.platformIncentiveV1 = existing.platformIncentiveV1;
  }
  const levels = merged.complexityLevels;
  if (!Array.isArray(levels) || levels.length === 0) {
    return { success: false, error: '模块1 复杂度等级不能为空，请至少配置一条', statusCode: 400 };
  }
  const val = JSON.stringify(merged);
  await db.execute(
    `INSERT INTO reward_rules (rule_key, rule_value, description) VALUES ('rewardRules', ?, '奖励金规则配置（模块1-4）；佣金见后台佣金规则配置')
     ON DUPLICATE KEY UPDATE rule_value = VALUES(rule_value), description = VALUES(description)`,
    [val]
  );
  return { success: true, message: '保存成功' };
}

function validateCommissionRepairShape(cr) {
  if (!cr || typeof cr !== 'object') return 'commissionRepair 格式无效';
  const sp = cr.self_pay;
  const ins = cr.insurance;
  if (!sp || typeof sp !== 'object' || typeof sp.default !== 'number' || Number.isNaN(sp.default)) {
    return 'commissionRepair.self_pay.default 须为数字';
  }
  if (!ins || typeof ins !== 'object' || typeof ins.default !== 'number' || Number.isNaN(ins.default)) {
    return 'commissionRepair.insurance.default 须为数字';
  }
  if (sp.default < 0 || sp.default > 100 || ins.default < 0 || ins.default > 100) {
    return '佣金比例须在 0～100 之间';
  }
  return null;
}

/** 佣金规则：更新 reward_rules.commissionRepair + settings.product_order_platform_fee_rate */
async function saveCommissionRulesConfig(db, req) {
  const body = req.body || {};
  const { commissionRepair, product_order_platform_fee_rate: rateRaw } = body;
  const errShape = validateCommissionRepairShape(commissionRepair);
  if (errShape) return { success: false, error: errShape, statusCode: 400 };

  const rate = parseFloat(rateRaw);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    return { success: false, error: 'product_order_platform_fee_rate 须为 0～1 的数字', statusCode: 400 };
  }

  const rewardRulesLoader = require('./reward-rules-loader');
  let existing;
  try {
    existing = await rewardRulesLoader.getRewardRulesConfig(db);
  } catch (e) {
    return {
      success: false,
      error: e.message || '请先在奖励金规则配置中完成基础配置（模块1 等）',
      statusCode: 400,
    };
  }

  const merged = { ...existing, commissionRepair };
  const val = JSON.stringify(merged);
  await db.execute(
    `INSERT INTO reward_rules (rule_key, rule_value, description) VALUES ('rewardRules', ?, '奖励金规则配置（模块1-4）；佣金见后台佣金规则配置')
     ON DUPLICATE KEY UPDATE rule_value = VALUES(rule_value), description = VALUES(description)`,
    [val]
  );

  await db.execute(
    'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
    ['product_order_platform_fee_rate', String(rate), String(rate)]
  );

  return { success: true, message: '保存成功' };
}

// ===================== 评价审核 review-audit（已取消） =====================
// 保留 review_audit_logs 等历史表结构，但已移除后台入口与接口。

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
    const { targetType, level, status } = req.query;
    const { pageSize, offset } = normalizePagination(req.query, 1, 20, 100);
    let where = 'WHERE 1=1';
    const params = [];
    if (targetType) { where += ' AND target_type = ?'; params.push(targetType); }
    if (level) { where += ' AND violation_level = ?'; params.push(parseInt(level)); }
    if (status !== undefined && status !== '') { where += ' AND status = ?'; params.push(parseInt(status)); }
    const [list] = await db.execute(
      `SELECT record_id as recordId, target_type as targetType, target_id as targetId, violation_level as level,
              violation_type as violationType, related_order_id as orderId, related_review_id as reviewId,
              description, penalty_applied as penaltyApplied, status, created_at as createTime
       FROM violation_records ${where} ORDER BY created_at DESC ${sqlLimitOffsetFragment(pageSize, offset)}`,
      [...params]
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
    if (targetType === 'user') {
      const lv = parseInt(level, 10);
      await db.execute(
        'UPDATE users SET level_demoted_by_violation = 1 WHERE user_id = ?',
        [targetId]
      );
      if ([3, 4].includes(lv)) {
        await db.execute('UPDATE users SET status = 0, level = 0 WHERE user_id = ?', [targetId]);
        try {
          await db.execute(
            'INSERT IGNORE INTO blacklist (blacklist_type, blacklist_value, reason) VALUES (?, ?, ?)',
            ['user_id', targetId, `违规${level}级处罚`]
          );
        } catch (_) {}
      }
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
    const { logType, startDate, endDate } = req.query;
    const { pageSize, offset } = normalizePagination(req.query, 1, 50, 200);
    let where = 'WHERE 1=1';
    const params = [];
    if (logType) { where += ' AND log_type = ?'; params.push(logType); }
    if (startDate) { where += ' AND created_at >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND created_at <= ?'; params.push(endDate + ' 23:59:59'); }
    const [list] = await db.execute(
      `SELECT id, log_type as logType, action, target_table as targetTable, target_id as targetId,
              operator_id as operatorId, ip, created_at as createTime
       FROM audit_logs ${where} ORDER BY created_at DESC ${sqlLimitOffsetFragment(pageSize, offset, 200)}`,
      [...params]
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

// ===================== 维修完成材料人工审核（manual_review） =====================
/** MySQL JSON / mysql2 可能返回 object、string 或 Buffer */
function parseDbJsonField(val, fallback = {}) {
  if (val == null || val === '') return { ...fallback };
  if (Buffer.isBuffer(val)) {
    try {
      return JSON.parse(val.toString('utf8'));
    } catch (_) {
      return { ...fallback };
    }
  }
  if (typeof val === 'string') {
    try {
      return JSON.parse(val || '{}');
    } catch (_) {
      return { ...fallback };
    }
  }
  if (typeof val === 'object') return val;
  return { ...fallback };
}

async function listMaterialAuditManualTasks(db) {
  const [list] = await db.execute(
    `SELECT t.task_id, t.order_id, t.shop_id, t.status, t.reject_reason, t.ai_details, t.completion_evidence, t.created_at,
            s.name AS shop_name, o.status AS order_status, o.quoted_amount, o.actual_amount
     FROM material_audit_tasks t
     LEFT JOIN shops s ON t.shop_id = s.shop_id
     LEFT JOIN orders o ON t.order_id = o.order_id
     WHERE t.status = 'manual_review'
     ORDER BY t.created_at ASC`
  );
  const normalized = (list || []).map((row) => {
    const ai_details = parseDbJsonField(row.ai_details, {});
    const completion_evidence = parseDbJsonField(row.completion_evidence, {});
    const expected_amount =
      row.actual_amount != null && row.actual_amount !== ''
        ? parseFloat(row.actual_amount)
        : row.quoted_amount != null && row.quoted_amount !== ''
          ? parseFloat(row.quoted_amount)
          : null;
    const extracted_amount_raw = ai_details?.settlementCheck?.extracted_amount ?? ai_details?.extracted_amount;
    const extracted_amount =
      extracted_amount_raw != null && extracted_amount_raw !== '' && Number.isFinite(Number(extracted_amount_raw))
        ? Number(extracted_amount_raw)
        : null;
    let diff_amount = null;
    let diff_ratio = null;
    if (expected_amount != null && expected_amount > 0 && extracted_amount != null) {
      diff_amount = Math.round((extracted_amount - expected_amount) * 100) / 100;
      diff_ratio = Math.round((Math.abs(diff_amount) / expected_amount) * 10000) / 100; // %
    }
    return {
      ...row,
      ai_details,
      completion_evidence,
      expected_amount,
      extracted_amount,
      diff_amount,
      diff_ratio,
    };
  });
  return { success: true, data: { list: normalized } };
}

async function resolveMaterialAuditTask(db, taskId, body) {
  const { approve, reject_reason: rejectReason } = body || {};
  const materialAudit = require('./material-audit-service');
  if (approve === true) {
    const r = await materialAudit.approveMaterialAuditManual(db, taskId);
    if (!r.ok) return { success: false, error: r.error, statusCode: 400 };
    return { success: true, message: '已通过' };
  }
  if (approve === false) {
    const r = await materialAudit.rejectMaterialAuditManual(db, taskId, rejectReason);
    if (!r.ok) return { success: false, error: r.error, statusCode: 400 };
    return { success: true, message: '已驳回' };
  }
  return { success: false, error: '请提供 approve: true（通过）或 false（驳回）', statusCode: 400 };
}

const { hasColumn: hasColumnAdmin } = require('../utils/db-utils');

async function listReviewEvidenceAnomalyTasks(db) {
  let list = [];
  try {
    const [r] = await db.execute(
      `SELECT t.task_id, t.order_id, t.review_id, t.user_id, t.shop_id, t.trigger_reason, t.ai_snapshot, t.review_snapshot,
              t.alignment_coeff, t.status, t.resolution, t.resolved_by, t.resolved_at, t.created_at,
              s.name AS shop_name
       FROM review_evidence_anomaly_tasks t
       LEFT JOIN shops s ON t.shop_id = s.shop_id
       WHERE t.status = 'pending'
       ORDER BY t.created_at ASC`
    );
    list = r || [];
  } catch (_) {
    list = [];
  }
  const normalized = (list || []).map((row) => ({
    ...row,
    ai_snapshot: parseDbJsonField(row.ai_snapshot, {}),
    review_snapshot: parseDbJsonField(row.review_snapshot, {}),
  }));
  return { success: true, data: { list: normalized } };
}

/**
 * 评价-过程证据极端冲突人工结案：回写 reviews.evidence_alignment_coeff / anomaly_status，并重算店铺分
 * @param {string} adminUserId JWT 中的运营账号标识
 */
async function resolveReviewEvidenceAnomalyTask(db, taskId, body = {}, adminUserId = 'admin') {
  const raw = body?.evidence_alignment_coeff;
  const c = raw === 0 || raw === '0' ? 0 : raw === 1 || raw === '1' ? 1 : null;
  if (c === null) {
    return { success: false, error: '请提供 evidence_alignment_coeff: 0 或 1', statusCode: 400 };
  }
  const resolution =
    (body.resolution && String(body.resolution).trim().slice(0, 64)) || (c === 1 ? 'admin_restore_1' : 'admin_exclude_0');
  const markInvalid = body.mark_review_invalid === true;

  let tasks = [];
  try {
    const [rows] = await db.execute(
      `SELECT * FROM review_evidence_anomaly_tasks WHERE task_id = ? AND status = 'pending' LIMIT 1`,
      [taskId]
    );
    tasks = rows || [];
  } catch (e) {
    return { success: false, error: '异常单表未就绪', statusCode: 503 };
  }
  if (!tasks.length) {
    return { success: false, error: '任务不存在或已结案', statusCode: 404 };
  }
  const t = tasks[0];

  await db.execute(
    `UPDATE review_evidence_anomaly_tasks SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = NOW(), alignment_coeff = ? WHERE task_id = ?`,
    [resolution, adminUserId || 'admin', c, taskId]
  );

  const hasCoeff = await hasColumnAdmin(db, 'reviews', 'evidence_alignment_coeff');
  const hasAnomaly = await hasColumnAdmin(db, 'reviews', 'anomaly_status');
  const hasCQ = await hasColumnAdmin(db, 'reviews', 'content_quality');

  const parts = [];
  const vals = [];
  if (hasCoeff) {
    parts.push('evidence_alignment_coeff = ?');
    vals.push(c);
  }
  if (hasAnomaly) {
    parts.push('anomaly_status = ?');
    vals.push(c === 1 ? 'dismissed' : 'resolved');
  }
  if (markInvalid && hasCQ) {
    parts.push("content_quality = 'invalid'");
    parts.push('content_quality_level = 1');
    parts.push('status = 0');
  }
  if (parts.length) {
    vals.push(t.review_id);
    await db.execute(`UPDATE reviews SET ${parts.join(', ')} WHERE review_id = ?`, vals);
  }

  const shopScore = require('../shop-score');
  await shopScore.recomputeAndUpdateShopScore(db, t.shop_id);
  return { success: true, message: '已结案' };
}

// ===================== 投诉 complaints（占位） =====================
async function getComplaints(db, req) {
  return { success: true, data: [] };
}

async function putComplaint(db, req) {
  return { success: true, message: '处理成功' };
}

// ===================== 取消交易处置（结案） =====================
async function closeCancelDisposal(db, req) {
  const { orderNo } = req.params;
  const { note, result } = req.body || {};
  const noteTrim = String(note || '').trim();
  const resultTrim = String(result || '').trim();

  const [orders] = await db.execute('SELECT order_id FROM orders WHERE order_id = ?', [orderNo]);
  if (orders.length === 0) {
    return { success: false, error: '订单不存在', statusCode: 404 };
  }

  // 没有事件表就无法留痕；这里明确报错，避免“看似结案但没记录”
  try {
    const [chk] = await db.execute(
      `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_lifecycle_events'`
    );
    if (!chk || chk.length === 0) {
      return { success: false, error: '当前数据库未启用订单生命周期事件表，无法结案留痕', statusCode: 400 };
    }
  } catch (_) {}

  const eventId = 'ole_' + crypto.randomBytes(12).toString('hex');
  const payload = {
    action: 'close_cancel_disposal',
    result: resultTrim || null,
    note: noteTrim || null,
  };

  await db.execute(
    `INSERT INTO order_lifecycle_events
      (event_id, order_id, event_type, actor_type, actor_id, payload)
     VALUES (?, ?, 'cancel_disposal_closed', 'admin', 'admin', ?)`,
    [eventId, orderNo, JSON.stringify(payload)]
  );

  return {
    success: true,
    data: { event_id: eventId, order_id: orderNo },
    message: '已结案',
  };
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
  getRewardRulesConfig,
  saveRewardRulesConfig,
  saveCommissionRulesConfig,
  getBlacklist,
  postBlacklist,
  deleteBlacklist,
  closeCancelDisposal,
  getAntifraudConfig,
  putAntifraudConfig,
  getViolations,
  postViolation,
  getAuditLogs,
  getAntifraudStatistics,
  getComplaints,
  putComplaint,
  listMaterialAuditManualTasks,
  resolveMaterialAuditTask,
  listReviewEvidenceAnomalyTasks,
  resolveReviewEvidenceAnomalyTask,
};
