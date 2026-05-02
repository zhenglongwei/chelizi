'use strict';

const NOTE_MIN = 4;
const NOTE_MAX = 600;
const FEE_MIN = 50;
const FEE_MAX = 500;

function parseWaived(v) {
  return v === true || v === 1 || v === '1';
}

/**
 * 预报价提交：拆解检测费校验（与产品文档一致：50～500、不超过维修总价 10%；或免费承诺 + 说明）
 * @param {object} body - req.body
 * @param {number} repairAmount - 维修分项合计（元）
 */
function validateDisassemblyForQuote(body, repairAmount) {
  const waived = parseWaived(body && body.disassembly_fee_waived);
  const note = String((body && body.disassembly_fee_note) || '').trim();
  if (note.length < NOTE_MIN) {
    return { ok: false, error: `请填写拆解检测费说明（至少 ${NOTE_MIN} 个字），列明检测项目或免费原因` };
  }
  if (note.length > NOTE_MAX) {
    return { ok: false, error: `拆解检测费说明请勿超过 ${NOTE_MAX} 字` };
  }
  const amt = parseFloat(repairAmount);
  if (Number.isNaN(amt) || amt <= 0) {
    return { ok: false, error: '维修总价无效' };
  }
  if (waived) {
    const raw = body && body.disassembly_fee;
    if (raw != null && raw !== '') {
      const f = parseFloat(raw);
      if (!Number.isNaN(f) && f > 0.01) {
        return { ok: false, error: '勾选「本次拆解检测免费」时，拆检费金额应为 0 或留空' };
      }
    }
    return { ok: true, waived: true, fee: 0, note };
  }
  const fee = parseFloat(body && body.disassembly_fee);
  if (Number.isNaN(fee)) {
    return { ok: false, error: '请填写拆解检测费（元），或勾选「本次拆解检测免费」' };
  }
  const rounded = Math.round(fee * 100) / 100;
  if (rounded < FEE_MIN || rounded > FEE_MAX) {
    return { ok: false, error: `拆解检测费须在 ${FEE_MIN}～${FEE_MAX} 元之间` };
  }
  const cap = Math.round(amt * 0.1 * 100) / 100;
  if (rounded > cap + 0.005) {
    return { ok: false, error: `拆解检测费不得超过维修总价（预报价）的 10%（当前上限 ¥${cap.toFixed(2)}）` };
  }
  return { ok: true, waived: false, fee: rounded, note };
}

module.exports = {
  validateDisassemblyForQuote,
  parseWaived,
};
