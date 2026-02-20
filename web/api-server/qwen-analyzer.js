/**
 * 千问大模型分析模块
 * - 事故车定损分析（analyzeWithQwen）
 * - 营业执照 OCR（analyzeLicenseWithQwen）
 * - 评价 AI 审核（analyzeReviewWithQwen）
 * 仅使用上传到服务器的图片 URL，不使用 base64
 * 多车事故：返回 vehicle_info 数组，用户可选择定损车辆
 */

const axios = require('axios');

// 知识库规则摘要（T/IAC CAMRA 50-2024、JT/T 795-2023），用于注入提示词
const KNOWLEDGE_PROMPT_TEXT = [
  '## 零部件修换规则（定损时参考）',
  '- 保险杠/前保险杠：塑料开裂或变形，长度≥50mm→更换；否则修复',
  '- 引擎盖/前机盖：钢质塑性变形，面积>40%或加强筋变形→更换；否则修复',
  '- 翼子板：钢质塑性变形，面积>40%/凹陷>15mm/筋线曲折>20°→更换；否则修复',
  '- 车门：钢质塑性变形，面积>40%/凹陷>10mm/玻璃框扭曲→更换；否则修复',
  '- 车身结构件/纵梁：弯曲变形→修复；折曲/扭曲变形→更换',
  '- 大灯/前大灯/灯具：灯脚断裂>3个/固定孔开裂>2个/灯罩开裂→更换；否则修复',
  '- 散热器框架：金属塑性变形面积>20%→更换',
  '- 汽车玻璃：主视区裂缝长度>50mm→更换；否则修复',
  '- 安全气囊事故触发、安全带功能失效：必须更换'
].join('\n');

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const MODEL_VL = 'qwen-vl-plus';

/**
 * 调用千问视觉模型（仅传图片 URL）
 * @param {Array<{type:string, image_url?:{url:string}, text?:string}>} content - 消息内容
 * @param {string} apiKey - API Key
 * @param {string} [systemPrompt] - 可选 system 角色设定
 * @returns {Promise<string>} 模型返回的文本
 */
async function callQwenVision(content, apiKey, systemPrompt) {
  const messages = [];
  if (systemPrompt && String(systemPrompt).trim()) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content });
  const res = await axios.post(
    DASHSCOPE_BASE + '/chat/completions',
    {
      model: MODEL_VL,
      messages,
      max_tokens: 2048
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey
      },
      timeout: 60000
    }
  );
  const choice = res.data?.choices?.[0];
  if (!choice) throw new Error(res.data?.error?.message || '千问 API 返回异常');
  return (choice.message?.content || '').trim();
}

/**
 * 事故车定损分析（仅用图片 URL）
 * @param {string[]} imageUrls - 事故照片的完整 URL 数组（需公网可访问）
 * @param {Object} vehicleInfo - 车辆信息
 * @param {string} reportId - 报告 ID
 * @param {string} apiKey - API Key
 * @returns {Promise<Object>} 定损分析结果
 */
async function analyzeWithQwen(imageUrls, vehicleInfo, reportId, apiKey) {
  if (!imageUrls || imageUrls.length === 0) {
    throw new Error('请提供事故照片');
  }

  const content = [];
  for (const url of imageUrls) {
    const u = String(url || '').trim();
    if (!u.startsWith('http')) continue;
    content.push({ type: 'image_url', image_url: { url: u } });
  }
  if (content.length === 0) throw new Error('无有效图片 URL');

  const prompt = buildDamagePrompt();

  content.push({ type: 'text', text: prompt });

  const raw = await callQwenVision(content, apiKey);
  return mapQwenResponseToAnalysisResult(raw, reportId, vehicleInfo);
}

function buildDamagePrompt() {

  return `你是一位熟悉国家与行业标准的车险理赔查勘定损专家。请分析以上事故照片中**所有可见车辆**（轿车、SUV、卡车等），为每辆车分别输出车辆信息与损伤情况。用户将从中选择需要定损的车辆。

## 必须完成
1. **识别多张照片中的每一辆车**：用户通常会上传多张照片，每张可能包含一辆或多辆车的局部信息。请根据各照片中车辆的**外形、颜色、部位、损伤特征**等综合判断，将同一辆车在不同照片中的信息归并，确定每一辆独立车辆并编号（车辆1、车辆2…）。
2. **每辆车必须输出**：车牌号（可见则识别，不可见或无法识别则为空字符串）、品牌/车型（能识别则填）、颜色、损伤部位列表、损伤类型、整体严重程度、本车维修建议摘要。
3. **损伤与维修方案**须参考以下知识库规则，明确修/换判定：

${KNOWLEDGE_PROMPT_TEXT}

## 返回格式（严格 JSON，不要输出其他内容）
{
  "vehicles": [
    {
      "vehicleId": "车辆1",
      "plateNumber": "车牌号或空字符串",
      "brand": "品牌或null",
      "model": "车型或null",
      "color": "颜色或null",
      "damagedParts": ["前保险杠", "引擎盖"],
      "damageTypes": ["碰撞变形", "撞击凹陷"],
      "overallSeverity": "轻微|中等|严重",
      "damageSummary": "本车详细维修建议：各部位修/换及工艺说明，禁止笼统表述",
      "damages": [
        {"part": "前保险杠", "type": "碰撞变形", "severity": "严重", "area": "损伤区域", "material": "塑料"}
      ]
    }
  ],
  "repair_suggestions": [
    {"item": "维修项目（可区分车辆，如「车辆1-更换前保险杠」），仅描述修/换及工艺，禁止包含价格、费用等"}
  ],
  "confidence_score": 0.0-1.0
}

## 注意事项
- vehicles 数组必须包含多张照片中**每一辆**独立车辆（含未受损的，damagedParts/damages 可为空数组）。
- plateNumber 无法识别时填 ""，不要臆造。
- brand 为品牌（如宝马、特斯拉），model 为具体车型（如3系、Model Y），勿填 SUV 等通用类型。
- overallSeverity 只能是：轻微、中等、严重。
- damageSummary 须具体可执行，禁止「根据AI分析建议」等空泛用语。
- repair_suggestions 的 item 仅描述维修项目与工艺，禁止包含任何价格、费用内容。`;
}

/** 按车辆 ID 汇总维修建议费用（item 格式：车辆1-xxx 或 车辆1：xxx） */
function computePerVehicleEstimate(vehicleId, repairSuggestions) {
  const list = Array.isArray(repairSuggestions) ? repairSuggestions : [];
  let sumMin = 0;
  let sumMax = 0;
  for (const r of list) {
    const item = String(r.item || '').trim();
    if (!item.startsWith(vehicleId + '-') && !item.startsWith(vehicleId + '：')) continue;
    const pr = r.price_range;
    if (Array.isArray(pr) && pr.length >= 2) {
      sumMin += parseFloat(pr[0]) || 0;
      sumMax += parseFloat(pr[1]) || 0;
    }
  }
  return [sumMin, sumMax];
}

function mapQwenResponseToAnalysisResult(raw, reportId, vehicleInfo) {
  let parsed = {};
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (_) {}

  const vehicles = Array.isArray(parsed.vehicles) ? parsed.vehicles : [];
  const repairSuggestions = Array.isArray(parsed.repair_suggestions) ? parsed.repair_suggestions : [];
  const totalEstimate =
    Array.isArray(parsed.total_estimate) && parsed.total_estimate.length >= 2
      ? parsed.total_estimate
      : [0, 0];
  const confidence = typeof parsed.confidence_score === 'number' ? parsed.confidence_score : 0.8;

  // 合并各车 damages（先构建，供后续计算每车损伤等级）
  const damagesByVehicle = {};
  for (const v of vehicles) {
    const vid = v.vehicleId || `车辆${vehicles.indexOf(v) + 1}`;
    const list = Array.isArray(v.damages) ? v.damages : [];
    damagesByVehicle[vid] = list;
  }

  // 将 vehicles 映射为 vehicle_info 数组，并为每辆车计算 damage_level、total_estimate
  const vehicleInfoArray = vehicles.map((v, idx) => {
    const vid = v.vehicleId || `车辆${idx + 1}`;
    const vehicleDamages = damagesByVehicle[vid] || [];
    const [estMin, estMax] = computePerVehicleEstimate(vid, repairSuggestions);
    const hasDamage = vehicleDamages.length > 0;
    const sev = v.overallSeverity ?? '中等';
    const damageLevel = !hasDamage ? '无伤' : (sev === '轻微' ? '一级' : sev === '严重' ? '三级' : '二级');
    return {
      vehicleId: vid,
      plate_number: v.plateNumber ?? v.plate_number ?? '',
      brand: v.brand ?? v.brand_name ?? '',
      model: v.model ?? v.model_name ?? '',
      color: v.color ?? '',
      damagedParts: Array.isArray(v.damagedParts) ? v.damagedParts : [],
      damageTypes: Array.isArray(v.damageTypes) ? v.damageTypes : [],
      overallSeverity: sev,
      damageSummary: v.damageSummary ?? '',
      damage_level: damageLevel,
      total_estimate: [estMin, estMax]
    };
  });

  // 合并各车 damages，并标注 vehicleId
  const damages = [];
  for (const v of vehicles) {
    const vid = v.vehicleId || `车辆${vehicles.indexOf(v) + 1}`;
    const list = Array.isArray(v.damages) ? v.damages : [];
    for (const d of list) {
      damages.push({
        ...d,
        vehicleId: vid
      });
    }
  }

  // 兼容旧格式：若 AI 未返回 vehicles 但返回了 damages，则保留
  const legacyDamages = Array.isArray(parsed.damages) ? parsed.damages : [];
  if (damages.length === 0 && legacyDamages.length > 0) {
    legacyDamages.forEach((d) => damages.push({ ...d, vehicleId: '车辆1' }));
  }

  return {
    report_id: reportId,
    vehicle_info: vehicleInfoArray.length > 0 ? vehicleInfoArray : vehicleInfo || {},
    damages,
    repair_suggestions: repairSuggestions,
    total_estimate: totalEstimate,
    confidence_score: confidence
  };
}

/**
 * 营业执照 OCR（仅用图片 URL）
 * 扩展：同时识别维修资质等级（GB/T 16739 一类/二类/三类），营业执照经营范围或资质说明中若有则提取
 * @param {string} imgUrl - 营业执照图片的完整 URL（需公网可访问）
 * @param {string} apiKey - API Key
 * @returns {Promise<{enterprise_name, license_number, legal_representative, qualification_level}>}
 */
async function analyzeLicenseWithQwen(imgUrl, apiKey) {
  const url = String(imgUrl || '').trim();
  if (!url.startsWith('http')) {
    throw new Error('请提供有效的营业执照图片 URL');
  }

  const content = [
    { type: 'image_url', image_url: { url } },
    {
      type: 'text',
      text: `请识别这张营业执照图片，提取以下信息：
1. 企业名称、统一社会信用代码（营业执照号码）、法定代表人
2. 维修资质等级：若经营范围或资质说明中有一类/二类/三类维修企业（参照 GB/T 16739 汽车维修业经营业务条件），则提取，否则为 null

严格按以下 JSON 格式输出，不要输出其他内容：
{"enterprise_name": "企业名称", "license_number": "统一社会信用代码", "legal_representative": "法定代表人姓名", "qualification_level": "一类"或"二类"或"三类"或null}`
    }
  ];

  const raw = await callQwenVision(content, apiKey);
  return mapLicenseResponse(raw);
}

function mapLicenseResponse(raw) {
  let parsed = {};
  let aiResult = 'recognition_failed';
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
      aiResult = 'no_qualification_found';
    }
  } catch (_) {}

  const qual = String(parsed.qualification_level || '').trim();
  const validQual = ['一类', '二类', '三类'].includes(qual) ? qual : null;
  if (validQual) aiResult = 'recognized';

  return {
    enterprise_name: String(parsed.enterprise_name || '').trim(),
    license_number: String(parsed.license_number || '').trim(),
    legal_representative: String(parsed.legal_representative || '').trim(),
    qualification_level: validQual,
    qualification_ai_result: aiResult
  };
}

/**
 * 职业技能等级证书 OCR（仅用图片 URL）
 * 识别右侧持证人信息：姓名、职业名称、工种/职业方向、职业等级、证书编号（身份证不识别）
 * @param {string} imgUrl - 证书图片的完整 URL（需公网可访问）
 * @param {string} apiKey - API Key
 * @returns {Promise<{name, occupation_name, job_direction, skill_level, certificate_no}>}
 */
async function analyzeVocationalCertificateWithQwen(imgUrl, apiKey) {
  const url = String(imgUrl || '').trim();
  if (!url.startsWith('http')) {
    throw new Error('请提供有效的证书图片 URL');
  }

  const content = [
    { type: 'image_url', image_url: { url } },
    {
      type: 'text',
      text: `请识别这张图片是否为职业技能等级证书（人社部门颁发的职业资格证书，通常有持证人照片、姓名、职业名称、等级、证书编号等）。

若图片**不是**职业技能等级证书（如风景照、营业执照、身份证、其他无关图片），必须返回：
{"is_certificate": false, "recognition_failed": true, "name": "", "occupation_name": "", "job_direction": "", "skill_level": null, "certificate_no": ""}

若图片**是**职业技能等级证书，提取以下字段：
1. name: 持证人姓名
2. occupation_name: 职业名称，如「汽车维修工」
3. job_direction: 工种/职业方向
4. skill_level: 职业等级原文，如「三级/高级工」「五级/初级工」（五级/初级、四级/中级、三级/高级工、二级/技师、一级/高级技师）
5. certificate_no: 证书编号

严格按 JSON 格式输出，不要输出其他内容。证书格式示例：
{"is_certificate": true, "recognition_failed": false, "name": "张三", "occupation_name": "汽车维修工", "job_direction": "汽车机械维修工", "skill_level": "三级/高级工", "certificate_no": "1234567890"}`
    }
  ];

  const raw = await callQwenVision(content, apiKey);
  return mapVocationalCertResponse(raw);
}

function mapVocationalCertResponse(raw) {
  let parsed = {};
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (_) {}

  const isCert = parsed.is_certificate === true || parsed.is_certificate === 'true';
  const failed = parsed.recognition_failed === true || parsed.recognition_failed === 'true';
  const name = String(parsed.name || '').trim();
  const occupation = String(parsed.occupation_name || '').trim();
  const certNo = String(parsed.certificate_no || '').trim();

  // 非证书或识别失败：返回普通技工
  if (failed || !isCert || (!name && !occupation && !certNo)) {
    return {
      name: '',
      occupation_name: '',
      job_direction: '',
      skill_level_raw: '',
      skill_level: '普通技工',
      certificate_no: '',
      recognition_failed: true
    };
  }

  const skillLevel = String(parsed.skill_level || '').trim();
  const level = mapSkillLevelToOption(skillLevel);

  return {
    name,
    occupation_name: occupation,
    job_direction: String(parsed.job_direction || '').trim(),
    skill_level_raw: skillLevel,
    skill_level: level,
    certificate_no: certNo,
    recognition_failed: false
  };
}

/** 将证书等级原文映射为系统选项（初级工、中级工、高级工、技师、高级技师） */
function mapSkillLevelToOption(raw) {
  if (!raw) return '普通技工';
  const s = raw.replace(/\s/g, '');
  if (/五级|初级/.test(s)) return '初级工';
  if (/四级|中级/.test(s)) return '中级工';
  if (/三级|高级工/.test(s)) return '高级工';
  if (/二级|技师/.test(s) && !/高级/.test(s)) return '技师';
  if (/一级|高级技师/.test(s)) return '高级技师';
  return '普通技工';
}

/**
 * 维修资质证明 OCR（当营业执照未识别到资质时，用户额外上传的资质证明图片）
 * @param {string} imgUrl - 资质证明图片的完整 URL
 * @param {string} apiKey - API Key
 * @returns {Promise<{qualification_level: string|null}>}
 */
async function analyzeQualificationCertificateWithQwen(imgUrl, apiKey) {
  const url = String(imgUrl || '').trim();
  if (!url.startsWith('http')) {
    throw new Error('请提供有效的资质证明图片 URL');
  }

  const content = [
    { type: 'image_url', image_url: { url } },
    {
      type: 'text',
      text: `请识别这张汽车维修资质证明图片（如经营许可证、备案证明等），提取维修资质等级。
参照 GB/T 16739 汽车维修业经营业务条件：一类维修企业、二类维修企业、三类维修业户。
若图片中有一类/二类/三类字样，则提取；否则为 null。

严格按以下 JSON 格式输出：
{"qualification_level": "一类"或"二类"或"三类"或null}`
    }
  ];

  const raw = await callQwenVision(content, apiKey);
  let parsed = {};
  let aiResult = 'recognition_failed';
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
      aiResult = 'no_qualification_found';
    }
  } catch (_) {}
  const qual = String(parsed.qualification_level || '').trim();
  const validQual = ['一类', '二类', '三类'].includes(qual) ? qual : null;
  if (validQual) aiResult = 'recognized';
  return { qualification_level: validQual, qualification_ai_result: aiResult };
}

// ===================== 评价 AI 审核 =====================

const REVIEW_AUDIT_SYSTEM_PROMPT = `你是车厘子平台的评价审核助手，仅做形式化、可比对的合规校验。

## 职责
- 校验结算单真实性（是否为维修结算单、商户名/金额是否与订单一致）
- 校验施工图与维修项目匹配度（图片是否体现对应维修场景）
- 校验评价内容质量（是否与维修项目相关、是否无意义水评）
- 校验内容合规（无广告、低俗、辱骂、虚假宣传）
- 判断内容是否像套模板、AI 生成批量套话

## 合规红线
- 不审核好评/差评倾向，只校验完整性、真实性、违规
- 不对维修质量做担保
- 必须返回合法 JSON，禁止自然语言兜底`;

/**
 * 构建评价审核 User Prompt
 */
function buildReviewAuditUserPrompt(order, review, images) {
  const orderJson = JSON.stringify(order, null, 2);
  const reviewJson = JSON.stringify(review, null, 2);
  const imagesDesc = (images || []).map((i) => `- ${i.type}: ${i.url}`).join('\n') || '（无图片）';

  return `请根据以下订单、评价和图片信息，完成合规审核。

## 订单信息
\`\`\`json
${orderJson}
\`\`\`

## 评价信息
\`\`\`json
${reviewJson}
\`\`\`

## 图片列表（上方已附图片，此处为类型说明）
${imagesDesc}

## 审核要求
1. **settlementCheck**：若有结算单图，判断是否为维修结算单、是否含商户名/公章、金额是否与订单 quotedAmount 接近（±20% 内可接受）
2. **imageMatchCheck**：施工图（completion）是否与 repairProjects 匹配（如钣金喷漆应有施工/完工图，换滤芯应有相关图）
3. **contentQuality**：评价内容是否与维修项目相关、是否≥10 字、是否非纯水词（如仅「不错」「很好」）
4. **contentViolation**：是否含广告、低俗、辱骂、虚假宣传
5. **similarityRisk**：是否像套模板、AI 生成套话（如过于工整、缺乏具体细节）

## 返回格式（严格 JSON，不要输出其他内容）
{
  "pass": true 或 false,
  "rejectReason": "不通过时给用户的提示，通过时为 null",
  "details": {
    "settlementCheck": {
      "hasValidSettlement": true/false,
      "shopNameMatch": true/false,
      "amountMatch": true/false,
      "note": "简要说明"
    },
    "imageMatchCheck": {
      "matchesProject": true/false,
      "sufficientCount": true/false,
      "note": "简要说明"
    },
    "contentQuality": {
      "quality": "invalid"|"basic"|"quality"|"维权参考",
      "relevant": true/false,
      "minLengthOk": true/false,
      "note": "简要说明"
    },
    "contentViolation": {
      "isClean": true/false,
      "violations": []
    },
    "similarityRisk": {
      "isOriginal": true/false,
      "riskLevel": "low"|"medium"|"high"
    }
  }
}

请直接输出 JSON，不要输出其他文字。`;
}

/**
 * 评价 AI 审核（基于《评价AI审核-千问接入设计方案》）
 * @param {Object} params - { order, review, images, apiKey }
 * @param {Object} params.order - { orderId, shopName, quotedAmount, repairProjects, complexityLevel, faultDescription }
 * @param {Object} params.review - { content, rating, isNegative }
 * @param {Array<{type:string, url:string}>} params.images - 图片列表，type: settlement | completion | problem | chat
 * @param {string} params.apiKey - API Key
 * @returns {Promise<{pass: boolean, rejectReason?: string, details?: Object}>}
 */
async function analyzeReviewWithQwen({ order, review, images, apiKey }) {
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('未配置千问 API Key');
  }

  const content = [];
  const imageList = Array.isArray(images) ? images : [];
  const maxImages = 6;
  let added = 0;

  for (const img of imageList) {
    if (added >= maxImages) break;
    const url = String(img?.url || '').trim();
    if (!url.startsWith('http')) continue;
    content.push({ type: 'image_url', image_url: { url } });
    added++;
  }

  const userPrompt = buildReviewAuditUserPrompt(order, review, imageList);
  content.push({ type: 'text', text: userPrompt });

  const raw = await callQwenVision(content, apiKey, REVIEW_AUDIT_SYSTEM_PROMPT);
  return mapReviewAuditResponse(raw);
}

function mapReviewAuditResponse(raw) {
  let parsed = {};
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (_) {}

  const pass = parsed.pass === true;
  const rejectReason = pass ? null : (String(parsed.rejectReason || '').trim() || '评价未通过 AI 审核');

  return {
    pass,
    rejectReason: pass ? null : rejectReason,
    details: parsed.details || {}
  };
}

module.exports = {
  analyzeWithQwen,
  analyzeLicenseWithQwen,
  analyzeVocationalCertificateWithQwen,
  analyzeQualificationCertificateWithQwen,
  analyzeReviewWithQwen
};
