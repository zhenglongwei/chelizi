/**
 * 主评价 INSERT reviews：按列数组组装，避免手写 cols/vals 列数与占位符不一致
 * @param {'invalid'|'pending_human'|'valid'} mode
 */

async function loadReviewInsertFlags(pool, hasColumn) {
  return {
    fault_evidence_images: await hasColumn(pool, 'reviews', 'fault_evidence_images'),
    review_images_public: await hasColumn(pool, 'reviews', 'review_images_public'),
    review_public_media: await hasColumn(pool, 'reviews', 'review_public_media'),
    review_system_checks: await hasColumn(pool, 'reviews', 'review_system_checks'),
    weight: await hasColumn(pool, 'reviews', 'weight'),
    content_quality: await hasColumn(pool, 'reviews', 'content_quality'),
  };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {Function} hasColumn - (pool, table, col) => Promise<boolean>
 * @param {'invalid'|'pending_human'|'valid'} mode
 * @param {object} row - 各字段已序列化/就绪
 */
async function insertMainReviewRow(pool, hasColumn, mode, row) {
  const f = await loadReviewInsertFlags(pool, hasColumn);
  /** @type {{ col: string, kind: 'p'|'r', val?: unknown, raw?: string }[]} */
  const parts = [];
  const p = (col, val) => parts.push({ col, kind: 'p', val });
  const r = (col, rawSql) => parts.push({ col, kind: 'r', raw: rawSql });

  p('review_id', row.reviewId);
  p('order_id', row.orderId);
  p('shop_id', row.shopId);
  p('user_id', row.userId);
  r('type', '1');
  r('review_stage', `'main'`);
  p('rating', row.rating);
  p('ratings_quality', row.ratingsQuality);
  p('ratings_price', row.ratingsPrice);
  p('ratings_service', row.ratingsService);
  p('ratings_speed', row.ratingsSpeed);
  p('ratings_parts', row.ratingsParts);
  p('settlement_list_image', row.settlementListImage);
  p('completion_images', row.completionImagesJson);

  if (f.fault_evidence_images) {
    p('fault_evidence_images', row.faultEvidenceJson);
  }

  p('objective_answers', row.objectiveAnswersJson);
  p('content', row.content);
  p('before_images', row.beforeImagesJson);
  p('after_images', row.afterImagesJson);
  p('is_anonymous', row.isAnonymous);

  if (f.review_images_public) {
    p('review_images_public', row.reviewImagesPublic);
  }
  if (f.review_public_media) {
    p('review_public_media', row.reviewPublicMediaJson);
  }
  if (f.review_system_checks) {
    p('review_system_checks', row.reviewSystemChecksJson);
  }

  p('rebate_amount', row.rebateAmount);
  p('reward_amount', row.rewardAmount);
  p('tax_deducted', row.taxDeducted);
  r('rebate_rate', '0');
  r('status', mode === 'valid' ? '1' : '0');

  if (f.weight) {
    r('weight', 'NULL');
  }

  if (f.content_quality) {
    if (mode === 'invalid') {
      r('content_quality', `'invalid'`);
    } else if (mode === 'pending_human') {
      r('content_quality', `'pending_human'`);
    } else {
      p('content_quality', row.contentQuality);
    }
  }

  p('content_quality_level', row.contentQualityLevel);
  p('vehicle_model_key', row.vehicleModelKey);
  p('repair_project_key', row.repairProjectKey);
  p('ai_analysis', row.aiAnalysisJson);
  r('created_at', 'NOW()');

  const cols = parts.map((x) => x.col).join(', ');
  const vals = parts.map((x) => (x.kind === 'p' ? '?' : x.raw)).join(', ');
  const bind = parts.filter((x) => x.kind === 'p').map((x) => x.val);

  await pool.execute(`INSERT INTO reviews (${cols}) VALUES (${vals})`, bind);
}

module.exports = {
  insertMainReviewRow,
  loadReviewInsertFlags,
};
