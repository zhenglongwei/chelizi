/**
 * 单笔订单转化池：按 S_r 归一 + 单条封顶 Θ·P' + 本单内二次分配（计划 §3.2 / §4.1）
 * @param {number} poolPrime - 已乘买家 φ 后的池 P'
 * @param {{ key: string, S: number }[]} items - key=review_id，S≥0
 * @param {number} theta - (0,1]，单条名义份额上限 = theta * poolPrime
 * @returns {Record<string, number>} key -> 名义份额 alloc（Σ≈poolPrime，未乘作者 ψ）
 */
function allocateConversionPoolByTheta(poolPrime, items, theta) {
  const p = Math.round(Number(poolPrime) * 100) / 100;
  const th = Math.min(0.999, Math.max(0.01, Number(theta) || 0.65));
  const cap = Math.round(p * th * 100) / 100;
  const alloc = {};
  const keys = (items || []).map((i) => String(i.key || '').trim()).filter(Boolean);
  keys.forEach((k) => {
    alloc[k] = 0;
  });
  if (p <= 0 || keys.length === 0) return alloc;

  const S = {};
  for (const it of items || []) {
    const k = String(it.key || '').trim();
    if (!k) continue;
    S[k] = Math.max(0, Number(it.S) || 0);
  }

  const sumS = keys.reduce((a, k) => a + S[k], 0);
  if (sumS <= 0) {
    const each = Math.round((p / keys.length) * 100) / 100;
    let left = p;
    keys.forEach((k, idx) => {
      const v = idx === keys.length - 1 ? Math.round(left * 100) / 100 : each;
      alloc[k] = v;
      left -= v;
    });
    return alloc;
  }

  let rem = p;
  for (let iter = 0; iter < 80 && rem > 0.009; iter++) {
    const uncapped = keys.filter((k) => alloc[k] < cap - 1e-6);
    let active = uncapped.filter((k) => S[k] > 0);
    if (!active.length) {
      if (!uncapped.length) break;
      const eq = rem / uncapped.length;
      let progressed = false;
      for (const k of uncapped) {
        const room = cap - alloc[k];
        const d = Math.min(room, eq);
        if (d > 1e-9) {
          alloc[k] = Math.round((alloc[k] + d) * 100) / 100;
          rem = Math.round((rem - d) * 100) / 100;
          progressed = true;
        }
      }
      if (!progressed) break;
      continue;
    }
    const W = active.reduce((a, k) => a + S[k], 0);
    if (W <= 0) break;
    let progressed = false;
    for (const k of active) {
      const room = cap - alloc[k];
      const d = Math.min(room, rem * (S[k] / W));
      if (d > 1e-9) {
        alloc[k] = Math.round((alloc[k] + d) * 100) / 100;
        rem = Math.round((rem - d) * 100) / 100;
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  const drift = Math.round((p - keys.reduce((a, k) => a + alloc[k], 0)) * 100) / 100;
  if (Math.abs(drift) >= 0.01) {
    const u = keys.find((k) => alloc[k] < cap - 1e-6);
    if (u) alloc[u] = Math.round((alloc[u] + drift) * 100) / 100;
  }
  return alloc;
}

function pickTable(arr, level) {
  const L = Math.min(4, Math.max(0, parseInt(level, 10) || 0));
  if (!Array.isArray(arr) || arr.length < 5) return 1;
  const v = arr[L];
  return typeof v === 'number' && !Number.isNaN(v) ? v : 1;
}

module.exports = {
  allocateConversionPoolByTheta,
  pickTable,
};
