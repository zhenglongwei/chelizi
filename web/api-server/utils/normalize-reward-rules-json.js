'use strict';

const Z = { L1: 0, L2: 0, L3: 0, L4: 0 };

/**
 * 规范化 `reward_rules` 中 `rule_key = rewardRules` 的根级 JSON，与后台「保存全部」写入的中性值一致。
 * - complexityLevels：每项 `float_ratio`、`cap_amount` 置 0（保留等级/关键词/固定奖励）
 * - 车价：`vehicleTierLowCapUp`、`lowEndL4Amplify`、`floatCalibration` 置中性
 * - 订单：`orderTier*Cap` 置 0（`orderTier*Max` 阈值不动）
 * - 合规：破格升级相关计数置 0
 * - `platformIncentiveV1.disableOrderTierCap` 置 true
 *
 * @param {Record<string, unknown>} config
 * @returns {Record<string, unknown>}
 */
function normalizeRewardRulesRoot(config) {
  if (!config || typeof config !== 'object') return config;
  const out = { ...config };
  if (Array.isArray(out.complexityLevels)) {
    out.complexityLevels = out.complexityLevels.map((row) => {
      if (!row || typeof row !== 'object') return row;
      return {
        ...row,
        float_ratio: 0,
        cap_amount: 0,
      };
    });
  }
  out.vehicleTierLowCapUp = 0;
  out.lowEndL4Amplify = 1;
  out.floatCalibration = {
    low: { ...Z },
    medium: { ...Z },
    high: { ...Z },
  };
  out.orderTier1Cap = 0;
  out.orderTier2Cap = 0;
  out.orderTier3Cap = 0;
  out.orderTier4Cap = 0;
  out.upgradeMaxPer3Months = 0;
  out.upgradeReviewHours = 0;
  if (out.platformIncentiveV1 && typeof out.platformIncentiveV1 === 'object') {
    out.platformIncentiveV1 = { ...out.platformIncentiveV1, disableOrderTierCap: true };
  }
  return out;
}

module.exports = { normalizeRewardRulesRoot };
