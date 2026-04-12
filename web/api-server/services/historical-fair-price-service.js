/**
 * 官网公开接口：同车型历史成交参考价（匿名聚合，样本门槛）
 * 查询参数：model — 车型关键词，至少 2 字
 */

const MIN_SAMPLES = 5;
const PERIOD_DAYS = 365;

async function lookup(pool, query) {
  const model = String(query.model || '').trim();
  if (model.length < 2) {
    return {
      ok: false,
      code: 'MODEL_TOO_SHORT',
      message: '请输入至少 2 个字的车型关键词',
      sampleCount: 0
    };
  }

  const like = `%${model}%`;
  const [rows] = await pool.query(
    `SELECT
       AVG(o.actual_amount) AS avg_amt,
       MIN(o.actual_amount) AS min_amt,
       MAX(o.actual_amount) AS max_amt,
       COUNT(*) AS cnt
     FROM orders o
     INNER JOIN biddings b ON o.bidding_id = b.bidding_id
     WHERE o.status = 3
       AND o.actual_amount IS NOT NULL
       AND o.actual_amount > 0
       AND o.completed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       AND (
         LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(b.vehicle_info, '$.model')), '')) LIKE LOWER(?)
         OR LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(b.vehicle_info, '$.brand')), '')) LIKE LOWER(?)
       )`,
    [PERIOD_DAYS, like, like]
  );

  const row = rows[0] || {};
  const cnt = Number(row.cnt) || 0;

  if (cnt < MIN_SAMPLES) {
    return {
      ok: false,
      code: 'INSUFFICIENT_SAMPLES',
      message: `当前样本量不足（${cnt} 单，至少 ${MIN_SAMPLES} 单才展示参考区间）。建议直接发起竞价获取多家报价。`,
      sampleCount: cnt,
      periodDays: PERIOD_DAYS
    };
  }

  return {
    ok: true,
    sampleCount: cnt,
    avgAmount: Math.round(Number(row.avg_amt) * 100) / 100,
    minAmount: Math.round(Number(row.min_amt) * 100) / 100,
    maxAmount: Math.round(Number(row.max_amt) * 100) / 100,
    periodDays: PERIOD_DAYS,
    disclaimer: '仅供参考，实际维修以到店检测与报价为准；非小程序核心功能。'
  };
}

module.exports = { lookup, MIN_SAMPLES, PERIOD_DAYS };
