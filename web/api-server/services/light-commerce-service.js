'use strict';

/**
 * GEO F10 轻量变现：环境变量配置（无线上存量时可直接改 .env）
 *
 * - ZHEJIAN_LIGHT_COMMERCE_MODE：commission_on_actual | lead_fee_only | both（默认 commission_on_actual）
 * - ZHEJIAN_LEAD_FEE_YUAN：单条预约线索平台费（元），在 lead_fee_only / both 且线索标记 done 时写入 lead_fee_yuan
 * - ZHEJIAN_SELF_PAY_COMMISSION_LIKE_INSURANCE：1/true 时，**非保险**订单在 commission-finalize 后也走「保证金钱包轧差」路径，而不再进入 pending_owner_repair_pay（适合冷启动无车主维修款 JSAPI 的场景）
 */

function truthyEnv(key) {
  return /^(1|true|yes)$/i.test(String(process.env[key] || '').trim());
}

function getLightCommerceConfig() {
  const raw = String(process.env.ZHEJIAN_LIGHT_COMMERCE_MODE || 'commission_on_actual').trim();
  const mode = ['commission_on_actual', 'lead_fee_only', 'both'].includes(raw) ? raw : 'commission_on_actual';
  const leadFeeYuan = Math.max(0, parseFloat(process.env.ZHEJIAN_LEAD_FEE_YUAN || '0') || 0);
  return {
    mode,
    lead_fee_yuan: leadFeeYuan,
    self_pay_wallet_finalize: truthyEnv('ZHEJIAN_SELF_PAY_COMMISSION_LIKE_INSURANCE'),
  };
}

function selfPayUsesWalletCommissionPath() {
  return getLightCommerceConfig().self_pay_wallet_finalize;
}

/** 线索标记 done 时是否写入平台线索费字段 */
function shouldPersistLeadFeeOnDone() {
  const c = getLightCommerceConfig();
  if (c.lead_fee_yuan <= 0) return false;
  return c.mode === 'lead_fee_only' || c.mode === 'both';
}

module.exports = {
  getLightCommerceConfig,
  selfPayUsesWalletCommissionPath,
  shouldPersistLeadFeeOnDone,
};
