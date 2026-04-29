/**
 * 居民个人「劳务报酬所得」预扣预缴（按次、扣缴义务人向个人支付时）
 * 依据：国家税务总局公告 2018 年第 61 号《个人所得税扣缴申报管理办法》及劳务报酬预扣率表二。
 *
 * 产品/账务口径（与 `transactions` / `users.balance` 实现一致）：
 * - 计税/代扣义务发生于「本笔奖励金**入账** / 应支付确认」之时（如写入 `transactions`、或待回溯 `withheld_rewards` 的约定税前额），
 *   不是「用户发起**提现**」之时；提现链路不再就余额重复按笔代扣（见 `reward-transfer-service` 等无个税逻辑）。
 * - 多笔、跨月与「同一项目连续性收入」是否合并为月一次，属税务认定范围；当前实现**按次**（与每笔入账单对应），
 *   若需改为按月合并预扣，须财务/税务书面确认后单独改。
 *
 * 每次收入减除费用：每次收入 ≤4000 元，减 800；每次收入 4000 以上，按收入的 20% 减除。
 * 表二速算：应纳税所得额 ≤20000 → 20%、0；20000–50000 → 30%、2000；>50000 → 40%、7000。
 *
 * @param {number} grossYuan 单次税前应发（元，≥0）
 * @returns {{ taxDeducted: number, afterTax: number, taxableIncomeForPreWithhold: number }}
 */
function preWithholdLaborRemunerationEachPayment(grossYuan) {
  const gross = Math.max(0, Math.round(Number(grossYuan) * 100) / 100);
  if (gross <= 0) {
    return { taxDeducted: 0, afterTax: 0, taxableIncomeForPreWithhold: 0 };
  }

  const taxable = computeLaborTaxableIncomePerPayment(gross);
  const taxRaw = preWithholdFromTaxableLabor(taxable);
  const taxDeducted = Math.round(taxRaw * 100) / 100;
  const afterTax = Math.round((gross - taxDeducted) * 100) / 100;
  return {
    taxDeducted,
    afterTax: Math.max(0, afterTax),
    taxableIncomeForPreWithhold: Math.round(taxable * 100) / 100,
  };
}

function computeLaborTaxableIncomePerPayment(gross) {
  if (gross <= 4000) {
    return Math.max(0, gross - 800);
  }
  return gross * 0.8;
}

function preWithholdFromTaxableLabor(taxable) {
  if (taxable <= 0) return 0;
  if (taxable <= 20000) return taxable * 0.2;
  if (taxable <= 50000) return taxable * 0.3 - 2000;
  return taxable * 0.4 - 7000;
}

module.exports = {
  preWithholdLaborRemunerationEachPayment,
  computeLaborTaxableIncomePerPayment,
  preWithholdFromTaxableLabor,
};
