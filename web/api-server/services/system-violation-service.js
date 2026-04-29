/**
 * 系统核验违规记录服务
 * 依据 docs/已归档/评价内容设置规范.md 二、系统自动核验模块（历史稿；现行见 docs/体系/05）
 * 违规类型：no_quote_confirm(10)、extra_project(20)、settlement_deviation(20)、service_mismatch(50)、parts_non_compliant(20)
 */

const shopScore = require('../shop-score');

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
 * 记录系统核验违规
 * @param {Object} pool - 数据库连接池
 * @param {string} shopId - 店铺 ID
 * @param {string} orderId - 订单 ID
 * @param {string} violationType - no_quote_confirm/extra_project/settlement_deviation/service_mismatch
 * @param {number} penalty - 10/20/50
 */
async function recordSystemViolation(pool, shopId, orderId, violationType, penalty) {
  const hasViolations = await hasTable(pool, 'shop_violations');
  if (!hasViolations) return;

  const [existing] = await pool.execute(
    'SELECT 1 FROM shop_violations WHERE shop_id = ? AND order_id = ? AND violation_type = ?',
    [shopId, orderId, violationType]
  );
  if (existing.length > 0) return;

  await pool.execute(
    'INSERT INTO shop_violations (shop_id, order_id, violation_type, penalty) VALUES (?, ?, ?, ?)',
    [shopId, orderId, violationType, penalty]
  );

  if (penalty === 50) {
    await applyMajorViolationConsequences(pool, shopId);
  } else {
    await updateComplianceRate(pool, shopId);
    await shopScore.recomputeAndUpdateShopScore(pool, shopId);
  }
}

/**
 * 重大违规后果：2 次及以上得分清零、店铺下架
 */
async function applyMajorViolationConsequences(pool, shopId) {
  try {
    const { score, majorViolationCount } = await shopScore.computeShopScore(pool, shopId);
    const rating5 = Math.min(5, Math.max(0, score / 20));
    if (majorViolationCount >= 2) {
      await pool.execute(
        'UPDATE shops SET shop_score = 0, rating = 0, status = 0, updated_at = NOW() WHERE shop_id = ?',
        [shopId]
      );
    } else {
      await pool.execute(
        'UPDATE shops SET shop_score = ?, rating = ?, updated_at = NOW() WHERE shop_id = ?',
        [score, rating5, shopId]
      );
    }
  } catch (err) {
    console.error('[system-violation] applyMajorViolationConsequences error:', err.message);
  }
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

async function updateComplianceRate(pool, shopId) {
  try {
    const { computeShopComplianceRate } = require('./merchant-evidence-service');
    const rate = await computeShopComplianceRate(pool, shopId);
    if (rate != null && (await hasColumn(pool, 'shops', 'compliance_rate'))) {
      await pool.execute('UPDATE shops SET compliance_rate = ? WHERE shop_id = ?', [rate, shopId]);
    }
  } catch (err) {
    console.error('[system-violation] updateComplianceRate error:', err.message);
  }
}

/**
 * 订单完成时核验并记录系统违规（结算偏差超 10%）
 * @param {Object} pool - 数据库连接池
 * @param {Object} order - { order_id, shop_id, quote_id, quoted_amount, actual_amount }
 */
async function checkAndRecordOrderViolations(pool, order) {
  if (!order || !order.shop_id || !order.order_id) return;

  const quotedNum = parseFloat(order.quoted_amount) || 0;
  const actualNum = parseFloat(order.actual_amount) || 0;

  if (!order.quote_id || order.quote_id === '') {
    await recordSystemViolation(pool, order.shop_id, order.order_id, 'no_quote_confirm', 10);
  }

  if (quotedNum > 0 && actualNum > 0) {
    const deviation = Math.abs(actualNum - quotedNum) / quotedNum;
    if (deviation > 0.1) {
      await recordSystemViolation(pool, order.shop_id, order.order_id, 'settlement_deviation', 20);
    }
  }
}

/**
 * 人工确认配件不合规（05 文档，备案制）
 * 投诉/追评人工复核时，确认配件不合规后调用
 * @param {Object} pool - 数据库连接池
 * @param {string} shopId - 店铺 ID
 * @param {string} orderId - 订单 ID
 */
async function recordPartsNonCompliant(pool, shopId, orderId) {
  return recordSystemViolation(pool, shopId, orderId, 'parts_non_compliant', 20);
}

module.exports = {
  recordSystemViolation,
  checkAndRecordOrderViolations,
  recordPartsNonCompliant,
};
