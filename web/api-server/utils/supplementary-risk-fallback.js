/**
 * 车主有实质补充说明，但模型仍只给「未见损伤」或空结构时，注入与用户文字对应的泛化待查项（在 enhance 之前调用）。
 * 与提示词「照片 + 补充说明同等效力」一致，不限于发动机/泡水。
 */

/** 与 knowledge-base 中 isNoDamagePlaceholder 语义一致 */
function isNoDamagePlaceholder(d) {
  const part = (d && d.part ? String(d.part) : '').trim();
  const type = (d && d.type ? String(d.type) : '').trim();
  const noDamagePartValues = ['未识别', '无伤', '无损伤', '无事故损伤', '无异常', '未发现损伤', '未见损伤'];
  return (
    !part ||
    noDamagePartValues.some((v) => part === v || part.includes(v)) ||
    (type === '待确认' && (!part || part === '未识别'))
  );
}

const REPAIR_FLUFF_RE =
  /未见.*损伤|无明显碰撞|未发现明显损伤|无事故损伤|外观完好|未见明显|照片未见|无可见损伤/;

/** 排除明显无内容的补充 */
const TRIVIAL_DESC = /^(无|没有|暂无|暂无补充|无补充|谢谢|好的|ok|\.{0,8})$/i;

function hasSubstantiveUserDescription(desc) {
  const s = String(desc || '').trim();
  if (s.length < 5) return false;
  if (TRIVIAL_DESC.test(s)) return false;
  return true;
}

/** AI 是否未体现用户补充（无有效损伤行、建议为空或全是套话） */
function responseIgnoresUserRisk(ar) {
  const damages = ar.damages || [];
  const sug = ar.repair_suggestions || [];
  const hasRealDamage = damages.some((d) => !isNoDamagePlaceholder(d));
  if (hasRealDamage) return false;

  if (sug.length === 0) return true;

  const hasSubstantive = sug.some((s) => {
    const t = String(s.item || '').trim();
    return t.length > 6 && !REPAIR_FLUFF_RE.test(t);
  });
  return !hasSubstantive;
}

/**
 * @param {object} ar - mapQwen 原始结果（未经 enhance）
 * @param {string} userDescription
 * @param {object} vehicleInfo - 请求体中的 vehicle_info
 * @returns {object}
 */
function applySupplementaryRiskFallback(ar, userDescription, vehicleInfo) {
  const desc = String(userDescription || '').trim();
  if (!hasSubstantiveUserDescription(desc)) return ar;
  if (!responseIgnoresUserRisk(ar)) return ar;

  const out = JSON.parse(JSON.stringify(ar));
  const vid = '车辆1';

  const fallbackDamages = [
    {
      part: '内饰与座舱相关',
      type: '依据车主补充说明待查（照片不可见或无法确认）',
      severity: '待定',
      area: '',
      material: '',
      vehicleId: vid
    },
    {
      part: '电气、线束与控制单元',
      type: '依据车主补充说明待查（照片不可见或无法确认）',
      severity: '待定',
      area: '',
      material: '',
      vehicleId: vid
    }
  ];

  const fallbackSug = [
    { item: `${vid}-按车主补充说明逐项实车核对（内饰、功能件、线束与电控）` },
    { item: `${vid}-依据用户文字描述进行系统诊断与静态/路试功能验证` }
  ];

  out.damages = fallbackDamages.map((d) => ({ ...d }));

  const prevSug = out.repair_suggestions || [];
  const keptSug = prevSug.filter((s) => {
    const t = String(s.item || '').trim();
    return t.length > 6 && !REPAIR_FLUFF_RE.test(t);
  });
  out.repair_suggestions = [...keptSug];
  const seen = new Set(out.repair_suggestions.map((r) => String(r.item || '').trim()));
  for (const r of fallbackSug) {
    if (!seen.has(r.item)) {
      out.repair_suggestions.push(r);
      seen.add(r.item);
    }
  }

  const summaryLine = `照片侧结论与车主补充说明须同等对待。外观可见部分：未见明显碰撞类损伤（以照片为准）。车主补充：「${desc.slice(0, 220)}」。须在实车中按陈述逐项核查内饰、电气及动力传动等，不得仅依据照片判定无维修需求。`;

  const vi = out.vehicle_info;
  if (Array.isArray(vi) && vi.length > 0) {
    const v0 = { ...vi[0] };
    if (!v0.vehicleId) v0.vehicleId = vid;
    if (!v0.overallSeverity || v0.overallSeverity === '轻微') v0.overallSeverity = '中等';
    if (!v0.damageSummary || /未见.*损伤|无明显|未发现明显|无事故损伤/.test(v0.damageSummary)) {
      v0.damageSummary = summaryLine;
    }
    v0.damage_level = '三级';
    v0.damagedParts = [...new Set([...(v0.damagedParts || []), '内饰与座舱相关', '电气、线束与控制单元'])];
    v0.damageTypes = [...new Set([...(v0.damageTypes || []), '依据用户陈述待查', '照片不可见项'])];
    out.vehicle_info = [v0, ...vi.slice(1)];
  } else if (vi && typeof vi === 'object' && !Array.isArray(vi)) {
    const plate = vi.plate_number || vi.plateNumber || '';
    out.vehicle_info = [
      {
        vehicleId: vid,
        plate_number: plate,
        brand: vi.brand || '',
        model: vi.model || '',
        color: vi.color || '',
        overallSeverity: '中等',
        damageSummary: summaryLine,
        damagedParts: ['内饰与座舱相关', '电气、线束与控制单元'],
        damageTypes: ['依据用户陈述待查', '照片不可见项'],
        damage_level: '三级',
        total_estimate: [0, 0],
        vehicle_price_tier: vi.vehicle_price_tier || null,
        vehicle_price_max: vi.vehicle_price_max || null
      }
    ];
  } else {
    out.vehicle_info = [
      {
        vehicleId: vid,
        plate_number: (vehicleInfo && vehicleInfo.plate_number) || '',
        brand: (vehicleInfo && vehicleInfo.brand) || '',
        model: (vehicleInfo && vehicleInfo.model) || '',
        color: '',
        overallSeverity: '中等',
        damageSummary: summaryLine,
        damagedParts: ['内饰与座舱相关', '电气、线束与控制单元'],
        damageTypes: ['依据用户陈述待查', '照片不可见项'],
        damage_level: '三级',
        total_estimate: [0, 0],
        vehicle_price_tier: null,
        vehicle_price_max: null
      }
    ];
  }

  if (
    !Array.isArray(out.total_estimate) ||
    out.total_estimate.length < 2 ||
    (Number(out.total_estimate[0]) === 0 && Number(out.total_estimate[1]) === 0)
  ) {
    out.total_estimate = [2000, 18000];
  }

  return out;
}

module.exports = {
  applySupplementaryRiskFallback,
  hasSubstantiveUserDescription
};
