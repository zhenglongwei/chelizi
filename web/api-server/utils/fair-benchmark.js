/**
 * 从定损/AI 分析结果提取公允参考价（元），与竞价报价合理性、自费佣金调节同源
 * @param {object|string|null} analysisResult - damage_reports.analysis_result
 * @returns {number}
 */
function extractFairBenchmarkYuan(analysisResult) {
  if (analysisResult == null) return 0;
  let ar = analysisResult;
  if (typeof ar === 'string') {
    try {
      ar = JSON.parse(ar || '{}');
    } catch (_) {
      return 0;
    }
  }
  const est = ar?.total_estimate;
  if (Array.isArray(est) && est.length >= 2) {
    const a = parseFloat(est[0]);
    const b = parseFloat(est[1]);
    if (!isNaN(a) && !isNaN(b)) return (a + b) / 2;
  }
  if (est != null) {
    const n = parseFloat(est);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

module.exports = { extractFairBenchmarkYuan };
