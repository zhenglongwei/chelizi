/**
 * 商户申诉服务
 * 评价提交后创建申诉任务；定时任务处理逾期未申诉 → 写入 shop_violations
 * 申诉提交后 AI 初审 → status=2 有效 / status=3 无效
 */

const LOG_PREFIX = '[merchant-evidence]';
const materialAudit = require('./material-audit-service');

const QUESTION_PENALTIES = {
  q1_progress_synced: 5,
  q2_parts_shown: 15,
  q3_fault_resolved: 0
};

/**
 * 计算店铺季度合规率：合规订单数 / 总完成订单数 × 100
 * @param {Object} pool - 数据库连接池
 * @param {string} shopId - 店铺 ID
 * @returns {Promise<number|null>} 合规率 0-100 或 null
 */
async function computeShopComplianceRate(pool, shopId) {
  try {
    const quarterStart = getQuarterStart();
    const [completed] = await pool.execute(
      `SELECT COUNT(*) as cnt FROM orders WHERE shop_id = ? AND status = 3 AND completed_at >= ?`,
      [shopId, quarterStart]
    );
    const total = parseInt(completed[0]?.cnt || 0, 10);
    if (total === 0) return null;

    const [violated] = await pool.execute(
      `SELECT COUNT(DISTINCT sv.order_id) as cnt
       FROM shop_violations sv
       INNER JOIN orders o ON sv.order_id = o.order_id AND o.shop_id = ? AND o.status = 3 AND o.completed_at >= ?`,
      [shopId, quarterStart]
    );
    const violationCount = parseInt(violated[0]?.cnt || 0, 10);
    const compliant = total - violationCount;
    return Math.round((compliant / total) * 10000) / 100;
  } catch (err) {
    console.error(`${LOG_PREFIX} computeShopComplianceRate error:`, err.message);
    return null;
  }
}

function getQuarterStart() {
  const d = new Date();
  const q = Math.floor(d.getMonth() / 3) + 1;
  const year = d.getFullYear();
  const month = (q - 1) * 3;
  return new Date(year, month, 1);
}

/**
 * 处理逾期未申诉的请求：更新 status=3，写入 shop_violations，更新店铺合规率
 * @param {Object} pool - 数据库连接池
 * @returns {Promise<{ processed: number }>}
 */
async function processOverdueEvidenceRequests(pool) {
  let processed = 0;
  const affectedShopIds = new Set();
  try {
    const [rows] = await pool.execute(
      `SELECT request_id, order_id, shop_id, question_key
       FROM merchant_evidence_requests
       WHERE status = 0 AND deadline < NOW()`
    );
    const hasViolations = await hasTable(pool, 'shop_violations');
    const hasComplianceRate = await hasColumn(pool, 'shops', 'compliance_rate');

    for (const r of rows || []) {
      await pool.execute(
        'UPDATE merchant_evidence_requests SET status = 3, updated_at = NOW() WHERE request_id = ?',
        [r.request_id]
      );
      if (r.question_key !== 'q3_fault_resolved' && hasViolations) {
        const penalty = QUESTION_PENALTIES[r.question_key] || 5;
        const violationType = r.question_key === 'q1_progress_synced' ? 'progress_not_synced' : 'parts_not_shown';
        await pool.execute(
          `INSERT INTO shop_violations (shop_id, order_id, violation_type, penalty) VALUES (?, ?, ?, ?)`,
          [r.shop_id, r.order_id, violationType, penalty]
        );
        affectedShopIds.add(r.shop_id);
      }
      processed++;
    }

    for (const shopId of affectedShopIds) {
      if (hasComplianceRate) {
        const rate = await computeShopComplianceRate(pool, shopId);
        if (rate != null) {
          await pool.execute('UPDATE shops SET compliance_rate = ? WHERE shop_id = ?', [rate, shopId]);
        }
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} processOverdueEvidenceRequests error:`, err.message);
  }
  return { processed };
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

const QUESTION_LABELS = {
  q1_progress_synced: '维修进度是否与您同步',
  q2_parts_shown: '是否展示新旧配件',
  q3_fault_resolved: '车辆问题是否已完全解决'
};

/**
 * 获取店铺待申诉列表
 * @param {Object} pool - 数据库连接池
 * @param {string} shopId - 店铺 ID
 * @param {Object} opts - { status, limit }
 */
async function listAppealRequests(pool, shopId, opts = {}) {
  const status = opts.status;
  const limit = Math.min(50, Math.max(1, opts.limit || 20));
  let where = 'WHERE mer.shop_id = ?';
  const params = [shopId];
  if (status !== undefined && status !== '' && status !== null) {
    where += ' AND mer.status = ?';
    params.push(parseInt(status, 10));
  }
  params.push(limit);

  const [rows] = await pool.execute(
    `SELECT mer.request_id, mer.order_id, mer.review_id, mer.question_key, mer.status,
            mer.deadline, mer.evidence_urls, mer.created_at,
            r.content as review_content, r.rating
     FROM merchant_evidence_requests mer
     LEFT JOIN reviews r ON mer.review_id = r.review_id
     ${where}
     ORDER BY mer.created_at DESC
     LIMIT ?`,
    params
  );

  return (rows || []).map((r) => ({
    request_id: r.request_id,
    order_id: r.order_id,
    review_id: r.review_id,
    question_key: r.question_key,
    question_label: QUESTION_LABELS[r.question_key] || r.question_key,
    status: parseInt(r.status, 10),
    status_text: ['待申诉', '已申诉待审核', '申诉有效', '申诉无效/超时', '待人工复核'][parseInt(r.status, 10)] || '未知',
    deadline: r.deadline,
    evidence_urls: (() => {
      try {
        return typeof r.evidence_urls === 'string' ? JSON.parse(r.evidence_urls || '[]') : (r.evidence_urls || []);
      } catch (_) {
        return [];
      }
    })(),
    created_at: r.created_at,
    review_content: r.review_content ? String(r.review_content).slice(0, 100) : null,
    rating: r.rating
  }));
}

/**
 * 提交申诉材料
 * @param {Object} pool - 数据库连接池
 * @param {string} requestId - 申诉请求 ID
 * @param {string} shopId - 店铺 ID
 * @param {string[]} evidenceUrls - 申诉材料 URL 数组
 */
async function submitAppealRequest(pool, requestId, shopId, evidenceUrls) {
  const urls = Array.isArray(evidenceUrls) ? evidenceUrls.filter((u) => u && String(u).trim()) : [];
  if (urls.length < 1) {
    return { success: false, error: '请上传至少 1 张申诉材料', statusCode: 400 };
  }

  const [rows] = await pool.execute(
    `SELECT request_id, status, deadline FROM merchant_evidence_requests WHERE request_id = ? AND shop_id = ?`,
    [requestId, shopId]
  );
  if (rows.length === 0) {
    return { success: false, error: '申诉请求不存在', statusCode: 404 };
  }
  const r = rows[0];
  if (parseInt(r.status, 10) !== 0) {
    return { success: false, error: '该申诉已处理，无法重复提交', statusCode: 400 };
  }
  const deadline = r.deadline ? new Date(r.deadline) : null;
  if (deadline && Date.now() > deadline.getTime()) {
    return { success: false, error: '已超过申诉截止时间', statusCode: 400 };
  }

  const urlsJson = JSON.stringify(urls.slice(0, 10));
  await pool.execute(
    `UPDATE merchant_evidence_requests SET evidence_urls = ?, status = 1, updated_at = NOW() WHERE request_id = ?`,
    [urlsJson, requestId]
  );
  return { success: true, data: { request_id: requestId, status: 1 } };
}

/**
 * 处理申诉 AI 初审（同步）：status=1 → AI 审核 → status=2 或 3
 * @param {Object} pool - 数据库连接池
 * @param {string} requestId - 申诉请求 ID
 * @param {string} baseUrl - 图片 URL 基准
 */
async function processAppealReview(pool, requestId, baseUrl) {
  const apiKey = process.env.ALIYUN_AI_KEY || process.env.DASHSCOPE_API_KEY || '';
  if (!apiKey) {
    console.warn(`${LOG_PREFIX} 未配置千问 API Key，跳过申诉初审 ${requestId}`);
    return;
  }

  const [rows] = await pool.execute(
    `SELECT request_id, order_id, shop_id, review_id, question_key, evidence_urls, status
     FROM merchant_evidence_requests WHERE request_id = ? AND status = 1`,
    [requestId]
  );
  if (rows.length === 0) return;

  const r = rows[0];
  let urls = [];
  try {
    urls = typeof r.evidence_urls === 'string' ? JSON.parse(r.evidence_urls || '[]') : (r.evidence_urls || []);
  } catch (_) {}
  if (urls.length === 0) {
    await pool.execute(
      `UPDATE merchant_evidence_requests SET status = 3, ai_result = '无材料', updated_at = NOW() WHERE request_id = ?`,
      [requestId]
    );
    await recordAppealFailure(pool, r);
    return;
  }

  const { analyzeAppealEvidenceWithQwen } = require('../qwen-analyzer');
  const questionLabels = { q1_progress_synced: '维修进度是否与您同步', q2_parts_shown: '是否展示新旧配件' };

  let result;
  try {
    result = await analyzeAppealEvidenceWithQwen({
      questionKey: r.question_key,
      questionLabel: questionLabels[r.question_key] || r.question_key,
      evidenceUrls: urls,
      baseUrl: baseUrl || process.env.BASE_URL || 'http://localhost:3000',
      apiKey
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} 申诉 AI 初审异常 request=${requestId}:`, err.message);
    return;
  }

  if (result.needHumanReview) {
    await pool.execute(
      `UPDATE merchant_evidence_requests SET status = 4, ai_result = 'need_human', updated_at = NOW() WHERE request_id = ?`,
      [requestId]
    );
    await materialAudit.sendMerchantMessage(
      pool, r.shop_id, 'appeal_result',
      '申诉待人工复核',
      '您的申诉材料已提交，因涉及复杂情况需人工复核，预计 3 个工作日内处理。',
      r.order_id
    );
    return;
  }

  if (result.pass) {
    await pool.execute(
      `UPDATE merchant_evidence_requests SET status = 2, ai_result = 'pass', updated_at = NOW() WHERE request_id = ?`,
      [requestId]
    );
    if (r.question_key === 'q3_fault_resolved') {
      const hasCol = await hasColumn(pool, 'reviews', 'q3_weight_excluded');
      if (hasCol) {
        await pool.execute(
          `UPDATE reviews SET q3_weight_excluded = 1 WHERE review_id = ?`,
          [r.review_id]
        );
        try {
          const shopScore = require('../shop-score');
          await shopScore.updateShopScoreAfterReview(pool, r.shop_id, r.review_id);
        } catch (e) {
          console.warn(`${LOG_PREFIX} q3 申诉有效后更新店铺得分失败:`, e?.message);
        }
      }
    }
  } else {
    await pool.execute(
      `UPDATE merchant_evidence_requests SET status = 3, ai_result = ?, updated_at = NOW() WHERE request_id = ?`,
      [result.rejectReason || '申诉无效', requestId]
    );
    if (r.question_key !== 'q3_fault_resolved') {
      await recordAppealFailure(pool, r);
      await materialAudit.sendMerchantMessage(
        pool, r.shop_id, 'appeal_result',
        '申诉未通过',
        (result.rejectReason || '申诉材料未通过审核') + '，该笔订单将计入违规。',
        r.order_id
      );
    }
  }
}

async function recordAppealFailure(pool, r) {
  const hasViolations = await hasTable(pool, 'shop_violations');
  const hasComplianceRate = await hasColumn(pool, 'shops', 'compliance_rate');
  if (!hasViolations) return;
  const penalty = QUESTION_PENALTIES[r.question_key] || 5;
  const violationType = r.question_key === 'q1_progress_synced' ? 'progress_not_synced' : 'parts_not_shown';
  await pool.execute(
    `INSERT INTO shop_violations (shop_id, order_id, violation_type, penalty) VALUES (?, ?, ?, ?)`,
    [r.shop_id, r.order_id, violationType, penalty]
  );
  if (hasComplianceRate) {
    const rate = await computeShopComplianceRate(pool, r.shop_id);
    if (rate != null) {
      await pool.execute('UPDATE shops SET compliance_rate = ? WHERE shop_id = ?', [rate, r.shop_id]);
    }
  }
}

/**
 * 异步执行申诉 AI 初审
 */
function runAppealReviewAsync(pool, requestId, baseUrl) {
  setImmediate(() => {
    processAppealReview(pool, requestId, baseUrl).catch((err) => {
      console.error(`${LOG_PREFIX} runAppealReviewAsync error:`, err);
    });
  });
}

/**
 * 定时任务：处理所有 status=1 的申诉（补漏，如服务重启导致异步未执行）
 */
async function processPendingAppealReviews(pool, baseUrl) {
  const [rows] = await pool.execute(
    `SELECT request_id FROM merchant_evidence_requests WHERE status = 1 LIMIT 20`
  );
  for (const r of rows || []) {
    await processAppealReview(pool, r.request_id, baseUrl);
  }
  return { processed: (rows || []).length };
}

/**
 * 管理端：待人工复核申诉列表（status=4）
 */
async function listAppealReviewsForAdmin(pool, opts = {}) {
  const limit = Math.min(50, Math.max(1, opts.limit || 20));
  const offset = ((opts.page || 1) - 1) * limit;
  const [rows] = await pool.execute(
    `SELECT mer.request_id, mer.order_id, mer.review_id, mer.shop_id, mer.question_key, mer.status,
            mer.deadline, mer.evidence_urls, mer.ai_result, mer.created_at,
            r.content as review_content, r.rating, r.fault_evidence_images,
            s.name as shop_name
     FROM merchant_evidence_requests mer
     LEFT JOIN reviews r ON mer.review_id = r.review_id
     LEFT JOIN shops s ON mer.shop_id = s.shop_id
     WHERE mer.status = 4
     ORDER BY mer.created_at ASC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  const [countRes] = await pool.execute(
    'SELECT COUNT(*) as total FROM merchant_evidence_requests WHERE status = 4'
  );
  return {
    list: (rows || []).map((r) => ({
      request_id: r.request_id,
      order_id: r.order_id,
      review_id: r.review_id,
      shop_id: r.shop_id,
      shop_name: r.shop_name,
      question_key: r.question_key,
      question_label: QUESTION_LABELS[r.question_key] || r.question_key,
      evidence_urls: (() => {
        try {
          return typeof r.evidence_urls === 'string' ? JSON.parse(r.evidence_urls || '[]') : (r.evidence_urls || []);
        } catch (_) {
          return [];
        }
      })(),
      created_at: r.created_at,
      review_content: r.review_content ? String(r.review_content).slice(0, 200) : null,
      rating: r.rating,
      fault_evidence_images: r.fault_evidence_images
    })),
    total: parseInt(countRes[0]?.total || 0, 10)
  };
}

/**
 * 管理端：人工复核申诉（通过/驳回）
 */
async function resolveAppealReview(pool, requestId, approved, operatorId) {
  const [rows] = await pool.execute(
    `SELECT request_id, order_id, review_id, shop_id, question_key FROM merchant_evidence_requests WHERE request_id = ? AND status = 4`,
    [requestId]
  );
  if (rows.length === 0) {
    return { success: false, error: '申诉不存在或已处理', statusCode: 404 };
  }
  const r = rows[0];
  if (approved) {
    await pool.execute(
      `UPDATE merchant_evidence_requests SET status = 2, ai_result = 'pass_manual', updated_at = NOW() WHERE request_id = ?`,
      [requestId]
    );
    if (r.question_key === 'q3_fault_resolved') {
      const hasCol = await hasColumn(pool, 'reviews', 'q3_weight_excluded');
      if (hasCol) {
        await pool.execute(
          `UPDATE reviews SET q3_weight_excluded = 1 WHERE review_id = ?`,
          [r.review_id]
        );
        try {
          const shopScore = require('../shop-score');
          await shopScore.updateShopScoreAfterReview(pool, r.shop_id, r.review_id);
        } catch (e) {
          console.warn(`${LOG_PREFIX} 人工复核通过后更新店铺得分失败:`, e?.message);
        }
      }
    }
    await materialAudit.sendMerchantMessage(
      pool, r.shop_id, 'appeal_result',
      '申诉已通过',
      '您提交的申诉经人工复核已通过。',
      r.order_id
    );
  } else {
    await pool.execute(
      `UPDATE merchant_evidence_requests SET status = 3, ai_result = 'reject_manual', updated_at = NOW() WHERE request_id = ?`,
      [requestId]
    );
    if (r.question_key !== 'q3_fault_resolved') {
      await recordAppealFailure(pool, r);
      await materialAudit.sendMerchantMessage(
        pool, r.shop_id, 'appeal_result',
        '申诉未通过',
        '您提交的申诉经人工复核未通过，该笔订单将计入违规。',
        r.order_id
      );
    }
  }
  return { success: true, message: approved ? '已通过' : '已驳回' };
}

module.exports = {
  processOverdueEvidenceRequests,
  processPendingAppealReviews,
  listAppealRequests,
  submitAppealRequest,
  runAppealReviewAsync,
  listAppealReviewsForAdmin,
  resolveAppealReview
};
