/**
 * 过程 AI（orders.repair_process_ai）与评价 objective_answers 对齐：轻量曝光系数、极端冲突异常单（待人工）
 */

const crypto = require('crypto');
const { hasColumn } = require('../utils/db-utils');

async function hasTable(pool, tableName) {
  try {
    const [rows] = await pool.execute(
      `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [tableName]
    );
    return rows.length > 0;
  } catch (_) {
    return false;
  }
}

function parseJsonField(val, fallback = {}) {
  if (val == null) return { ...fallback };
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

/** 免责类 risk_flags：命中则不自动建极端异常单 */
function hasDisclaimerRisk(risks) {
  const s = new Set(['few_photos', 'no_milestones', 'ai_uncertain', 'cannot_judge', 'insufficient_images', 'unclear']);
  return risks.some((x) => s.has(String(x)));
}

/**
 * 订单侧过程 AI 更新后，重算该单关联主评的吻合系数占位、曝光乘子，并检测是否建异常单
 */
async function recalculateReviewsForOrder(pool, orderId) {
  const hasCoeff = await hasColumn(pool, 'reviews', 'evidence_alignment_coeff');
  const hasBoost = await hasColumn(pool, 'reviews', 'review_discovery_boost');
  const hasAnomalyCol = await hasColumn(pool, 'reviews', 'anomaly_status');
  const hasTaskTable = await hasTable(pool, 'review_evidence_anomaly_tasks');
  if (!hasCoeff && !hasBoost && !hasAnomalyCol) return;

  const [ords] = await pool.execute('SELECT repair_process_ai FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
  const paiRaw = ords[0]?.repair_process_ai;
  const pai = parseJsonField(paiRaw, null);
  if (!pai || typeof pai !== 'object') return;

  const [revs] = await pool.execute(
    `SELECT review_id, shop_id, user_id, objective_answers, anomaly_status, evidence_alignment_coeff
     FROM reviews WHERE order_id = ? AND type = 1`,
    [orderId]
  );
  if (!revs.length) return;

  for (const rev of revs) {
    const oa = parseJsonField(rev.objective_answers, {});
    const frozen = rev.anomaly_status === 'resolved' || rev.anomaly_status === 'dismissed';

    let coeff = 1;
    if (frozen && hasCoeff) {
      const ex = parseFloat(rev.evidence_alignment_coeff);
      coeff = Number.isNaN(ex) ? 1 : Math.max(0, Math.min(1, ex));
    }

    let boost = 1;
    let anomalySt = null;

    const proc = parseInt(oa.process_transparency_star, 10);
    const qt = parseInt(oa.quote_transparency_star, 10);
    const pt = parseInt(oa.parts_traceability_star, 10);
    const rt = parseInt(oa.repair_effect_star, 10);
    const score = typeof pai.summary_score === 'number' ? pai.summary_score : null;
    const risks = Array.isArray(pai.risk_flags) ? pai.risk_flags : [];
    const disclaimed = hasDisclaimerRisk(risks);

    if (score != null && hasBoost && !Number.isNaN(proc) && proc >= 1 && proc <= 5) {
      const alignHint = (score / 100) * (proc / 5);
      boost = Math.min(1.04, Math.max(0.96, 1 + (alignHint - 0.5) * 0.08));
    }

    if (!frozen && hasTaskTable && score != null && !disclaimed) {
      const extNeg =
        score >= 78 &&
        !Number.isNaN(proc) &&
        proc <= 2 &&
        !Number.isNaN(rt) &&
        rt <= 2 &&
        !Number.isNaN(qt) &&
        qt <= 2 &&
        !Number.isNaN(pt) &&
        pt <= 2;
      const extPos =
        score <= 42 &&
        !Number.isNaN(proc) &&
        proc >= 5 &&
        !Number.isNaN(rt) &&
        rt >= 4 &&
        !Number.isNaN(qt) &&
        qt >= 4 &&
        !Number.isNaN(pt) &&
        pt >= 4;

      if (extNeg || extPos) {
        const [pend] = await pool.execute(
          `SELECT task_id FROM review_evidence_anomaly_tasks WHERE review_id = ? AND status = 'pending'`,
          [rev.review_id]
        );
        if (pend.length === 0) {
          const tid = 'rea_' + crypto.randomBytes(12).toString('hex');
          const reason = extNeg ? 'auto_extreme_negative' : 'auto_extreme_positive';
          await pool.execute(
            `INSERT INTO review_evidence_anomaly_tasks
             (task_id, order_id, review_id, user_id, shop_id, trigger_reason, ai_snapshot, review_snapshot, alignment_coeff, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [
              tid,
              orderId,
              rev.review_id,
              rev.user_id,
              rev.shop_id,
              reason,
              JSON.stringify(pai),
              JSON.stringify({ objective_answers: oa }),
              1,
            ]
          );
          if (hasAnomalyCol) anomalySt = 'pending';
          if (hasCoeff) coeff = 0;
        } else if (hasCoeff) {
          coeff = 0;
          if (hasAnomalyCol) anomalySt = 'pending';
        }
      } else {
        const [pend2] = await pool.execute(
          `SELECT task_id FROM review_evidence_anomaly_tasks WHERE review_id = ? AND status = 'pending'`,
          [rev.review_id]
        );
        if (pend2.length > 0 && hasCoeff) {
          coeff = 0;
          if (hasAnomalyCol) anomalySt = 'pending';
        }
      }
    } else if (!frozen && hasCoeff && hasTaskTable) {
      const [pend3] = await pool.execute(
        `SELECT task_id FROM review_evidence_anomaly_tasks WHERE review_id = ? AND status = 'pending'`,
        [rev.review_id]
      );
      if (pend3.length > 0) coeff = 0;
    }

    const sets = [];
    const vals = [];
    if (hasCoeff && !frozen) {
      sets.push('evidence_alignment_coeff = ?');
      vals.push(coeff);
    }
    if (hasBoost) {
      sets.push('review_discovery_boost = ?');
      vals.push(boost);
    }
    if (hasAnomalyCol && anomalySt) {
      sets.push('anomaly_status = ?');
      vals.push(anomalySt);
    }
    if (sets.length) {
      vals.push(rev.review_id);
      await pool.execute(`UPDATE reviews SET ${sets.join(', ')} WHERE review_id = ?`, vals);
    }
  }

  const shopScore = require('../shop-score');
  await shopScore.recomputeAndUpdateShopScore(pool, revs[0].shop_id);
}

async function onMainReviewInserted(pool, orderId) {
  try {
    await recalculateReviewsForOrder(pool, orderId);
  } catch (e) {
    console.warn('[review-evidence-alignment] onMainReviewInserted:', e && e.message);
  }
}

module.exports = {
  recalculateReviewsForOrder,
  onMainReviewInserted,
};
