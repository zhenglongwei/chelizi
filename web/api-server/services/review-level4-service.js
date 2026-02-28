/**
 * 4级爆款自动升级服务
 * 条件：3级 + 同车型同项目≤10条 + 7天内同车型浏览≥1000 + 点赞≥50
 * 满足后自动升级，无需人工复核
 */

/** 同车型同项目条数上限 */
const SAME_MODEL_PROJECT_MAX = 10;
/** 7天内同车型浏览下限 */
const SAME_MODEL_VIEWS_MIN = 1000;
/** 点赞数下限 */
const LIKE_COUNT_MIN = 50;

/**
 * 检查评价是否满足4级条件，满足则自动升级
 * @param {object} pool - 数据库连接池
 * @param {string} reviewId - 评价ID
 * @returns {Promise<{ upgraded: boolean, reason?: string }>}
 */
async function checkAndUpgradeToLevel4(pool, reviewId) {
  const [rows] = await pool.execute(
    `SELECT review_id, content_quality_level, vehicle_model_key, repair_project_key, like_count
     FROM reviews WHERE review_id = ? AND type = 1 AND status = 1`,
    [reviewId]
  );
  if (rows.length === 0) return { upgraded: false, reason: '评价不存在或非主评价' };

  const r = rows[0];
  const level = parseInt(r.content_quality_level, 10) || 0;
  if (level !== 3) return { upgraded: false, reason: '非3级标杆评价' };
  if (level === 4) return { upgraded: false, reason: '已是4级' };

  const vehicleKey = r.vehicle_model_key;
  const projectKey = r.repair_project_key;
  const likeCount = parseInt(r.like_count, 10) || 0;

  if (!vehicleKey || !projectKey) {
    return { upgraded: false, reason: '缺少车型或项目键' };
  }
  if (likeCount < LIKE_COUNT_MIN) {
    return { upgraded: false, reason: `点赞不足${LIKE_COUNT_MIN}` };
  }

  // 同车型同项目≤10条
  const [countRows] = await pool.execute(
    `SELECT COUNT(*) as cnt FROM reviews
     WHERE type = 1 AND status = 1
       AND vehicle_model_key = ? AND repair_project_key = ?`,
    [vehicleKey, projectKey]
  );
  const sameCount = parseInt(countRows[0]?.cnt || 0, 10);
  if (sameCount > SAME_MODEL_PROJECT_MAX) {
    return { upgraded: false, reason: `同车型同项目${sameCount}条 > ${SAME_MODEL_PROJECT_MAX}` };
  }

  // 7天内同车型浏览≥1000（浏览该评价的会话中，读者车型与评价车型一致）
  const [viewRows] = await pool.execute(
    `SELECT COUNT(*) as cnt
     FROM review_reading_sessions ss
     JOIN user_vehicles uv ON ss.user_id = uv.user_id
     WHERE ss.review_id = ?
       AND ss.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       AND CONCAT(
         COALESCE(TRIM(JSON_UNQUOTE(JSON_EXTRACT(uv.vehicle_info, '$.brand'))), ''),
         '|',
         COALESCE(TRIM(JSON_UNQUOTE(JSON_EXTRACT(uv.vehicle_info, '$.model'))), '')
       ) = ?`,
    [reviewId, vehicleKey]
  );
  const sameModelViews = parseInt(viewRows[0]?.cnt || 0, 10);
  if (sameModelViews < SAME_MODEL_VIEWS_MIN) {
    return { upgraded: false, reason: `7天内同车型浏览${sameModelViews} < ${SAME_MODEL_VIEWS_MIN}` };
  }

  // 满足条件，自动升级
  await pool.execute(
    `UPDATE reviews SET content_quality_level = 4, content_quality = '爆款', updated_at = NOW()
     WHERE review_id = ?`,
    [reviewId]
  );

  return { upgraded: true };
}

module.exports = {
  checkAndUpgradeToLevel4,
  SAME_MODEL_PROJECT_MAX,
  SAME_MODEL_VIEWS_MIN,
  LIKE_COUNT_MIN,
};
