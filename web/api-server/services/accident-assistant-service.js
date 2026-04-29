/**
 * 车主事故报告（独立能力包）- 低风险版本
 * - 不做责任认定
 * - 输出：证据补拍清单、理赔/自费流程提示、价格区间估算（含假设）
 */

function clampRange(min, max) {
  const a = Number.isFinite(min) ? min : 0;
  const b = Number.isFinite(max) ? max : 0;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return [Math.max(0, Math.round(lo)), Math.max(0, Math.round(hi))];
}

function sumRanges(ranges) {
  let min = 0;
  let max = 0;
  for (const r of ranges || []) {
    if (!Array.isArray(r) || r.length < 2) continue;
    const [a, b] = clampRange(parseFloat(r[0]), parseFloat(r[1]));
    min += a;
    max += b;
  }
  return [min, max];
}

function normalizeText(s) {
  return String(s || '').trim();
}

function buildEvidenceChecklistFromAnalysis(analysisResult, input = {}) {
  const ar = analysisResult && typeof analysisResult === 'object' ? analysisResult : {};
  const damages = Array.isArray(ar.damages) ? ar.damages : [];
  const userDesc = normalizeText(input.user_description || '');

  const checklist = [];
  const add = (title, why) => {
    const t = normalizeText(title);
    if (!t) return;
    checklist.push({ title: t, why: normalizeText(why || '') });
  };

  // 通用补拍（低风险、强实用）
  add('车辆整体：前/后/左/右四角全景各1张', '用于判断受损范围、碰撞方向与多处伤的可能性');
  add('车牌与车型外观同框1张（可打码）', '用于与车辆信息匹配，避免多车/误车');
  add('受损部位近景2-3张（不同角度、含反光）', '用于确认凹陷/裂纹/掉漆的范围与深度');
  add('受损部位与周边参照物同框1张（手掌/尺子/硬币）', '用于估算尺寸与工艺（修/换/喷漆范围）');

  // 描述触发补充材料
  if (/(泡水|进水|涉水|淹|水位)/.test(userDesc)) {
    add('涉水位置与车内地毯/线束/仪表台照片', '泡水风险不一定在外观上直观，需更多证据判断处理方案');
  }
  if (/(异响|抖动|跑偏|方向盘|故障灯|发动机|变速箱|刹车)/.test(userDesc)) {
    add('仪表盘故障灯与里程照片', '辅助判断是否需要进一步诊断与拆检');
  }

  // 若 AI 未识别到任何损伤，提示补拍更容易识别的素材
  if (damages.length === 0) {
    add('白天自然光下重拍，避免夜间/强反光/雨天水渍', '提升识别与人工核对的准确性');
    add('将手机靠近受损面并保持水平，避免大角度斜拍', '减少透视变形带来的误判');
  }

  return {
    checklist,
    note: '提示：以上为“补拍建议清单”，不代表必须全部提供；越完整越利于更准确给出维修与费用区间。',
  };
}

function buildClaimGuide(input = {}) {
  const isInsurance = input && (input.is_insurance === true || String(input.is_insurance) === 'true');
  const hasPolice = input && (input.has_police_report === true || String(input.has_police_report) === 'true');
  const hasOtherParty = input && (input.has_other_party === true || String(input.has_other_party) === 'true');

  const steps = [];
  const materials = [];
  const addStep = (t) => steps.push(normalizeText(t));
  const addMaterial = (t) => materials.push(normalizeText(t));

  addStep('先拍照留存（全景+近景+参照物），避免挪车后无法复原现场信息');
  if (hasPolice) {
    addStep('保留交警出具材料（事故认定/简易程序等），后续理赔与纠纷处理以其为准');
  } else {
    addStep('如有争议或损失较大，建议报警/报交警获取权威材料（本工具不做责任认定）');
  }

  if (isInsurance) {
    addStep('联系保险公司报案，按要求补充事故信息与材料');
    addStep('与维修厂沟通：先按预估方案沟通，最终以到店查勘与保险流程为准');
  } else {
    addStep('自费维修：优先确认维修方式（修/换/喷漆范围）与质保条款');
    addStep('建议多家比价，并要求报价明细，避免后续加项争议');
  }

  if (hasOtherParty) {
    addStep('收集对方车辆信息（车牌/车型）、对方联系方式（可选），便于后续沟通与理赔流程');
  } else {
    addStep('若无对方信息（如单方事故/对方驶离），记录现场环境与时间地点信息，便于后续说明');
  }

  addMaterial('事故现场与车辆受损照片（建议按补拍清单）');
  if (isInsurance) addMaterial('保险公司要求的报案信息与材料（以保险公司指引为准）');
  if (hasPolice) addMaterial('交警/报警相关材料（如有）');

  return {
    boundary: '仅提供流程与材料清单提示，不构成责任认定或保险定损结论。',
    steps: steps.filter(Boolean),
    materials: materials.filter(Boolean),
  };
}

function estimatePriceFromAnalysis(analysisResult, input = {}) {
  const ar = analysisResult && typeof analysisResult === 'object' ? analysisResult : {};
  const suggestions = Array.isArray(ar.repair_suggestions) ? ar.repair_suggestions : [];
  const totalEst = Array.isArray(ar.total_estimate) ? ar.total_estimate : null;

  let baseRange = [0, 0];
  if (totalEst && totalEst.length >= 2) {
    baseRange = clampRange(parseFloat(totalEst[0]), parseFloat(totalEst[1]));
  } else {
    const ranges = suggestions.map((s) => s && s.price_range).filter(Boolean);
    baseRange = sumRanges(ranges);
  }

  // 价格区间假设（P1：不做报价承诺，只做“可解释估算”）
  const cityTier = normalizeText(input.city_tier || 'default'); // default|tier1|tier2|tier3
  const partsTypeAssumption = normalizeText(input.parts_type || 'unknown'); // oem|aftermarket|used|unknown

  const tierFactor =
    cityTier === 'tier1' ? 1.15 :
      cityTier === 'tier2' ? 1.08 :
        cityTier === 'tier3' ? 0.98 :
          1.0;

  const partsFactor =
    partsTypeAssumption === 'oem' ? 1.18 :
      partsTypeAssumption === 'aftermarket' ? 0.95 :
        partsTypeAssumption === 'used' ? 0.85 :
          1.0;

  const factor = tierFactor * partsFactor;
  const out = clampRange(baseRange[0] * factor, baseRange[1] * factor);

  const assumptions = [
    `城市系数=${tierFactor.toFixed(2)}（${cityTier || 'default'}）`,
    `配件假设系数=${partsFactor.toFixed(2)}（${partsTypeAssumption || 'unknown'}）`,
    '仅基于照片与文字信息估算，未含到店拆检可能新增项目',
  ];

  return {
    currency: 'CNY',
    range: out,
    base_range: baseRange,
    factor: Math.round(factor * 1000) / 1000,
    assumptions,
  };
}

module.exports = {
  buildEvidenceChecklistFromAnalysis,
  buildClaimGuide,
  estimatePriceFromAnalysis,
};

