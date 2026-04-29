/**
 * 轻量编排层（v1）
 * - 目标：把“场景”从页面里抽出来，复用能力模块
 * - 约束：先不引入复杂DAG与持久化编排定义，避免过早工程化
 */

async function runDamageAnalyzeToShareToken({ pool, damageService, reportId, userId, expiresInSec }) {
  // 场景：已有 report_id（用户已完成分析/异步分析），生成分享 token
  const r = await damageService.createShareTokenForOwner(pool, reportId, userId, expiresInSec);
  if (!r.success) return r;
  return { success: true, data: { report_id: reportId, share_token: r.data.token, expires_in_sec: r.data.expires_in_sec } };
}

module.exports = {
  runDamageAnalyzeToShareToken,
};

