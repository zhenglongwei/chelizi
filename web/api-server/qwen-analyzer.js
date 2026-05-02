/**
 * 千问大模型分析模块
 * - 事故车定损分析（analyzeWithQwen）
 * - 营业执照 OCR（analyzeLicenseWithQwen）
 * - 首评提交：材料-表述矛盾（analyzeReviewEvidenceContradictionWithQwen）
 * - 整体性重评等：原全量评价审核（analyzeReviewWithQwen）
 * 仅使用上传到服务器的图片 URL，不使用 base64
 * 多车事故：返回 vehicle_info 数组，用户可选择定损车辆
 */

const { callQwenText, callQwenVision, trimVisionImageUrl, QWEN_MODEL } = require('./model-adapters/qwen');
const {
  CANONICAL_PARTS_TYPES,
  normalizePartsType,
} = require('./constants/parts-types');

// 兼容：client 中已实现 callQwenText/callQwenVision/trimVisionImageUrl/QWEN_MODEL

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

/** 单次请求图片上限（超出易触发 400） */
const MAX_VL_IMAGES_PER_REQUEST = Math.min(16, Math.max(1, parseInt(process.env.QWEN_VL_MAX_IMAGES || '8', 10) || 8));

// callQwenText / callQwenVision 已由 model-adapters/qwen/client 提供（避免本文件继续膨胀）

/**
 * 事故车定损分析（仅用图片 URL）
 * @param {string[]} imageUrls - 事故照片完整 URL（公网）；可为空数组，此时须配合足够长的 userDescription 走纯文本分析
 * @param {Object} vehicleInfo - 车辆信息
 * @param {string} reportId - 报告 ID
 * @param {string} apiKey - API Key
 * @param {string} [userDescription] - 车主补充说明（与照片同等效力；内饰、电气、泡水、异响等）
 * @returns {Promise<Object>} 定损分析结果
 */
async function analyzeWithQwen(imageUrls, vehicleInfo, reportId, apiKey, userDescription) {
  const urls = (imageUrls || [])
    .map((u) => String(u || '').trim())
    .filter((u) => u.startsWith('http'));
  const descTrim = userDescription
    ? String(userDescription).replace(/\r\n/g, ' ').replace(/\n/g, ' ').trim()
    : '';

  if (urls.length === 0) {
    if (descTrim.length < 4) {
      throw new Error('请提供公网可访问的事故照片，或至少 4 个字的文字描述');
    }
    const prompt = buildDamagePrompt(userDescription, { textOnly: true });
    const systemPrompt = buildDamageSystemPrompt(userDescription);
    const raw = await callQwenText(
      systemPrompt && String(systemPrompt).trim()
        ? systemPrompt
        : '你是资深汽修与事故初判顾问。用户未上传照片，仅根据文字描述输出与「定损 JSON」说明一致的 JSON；禁止编造用户未写的损伤；与汽车维修/事故/故障无关时 repair_related=false。',
      prompt,
      apiKey
    );
    return mapQwenResponseToAnalysisResult(raw, reportId, vehicleInfo);
  }

  if (urls.length > MAX_VL_IMAGES_PER_REQUEST) {
    console.warn(`[qwen-analyzer] 定损图片 ${urls.length} 张，仅取前 ${MAX_VL_IMAGES_PER_REQUEST} 张以避免接口限制`);
  }
  const limited = urls.slice(0, MAX_VL_IMAGES_PER_REQUEST);

  const prompt = buildDamagePrompt(userDescription);
  /** 先文字后图片：强化「先读规则与用户描述再看图」，减少模型只看图忽略补充描述 */
  const content = [{ type: 'text', text: prompt }];
  for (const u of limited) {
    content.push({ type: 'image_url', image_url: { url: u } });
  }

  const systemPrompt = buildDamageSystemPrompt(userDescription);
  const raw = await callQwenVision(content, apiKey, systemPrompt || undefined);
  return mapQwenResponseToAnalysisResult(raw, reportId, vehicleInfo);
}

/** 用户有补充描述时注入 system，与 user 消息中的长 prompt 双保险 */
function buildDamageSystemPrompt(userDescription) {
  const desc = userDescription ? String(userDescription).replace(/\r\n/g, ' ').replace(/\n/g, ' ').trim() : '';
  if (!desc) return '';
  const short = desc.slice(0, 1200);
  return `你是拥有二十年经验的资深汽修专家。定损时须把**车主补充说明**与**事故照片**视为**同等地位**的信息源：照片反映外观与可见机械状态；补充说明反映**车主实际写到的**座舱/内饰、异响、故障灯、无法启动、涉水等**照片未必能呈现**的情况。**输出必须严格对应「照片里有什么」+「文字里写了什么」**，对文字与照片均未出现的项目**一律不得编造**（如用户未写电路问题则不得臆测电路老化/线束故障；用户未写泡水则不得写进水）。

车主补充说明如下：
「${short}」

硬性要求：**禁止**仅凭「照片未见碰撞/划痕」就用空 damages 或「未见损伤」占位敷衍**已写在上面**的现象；必须在 vehicles[].damages、vehicles[].damageSummary、repair_suggestions 中**逐条回应用户文字里可识别的诉求**（可写推断部位、待查项、检测工艺，type 可用「待实车确认」等），但**每条须能对应到用户原话中的具体现象或部件**，不得为用户未提及的系统追加「预防性检测」类凑数项。**repair_suggestions 每条必须带齐** \`vehicle_id\`、\`damage_part\`、\`repair_method\`（见用户消息 JSON 说明）：\`damage_part\` 仅写部位简称；\`repair_method\` 仅 \`换\` 或 \`修\`；**同一 vehicle_id + damage_part 只能输出一条**，须与知识库修换规则及该车 damages 自洽，**禁止**对同一部位同时给「修」与「换」两条。每辆车必须输出 **human_display**（明显损伤 / 可能损伤 / 维修建议），**禁止**在三段中出现「用户陈述」「照片显示」等来源词。**不要**输出与 vehicles 语义重复的孤立顶层 damages 数组。请严格按用户消息中的 JSON 格式输出。`;
}

function buildDamagePrompt(userDescription, opts) {
  const textOnly = !!(opts && opts.textOnly);
  const modePrefix = textOnly
    ? `## 本单：仅文字、无照片（必读）
用户**未上传**车损/事故照片；你**只能**依据下方车主文字判断是否与「车辆事故、外观损伤、机械/电气故障、维修需求」相关，并输出与下文格式一致的 JSON。
- **禁止**编造用户未写的外观碰撞、划痕、凹陷、漆面损伤等细节。
- 用户写到的故障码、故障灯、异响、抖动、无法启动、涉水等，按文字给出**待查项与检修方向**，可标注「待实车确认」；不得凭空追加用户未提及的系统故障。
- **repair_related**：文字明确属于车辆事故/维修/故障咨询场景则为 true；若为闲聊、与车无关内容则为 false，并说明原因。

`
    : '';
  const descEscaped = userDescription
    ? String(userDescription).replace(/\r\n/g, ' ').replace(/\n/g, ' ').trim().slice(0, 2000)
    : '';
  const descBlock = descEscaped
    ? `\n## 双信息源之一：车主补充说明（与照片同等效力）\n以下文字与事故照片**地位相同**，均为定损依据。可能涉及座舱/内饰、泡水与进水、熄火与无法启动、异响与抖动、故障灯、空调与除雾、影音与天窗、线束与模块、异味与烟熏、行驶工况异常等**单看照片无法判断**的内容：\n「${descEscaped}」\n\n`
    : '';

  const descPriorityBlock = descEscaped
    ? `## 双源同等规则（必读）
- **分析顺序**：先完整阅读车主补充说明中的**每一条字面内容**，再结合照片看**可见损伤**；输出须**同时覆盖**「照片能确认的」与「**用户文字已写明**、且与文字可对应」的推断或待查项。**禁止无中生有**：不得写入用户**未提及**且照片**不能佐证**的内容（如用户只写外观刮蹭却追加电路老化、线束隐性故障、电瓶寿命、发动机内部进水等）。
- **禁止**：仅凭「照片未见明显碰撞/划痕」就将 damages 留空、或只填「未见损伤」类占位、或 repair_suggestions 仅有抛光/洗车等外观项而**不回应**用户文字中**已写明**的非外观问题。
- **须执行**：仅对用户文字**字面已出现**的现象或系统做延伸（如用户写「右前轮异响」→ 悬架/制动/轮毂轴承待查；用户写「空调不凉」→ HVAC 待查）。每条 damages / possible_damage 须能回答「对应用户哪一句话」；**用户未写涉水/泡水/进水，则不得**新增水损类条目。overallSeverity 与用户描述的严重程度一致，**禁止**为凑严重度虚构水损或重大机损。
- **damageSummary** 两段式：（1）照片可见结论；（2）**仅就用户文字中已写明的点**写明推断与建议检测/维修路径；不得在第（2）段写入用户未出现的隐患。
- **repair_suggestions**：至少 2 条，且均须与**用户原话可逐条对应**或与本车 damages 一致；**仅当用户文字明确写涉水/泡水/进水**时才允许水损拆检类工艺；禁止「全车电路预防性检测」等与用户描述无关的凑数项。**每条须含** \`vehicle_id\`（与 vehicles[].vehicleId 一致）、\`damage_part\`、\`repair_method\`（仅 \`换\` 或 \`修\`）；\`damage_part\` **只写部位名**（如「前保险杠」「引擎盖」），**禁止**在 damage_part 或 item 里再写「更换、修复、修、换」及**禁止**用括号展开损伤尺寸/比例/条数（这些写在 vehicles[].damages 的 type、severity、area 等即可）。**同一 vehicle_id + damage_part 仅允许一条**：按知识库在「修」与「换」中**择一**，不得并列两条。
- **最低产出**（仅在有车主补充说明且确有**至少两种可区分现象/部位**时适用）：第一辆车 **damages 至少 2 条**，且两条须对应**不同部位或用户文字中并列的不同现象**；**不是**同一部位因措辞不同拆两条。若用户只描述单一部位现象，则允许 1 条 damages，不得为凑数硬拆。
- **人性化展示（human_display，每车必填）**：输出 \`obvious_damage\`、\`possible_damage\`、\`repair_advice\` 三个字符串数组。
  - **明显损伤**：仅列**照片可认定**或**与用户某句原话直接对应且已较确定**的项；无则 \`[]\`。
  - **可能损伤**：仅列**照片有疑点**或**用户文字明确提出了待查现象**的项；无照片与文字依据则 \`[]\`；禁止写用户未提的电路老化、隐性 ECU 故障、进水泡水等。
  - **维修建议**：与上述及 repair_suggestions 一致，**禁止出现价格**；禁止无依据的「全面体检」套话。
  - **禁止**在三段中出现「用户陈述」「照片显示」等来源词。
  - **多车约束（新增，强制）**：在 human_display、damageSummary、guidance 中 **禁止**写入「车辆1/车辆2/车1/车2」等标签；这些标签只用于 vehicleId 字段本身，展示端会用 Tab 切换车辆。

`
    : '';

  return `${modePrefix}你是一位熟悉国家与行业标准的资深汽修专家，拥有二十年以上的汽修经验。请依据**车主补充说明（若有）与事故照片**输出定损 JSON。**无补充说明时：只写照片能支撑的内容；有补充说明时：照片与文字都要看，但两者都不得臆造未出现的信息。**请为照片中**所有可见车辆**分别输出车辆信息与损伤/待查情况。用户将从中选择需要定损的车辆。
${descBlock}${descPriorityBlock}
## 证据与推断边界（核心，高于一切联想）
- **无车主补充说明**：**严格按照片分析**。仅输出照片中**可直接或合理推断**的损伤与风险（外观碰撞、可见变形/开裂/脱落、可见油液渗漏等）。**禁止无中生有**：不得因「照片看不清内部」而在 damages、human_display.possible_damage、repair_advice、repair_suggestions、damageSummary 中写入**照片中无线索且用户未陈述**的内容，包括但不限于：泡水/进水、电路老化、线束隐性故障、ECU/模块故障、电瓶寿命、发动机内部损伤、内饰霉变等。**无照片依据时 possible_damage、repair_advice 须为 \`[]\`**；repair_suggestions 仅保留与**可见损伤及知识库修换规则**直接相关的项，且**仍须遵守**与有补充说明时相同的结构化规则（\`vehicle_id\`、\`damage_part\` 仅部位名、\`repair_method\` 仅换/修、**同一车同一部位一条**、item 勿写长句），禁止「全车电路预防性检测」等套话。
- **有车主补充说明**：**同时**依据照片与用户文字；对用户**字面已写到**的现象或部件给出 damages / human_display / repair_suggestions。**仍禁止无中生有**：不得追加用户**未提及**且照片**不能佐证**的隐患（例如用户只描述保险杠却写怀疑线束老化）。水损/进水类：**仅当**用户文字**明确**写涉水/泡水/进水或照片有**明确**水迹时方可输出。
- **统一底线**：每一条「可能损伤」或待查 damages 须能说明依据来自**（1）照片中可见疑点**或**（2）用户原话中的具体表述**；否则不得输出。

## 必须完成
1. **信息源规则**：**无**用户文字 → 输出以**照片客观可见**为唯一依据，禁止编造任何照片不可见故障。**有**用户文字 → **照片与文字双源**，但**仅**输出双源中**各自能支撑**的项；**禁止**把行业常识当「用户没说也要写」的理由。
2. **识别多张照片中的每一辆车（须按下面「内化分析顺序」执行，再落笔 JSON）**：用户通常会上传多张照片，每张可能包含一辆或多辆车的局部信息。请根据各照片中车辆的**外形、颜色、部位、损伤特征**等综合判断，将同一辆车在不同照片中的信息归并，确定每一辆独立车辆并编号（车辆1、车辆2…）。
3. **每辆车必须输出**：车牌号（可见则识别，不可见或无法识别则为空字符串）、品牌/车型（能识别则填）、颜色、损伤部位列表、损伤类型、整体严重程度、本车 damageSummary（无用户文字时**只写照片结论**；有用户文字时写照片结论 + **仅用户已写明**的对应推断）、**human_display**（见上双源规则）。

## 内化分析顺序（不要求输出中间过程，但必须按此顺序思考后再写 JSON）
与人工定损一致，避免**同一辆车、同一损失部位**在 damages / damagedParts / repair_suggestions 中重复出现：
1. **逐张**：依次查看每张照片，识别图中车辆（可能为局部）、可见的**损失部位**与**损失程度**（仅记客观可见或用户文字已写明的推断）。
2. **判车与数量**：用**车辆一致性原则**归并——对比**颜色、外形轮廓、前脸/尾灯造型、轮毂与车身比例、可见车牌片段、相邻照片间是否同一损伤特征**等，判断哪些局部属于**同一物理车辆**；确定独立车辆种类与数量，并固定为 \`车辆1\`、\`车辆2\`…。
3. **归类与去重**：在已确定的每辆 \`vehicleId\` 下，把各张照片中属于该车的损伤**全部归入**该车的 \`damages\`、\`damagedParts\`、\`damageTypes\` 等；**同一车辆、同一零部件名称（如「前保险杠」「引擎盖」）在 damages 中只保留一条**：多张照片、多种表述角度须**合并**为一条（在 type、severity、area、material 中综合表述），**禁止**因换角度拍摄或措辞不同而拆成多条同 part；\`repair_suggestions\` 与 damages 一一对应部位，**同一 vehicle_id + damage_part 仅一条**（见上文结构化规则）。
4. **车型价格档次**：根据 brand/model 推断该车官方指导价档次，用于奖励金车价系数。输出 vehicle_price_tier：low（10万及以下）、mid（10-30万）、high（30万以上）；同时输出 vehicle_price_range：该车型官方指导价区间（万元），如 [35, 45] 表示 35-45 万，取上限用于精确查表。常见品牌参考：沃尔沃 XC60 约 35-45 万、宝马 3 系约 30-40 万、丰田凯美瑞约 18-25 万。
5. **损伤与维修方案**须参考以下知识库规则，明确修/换判定。知识库用于**已有损伤部位**的修换判断，**不得**用知识库条目替代「用户与照片的证据」，去虚构用户未描述、照片无显示的故障。

${KNOWLEDGE_PROMPT_TEXT}

## 返回格式（严格 JSON，不要输出其他内容）
{
  "repair_related": true/false,
  "repair_related_reason": "若为 false，说明为什么与修车无关（如非车辆/无事故/无维修场景/明显与汽车维修无关）",
  "vehicles": [
    {
      "vehicleId": "车辆1",
      "plateNumber": "车牌号或空字符串",
      "brand": "品牌或null",
      "model": "车型或null",
      "color": "颜色或null",
      "vehicle_price_tier": "low|mid|high（根据品牌车型推断，用于奖励金车价系数）",
      "vehicle_price_range": [35, 45]（官方指导价区间，单位万元，取上限用于奖励金车价系数查表）,
      "damagedParts": ["前保险杠", "引擎盖"],
      "damageTypes": ["碰撞变形", "撞击凹陷"],
      "overallSeverity": "轻微|中等|严重",
      "damageSummary": "无用户文字：仅写照片可见结论。有用户文字：照片结论 + 仅针对用户已写明现象的推断与建议；禁止写入用户未提及的隐患",
      "damages": [
        {"part": "前保险杠", "type": "碰撞变形", "severity": "严重", "area": "损伤区域", "material": "塑料"}
      ],
      "human_display": {
        "obvious_damage": ["面向车主的可读短句，写照片上能认定的损伤；无则 []"],
        "possible_damage": ["仅写照片疑点或用户文字已写明现象的待查项；无依据则 []；禁止电路老化/进水等无证据臆测"],
        "repair_advice": ["可读短句，写建议采取的检修或处理步骤；勿含价格；可与 repair_suggestions 对应"]
      },
      "guidance": {
        "communication_script": "到店后沟通话术（必须 50-200 字；可直接复制给维修厂/前台；围绕本车损伤与待查点，不得出现“车辆1/车辆2”等标签）",
        "arrival_notes": ["到店注意事项短句1", "短句2（建议 4-8 条；围绕本车损伤与待查点）"]
      }
    }
  ],
  "repair_suggestions": [
    {
      "vehicle_id": "车辆1",
      "damage_part": "前保险杠",
      "repair_method": "换",
      "process_note": "可选：工艺补充（如塑料件开裂超阈），勿重复部位名与修换字样；禁止价格",
      "item": "车辆1-前保险杠"
    }
  ],
  "confidence_score": 0.0-1.0
}

## 注意事项
- **修车相关性过滤（强制）**：你需要判断这些图片是否与「车辆事故/维修/定损」相关。\n  - 若图片明显与修车无关（例如：风景、人物、美食、聊天截图、票据与车无关、非车辆物体等），请输出：\n    - \`repair_related=false\`\n    - \`repair_related_reason\` 写明原因\n    - vehicles/damages/repair_suggestions 可为空数组或最小占位（不要编造）\n  - 若图片与修车相关（哪怕损伤不明显但确为车辆/事故场景/维修相关材料），请输出：\n    - \`repair_related=true\`\n    - 按既定规则输出车辆与损伤/待查项（禁止无中生有）\n
- vehicles 数组必须包含多张照片中**每一辆**独立车辆。**仅有照片、无用户文字**且确未见损伤时，damagedParts/damages 可为空、overallSeverity 可为「轻微」，**禁止**为填满字段而编造不可见故障。**已有用户补充说明**时，须在 damages / damageSummary / repair_suggestions 中**回应用户文字里实际写到的现象**（不得全空或仅用「未见损伤」敷衍**已描述的问题**），且**不得**追加用户未写、照片无证的项。
- **同一车辆内 damages 按 part 去重**：\`part\` 表示同一车身部件时不得出现多条（除非用户文字或照片能证明是**两个可区分的独立碰撞区域**且业务上须分列——外观钣金场景极少）；归并不清时宁可合并为一条并写清 type/area。
- plateNumber 无法识别时填 ""，不要臆造。
- brand 为品牌（如宝马、特斯拉），model 为具体车型（如3系、Model Y），勿填 SUV 等通用类型。
- overallSeverity 只能是：轻微、中等、严重。
- damageSummary 须具体可执行，禁止「根据AI分析建议」等空泛用语；有用户描述时须点明**用户已写明的风险**与对应处置建议，**不得**混入用户未写的风险。
- **repair_suggestions（结构化，强制）**：每条必有 \`vehicle_id\`、\`damage_part\`、\`repair_method\`（\`换\`|\`修\`）；\`item\` 建议为「车辆N-」+ \`damage_part\` 原文，与 vehicle_id、damage_part 一致，**不要**写成「车辆1-更换前保险杠（…）」这类把修换与损伤程度写进 item 的长句。可选 \`process_note\` 写工艺补充。**同一 vehicle_id + damage_part 严禁两条**（不得对同一部位同时输出修与换）。禁止任何价格、费用字段或文案。
- vehicle_price_range 为 [min, max] 数组，单位万元，如沃尔沃 XC60 填 [35, 45]、丰田凯美瑞填 [18, 25]，无法推断时可为 null。
- 每辆车的 **human_display** 必须与该车 damages / damageSummary、以及 **属于该车的** repair_suggestions（按 vehicle_id 归属）**一致**；三数组均允许为空数组，但不得缺失字段名。`;
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

const {
  mergeDuplicateVehiclesInArray,
  dedupeDamagesWithinList,
  dedupeRepairSuggestionsByItem,
  normalizeRepairSuggestionsStructured
} = require('./utils/analysis-result-sanitize');

function mapQwenResponseToAnalysisResult(raw, reportId, vehicleInfo) {
  let parsed = {};
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (_) {}
  const repairRelated =
    typeof parsed.repair_related === 'boolean'
      ? parsed.repair_related
      : (typeof parsed.repairRelated === 'boolean' ? parsed.repairRelated : null);
  const repairRelatedReason = typeof parsed.repair_related_reason === 'string'
    ? parsed.repair_related_reason
    : (typeof parsed.repairRelatedReason === 'string' ? parsed.repairRelatedReason : '');

  const vehiclesRaw = Array.isArray(parsed.vehicles) ? parsed.vehicles : [];
  const vehicles = mergeDuplicateVehiclesInArray(vehiclesRaw);
  const repairSuggestions = dedupeRepairSuggestionsByItem(
    normalizeRepairSuggestionsStructured(
      Array.isArray(parsed.repair_suggestions) ? parsed.repair_suggestions : []
    )
  );
  const totalEstimate =
    Array.isArray(parsed.total_estimate) && parsed.total_estimate.length >= 2
      ? parsed.total_estimate
      : [0, 0];
  const confidence = typeof parsed.confidence_score === 'number' ? parsed.confidence_score : 0.8;

  // 各车 damages（vehicles 已合并同 vehicleId；勿用 indexOf 推导 id，避免重复块歧义）
  const damagesByVehicle = {};
  for (let vi = 0; vi < vehicles.length; vi++) {
    const v = vehicles[vi];
    const vid = v.vehicleId || `车辆${vi + 1}`;
    damagesByVehicle[vid] = Array.isArray(v.damages) ? v.damages : [];
  }

  // 将 vehicles 映射为 vehicle_info 数组，并为每辆车计算 damage_level、total_estimate
  const vehicleInfoArray = vehicles.map((v, idx) => {
    const vid = v.vehicleId || `车辆${idx + 1}`;
    const vehicleDamages = damagesByVehicle[vid] || [];
    const [estMin, estMax] = computePerVehicleEstimate(vid, repairSuggestions);
    const hasDamage = vehicleDamages.length > 0;
    const sev = v.overallSeverity ?? '中等';
    const damageLevel = !hasDamage ? '无伤' : (sev === '轻微' ? '一级' : sev === '严重' ? '三级' : '二级');
    const tier = (v.vehicle_price_tier || '').toLowerCase();
    const priceTier = ['low', 'mid', 'high'].includes(tier) ? tier : null;
    const priceRange = Array.isArray(v.vehicle_price_range) && v.vehicle_price_range.length >= 2
      ? v.vehicle_price_range
      : null;
    const priceMaxWan = priceRange ? Math.max(parseFloat(priceRange[0]) || 0, parseFloat(priceRange[1]) || 0) : null;
    const vehiclePriceMax = priceMaxWan != null && priceMaxWan > 0 ? Math.round(priceMaxWan * 10000) : null;
    return {
      vehicleId: vid,
      plate_number: v.plateNumber ?? v.plate_number ?? '',
      brand: v.brand ?? v.brand_name ?? '',
      model: v.model ?? v.model_name ?? '',
      color: v.color ?? '',
      vehicle_price_tier: priceTier,
      vehicle_price_max: vehiclePriceMax,
      damagedParts: Array.isArray(v.damagedParts) ? v.damagedParts : [],
      damageTypes: Array.isArray(v.damageTypes) ? v.damageTypes : [],
      overallSeverity: sev,
      damageSummary: v.damageSummary ?? '',
      damage_level: damageLevel,
      total_estimate: [estMin, estMax],
      human_display:
        v.human_display && typeof v.human_display === 'object' ? v.human_display : undefined
    };
  });

  // 合并各车 damages（vehicles 已按 vehicleId 合并，每车内 damages 已去重）
  const damages = [];
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i];
    const vid = v.vehicleId || `车辆${i + 1}`;
    const list = Array.isArray(v.damages) ? v.damages : [];
    for (const d of list) {
      damages.push({
        ...d,
        vehicleId: d.vehicleId || vid
      });
    }
  }

  // 兼容旧格式：若 AI 未返回 vehicles 但返回了 damages，则保留
  const legacyDamages = Array.isArray(parsed.damages) ? parsed.damages : [];
  if (damages.length === 0 && legacyDamages.length > 0) {
    dedupeDamagesWithinList(legacyDamages).forEach((d) =>
      damages.push({ ...d, vehicleId: d.vehicleId || '车辆1' })
    );
  }

  return {
    report_id: reportId,
    vehicle_info: vehicleInfoArray.length > 0 ? vehicleInfoArray : vehicleInfo || {},
    // 新格式：保留 vehicles（含 guidance），用于前端按车 Tab 展示；历史数据缺失时前端会兜底
    vehicles,
    damages,
    repair_suggestions: repairSuggestions,
    total_estimate: totalEstimate,
    confidence_score: confidence,
    ...(repairRelated == null ? {} : { repair_related: repairRelated }),
    ...(repairRelatedReason ? { repair_related_reason: repairRelatedReason } : {})
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
      text: `请识别这张图片是否为人社部门颁发的、与机动车维修相关的有效证书。市场上常见两类（**同等有效、版式不同**），请**据实识别**，不要臆造或改写证上文字：

1）**职业技能等级证书**（如汽车维修工等）：证上常见「五级/初级工」「四级/中级工」「三级/高级工」「二级/技师」「一级/高级技师」等表述。
2）**机动车检测维修专业技术人员职业水平证书**（人社部统考、与交通运输部共同用印）：证上等级常见「维修士」或「工程师」，并可能有专业方向（如机电维修技术、整形技术、检测评估与运用技术等）。

若图片**不是**上述证书（如风景照、营业执照、身份证、无关材料），必须返回：
{"is_certificate": false, "recognition_failed": true, "name": "", "occupation_name": "", "job_direction": "", "skill_level": null, "certificate_no": ""}

若图片**是**相关证书，提取以下字段（均须**尽量与证书原文一致**）：
1. name: 持证人姓名
2. occupation_name: 资格/职业名称**原文**（证书上印什么写什么）
3. job_direction: 工种、专业方向或专业类别**原文**（如有）
4. skill_level: 等级/资格级别**原文**（证书上印什么写什么，勿合并或改写，例如照抄「维修士」「工程师」「五级/初级工」「三级/高级工」等）
5. certificate_no: 证书编号（如有）

严格按 JSON 格式输出，不要输出其他内容。示例：
{"is_certificate": true, "recognition_failed": false, "name": "张三", "occupation_name": "机动车检测维修工", "job_direction": "机电维修技术", "skill_level": "工程师", "certificate_no": "1234567890"}`
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
  const jobDir = String(parsed.job_direction || '').trim();
  const level = mapSkillLevelToOption(skillLevel, occupation, jobDir);

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

/**
 * 将证书等级原文映射为系统存证用选项（两套体系并存，无主次；优先按证上「职业技能等级」字样映射，再处理水平评价的维修士/工程师）
 * @param {string} raw - skill_level 原文
 * @param {string} [occupationName] - 职业名称原文（辅助极少歧义场景）
 * @param {string} [jobDirection] - 专业方向原文
 */
function mapSkillLevelToOption(raw, occupationName = '', jobDirection = '') {
  if (!raw) return '普通技工';
  const s = raw.replace(/\s/g, '');
  const bundle = s + String(occupationName || '').replace(/\s/g, '') + String(jobDirection || '').replace(/\s/g, '');

  // 水平评价独有字样「维修士」
  if (/维修士/.test(s)) return '检测维修维修士';

  // 「高级工程师」等含「高级工」子串，须先于「三级/高级工」规则判断
  if (/高级工程师|高级技师/.test(s)) return '高级技师';

  // 职业技能等级常见字样（与「初级工程师」等职称区分）
  if (/五级|初级/.test(s) && !/工程师/.test(s)) return '初级工';
  if (/四级|中级/.test(s) && !/工程师/.test(s)) return '中级工';
  if (/三级|高级工/.test(s)) return '高级工';
  if (!/工程师/.test(s) && /二级|技师/.test(s) && !/高级/.test(s)) return '技师';
  if (/一级/.test(s)) return '高级技师';

  // 水平评价「工程师」
  if (/工程师/.test(s)) return '检测维修工程师';

  // 证上仅写等级代码、职业名称在别栏时少量兜底
  if (/汽车维修工|汽车修理工|汽车维修/.test(bundle) && /五级|初级/.test(bundle)) return '初级工';
  if (/汽车维修工|汽车修理工|汽车维修/.test(bundle) && /四级|中级/.test(bundle)) return '中级工';
  if (/汽车维修工|汽车修理工|汽车维修/.test(bundle) && (/三级|高级工/).test(bundle)) return '高级工';

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

const REVIEW_AUDIT_SYSTEM_PROMPT = `你是资深汽修专家，负责从真实性、专业性、有效性等角度评估评价内容的质量等级。从真实性角度，判断是否像真实车主亲身经历；从专业性角度，判断是否与维修项目相关、信息具体可验证；从有效性角度，判断是否对其他车主有决策参考意义。

## 报价/结算金额核对原则（重要）
- 订单上的「预报价/锁价」与「最终结算」允许存在差异：拆检后常见内部损伤、隐性故障、增项或方案变更，在透明沟通前提下**加价或减价都可能是合理**的。
- 若仅凭结算单与锁价数字不同就判「异常」，须谨慎；应结合评价文字是否描述变更原因、是否存在欺诈表述等综合判断。
- 若数字一致或接近（如相对差异在 ±20% 内且无明显欺诈语义），通常应认为金额核对**可接受**。
- 不要机械套用固定比例；对说不清原因且差异极大的情形，可在 settlementCheck.note 中说明存疑，但仍以文字内容质量为主。

## 职责
- 校验内容合规（无广告、低俗、辱骂、虚假宣传）
- 校验评价内容质量：**真实性**（是否像真实车主亲身经历）、**有效性**（是否与维修项目相关、信息具体可验证）、**参考价值**（是否对其他车主有决策参考意义）
- 判断内容是否像套模板、AI 生成批量套话
- 若有结算单/施工图，可辅助校验与订单一致性，但**内容质量等级仅与文字内容相关**，不依赖图片数量

## 与奖励金的关系（平台化）
- **pass / 合规 / 水评判定**决定能否进入发奖与展示流程；**现金档位与追加结算**由平台规则与指标完成度驱动，**不**以本 JSON 中的 **contentQuality.quality** 作为发钱档位依据（该字段可作展示、运营参考与风控辅助）。

## 合规红线
- 不审核好评/差评倾向，只校验合规与内容质量
- 不对维修质量做担保
- 必须返回合法 JSON，禁止自然语言兜底`;

/**
 * 构建评价审核 User Prompt
 */
function buildReviewAuditUserPrompt(order, review, images) {
  const orderJson = JSON.stringify(order, null, 2);
  const reviewJson = JSON.stringify(review, null, 2);
  const imagesDesc = (images || []).map((i) => `- ${i.type}: ${i.url}`).join('\n') || '（无图片）';
  const holistic = review && review.holisticAudit === true;
  const reviewSectionTitle = holistic
    ? '评价信息（整体性重评：首评与追评分列，请勿混为一谈）'
    : '评价信息（含客观题答案，供真实性、参考价值判断）';
  const reviewFootnote = holistic
    ? '此为**追评触发后的整体性重评**：JSON 中 `firstReview` 为首评，`followUps` 为各次追评（含阶段说明）。通常**不含** objectiveAnswers（客观题以首评提交时为准）。星级字段 `ratingFromFirstReview` / `isLowStarFromFirstReview` 取自首评，仅供辅助。请综合首评与追评的语义关系（强化、补充、纠正等）评定整体内容质量。'
    : 'objectiveAnswers 为车主必答客观题（自费 5 题或事故车 6 题，含金额一致、过程透明、配件一致、故障解决、质保等），并附 progressSynced/partsShown/faultResolved 与旧版字段对齐；可结合主观描述综合判断真实性。';

  return `请根据以下订单、评价和图片信息，完成合规审核。

## 订单信息
\`\`\`json
${orderJson}
\`\`\`

## ${reviewSectionTitle}
\`\`\`json
${reviewJson}
\`\`\`
注：${reviewFootnote}

## 图片列表（上方已附图片，此处为类型说明）
${imagesDesc}

## 审核要求
1. **settlementCheck**：若有结算单图，判断是否为维修结算单、是否含商户名/公章、金额是否与订单 quotedAmount **大致一致或可解释**（±20% 内通常可接受；超出时若评价或上下文暗示拆检增项、定损调整等，勿轻易判「金额不符」）
2. **imageMatchCheck**：施工图（completion）是否与 repairProjects 匹配。注：图片为辅助，**不影响 contentQuality 等级**
3. **contentQuality**：评价内容质量等级（**非发钱档位**），**仅依据文字内容**，重点考察真实性、有效性、参考价值。quality 取值：invalid（无效水评）/ basic（1级基础）/ quality（2级优质）/ benchmark（3级标杆）/ 维权参考（有效差评）
   - **invalid**：纯水评（仅「好、不错、划算」等）、与项目无关、明显套模板/AI 生成
   - **basic**：有效评价，有与维修项目相关的描述，信息真实
   - **quality**：basic + 具备参考价值，如避坑提示、价格对比、服务细节、故障排查过程、师傅/门店具体信息等，能帮助其他车主做决策
   - **benchmark**：quality + 信息密度高、细节详实、对同车型/同项目车主决策价值大
   - **维权参考**：差评但内容真实、有参考价值（如具体问题描述、沟通经过）
4. **contentViolation**：是否含广告、低俗、辱骂、虚假宣传
5. **similarityRisk**：是否像套模板、AI 生成套话（如过于工整、缺乏具体细节、无个人化表述）

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
      "quality": "invalid"|"basic"|"quality"|"benchmark"|"维权参考",
      "relevant": true/false,
      "minLengthOk": true/false,
      "note": "简要说明"
    },
    "operationsReview": {
      "summary": "仅当 pass=false 时必填：给运营审核员的综合摘要（1～3 句），说明为何判定未达发奖/展示的内容标准",
      "notMetItems": ["必填，未达标要点列表，每条一句，至少 1 条，面向审核员而非车主"],
      "forAuditorOnly": true
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

**重要**：当 **pass=false**（将转运营人工裁定）时，**details.operationsReview** 必须填写：**notMetItems** 至少 1 条、**summary** 非空；与 **rejectReason**（给车主看的提示）区分——operationsReview 面向审核员，可更完整、可引用客观题与内容质量分项。当 **pass=true** 时 **operationsReview** 填 null 或省略。

请直接输出 JSON，不要输出其他文字。`;
}

/**
 * 评价 AI 审核（基于《评价AI审核-千问接入设计方案》）
 * @param {Object} params - { order, review, images, apiKey }
 * @param {Object} params.order - { orderId, shopName, quotedAmount, repairProjects, complexityLevel, faultDescription }
 * @param {Object} params.review - 首评提交：{ content, rating, isNegative, objectiveAnswers? }；整体性重评：{ holisticAudit, auditInstruction, firstReview, followUps?, ratingFromFirstReview, isLowStarFromFirstReview }
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

/**
 * pass=false 时保证存在运营可读的未达标摘要与要点（模型漏填时从 details 回填）
 */
function normalizeReviewOperationsReview(parsed, pass, rejectReason) {
  const base = parsed.details && typeof parsed.details === 'object' ? { ...parsed.details } : {};
  if (pass) {
    delete base.operationsReview;
    return base;
  }
  let op = base.operationsReview;
  if (!op || typeof op !== 'object') op = {};
  let notMetItems = Array.isArray(op.notMetItems)
    ? op.notMetItems.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  let summary = String(op.summary || '').trim();

  const cq = base.contentQuality && typeof base.contentQuality === 'object' ? base.contentQuality : {};
  if (!notMetItems.length) {
    if (cq.note) notMetItems.push(String(cq.note).trim());
    if (cq.quality === 'invalid') notMetItems.push('内容质量判定为 invalid（无效水评、与维修项目无关或明显套话/AI 生成等）');
    if (cq.relevant === false) notMetItems.push('主观描述与维修项目关联性不足');
    if (cq.minLengthOk === false) notMetItems.push('主观描述过短或未达有效信息门槛');
  }
  const viol = base.contentViolation && typeof base.contentViolation === 'object' ? base.contentViolation : {};
  if (viol.isClean === false && Array.isArray(viol.violations)) {
    viol.violations.forEach((v) => {
      const s = String(v || '').trim();
      if (s) notMetItems.push(`合规：${s}`);
    });
  }
  const sim = base.similarityRisk && typeof base.similarityRisk === 'object' ? base.similarityRisk : {};
  if (sim.isOriginal === false && String(sim.riskLevel || '').toLowerCase() !== 'low') {
    notMetItems.push(`套模板/雷同风险：${sim.riskLevel || 'medium'}`);
  }
  if (!notMetItems.length) {
    notMetItems.push(rejectReason || '千问判定未达内容标准，详见 rejectReason');
  }
  if (!summary) {
    summary = rejectReason || notMetItems.join('；');
  }
  base.operationsReview = {
    summary,
    notMetItems,
    forAuditorOnly: true,
  };
  return base;
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
  const details = normalizeReviewOperationsReview(parsed, pass, rejectReason);

  return {
    pass,
    rejectReason: pass ? null : rejectReason,
    details,
  };
}

// ===================== 首评提交：仅「服务商材料图 vs 车主表述」矛盾 + 合规底线 =====================

const REVIEW_EVIDENCE_CONTRADICTION_SYSTEM_PROMPT = `你是平台评价合规助手，只协助判断两件事：

1) **图文/材料矛盾（严格）**：在已给出的「服务商侧材料图」（结算单、完工/施工类照片）与「车主文字 + 客观题/星级摘要」之间，是否出现**明确、可指认的事实矛盾**（例如：文字或星级强烈声称「未施工/未更换」而材料却显示有对应项目；文字称「从无比对图」而图中有多张新旧件对比等）。**因远景、模糊、信息不全、无法一一核对不得判矛盾**；「不确定」「看不清」时一律视为**无明确矛盾**。

2) **内容合规底线**：评价文字是否含明显**广告引流、黄赌毒、严重人身攻击辱骂**等。一般吐槽、情绪表达、用语简略**不算**违规。

**禁止**：不得以「内容过短、不够详细、不够优质、像模板、缺乏真实体验、参考价值不足、水评」等理由令 pass=false。这类**不**属本环节职责。

**输出**：仅输出一个 JSON 对象，无其它文字。`;

/**
 * 构建「材料 vs 车主表述」矛盾审核 User Prompt（与 buildReviewAuditUserPrompt 同构入参，语义收窄）
 */
function buildReviewEvidenceContradictionUserPrompt(order, review, images) {
  const orderJson = JSON.stringify(order, null, 2);
  const reviewJson = JSON.stringify(review, null, 2);
  const imagesDesc = (images || []).map((i) => `- ${i.type}: ${i.url}`).join('\n') || '（无图）';
  return `请仅依据下列信息完成矛盾与合规判断（见系统指令）。

## 订单
\`\`\`json
${orderJson}
\`\`\`

## 车主评价与客观信息（含评价正文，可为空）
\`\`\`json
${reviewJson}
\`\`\`

## 服务商材料图类型说明
${imagesDesc}

## 输出 JSON 格式（严格遵守）
{
  "pass": true 或 false,
  "rejectReason": "当且仅当 pass=false 时填写：给车主看的一句话原因（**不得**提「过短/优质/参考性」等）",
  "details": {
    "textImageContradiction": {
      "level": "none" 或 "suspect" 或 "clear",
      "note": "内部说明，可为空；clear 时简述矛盾点"
    },
    "contentViolation": {
      "isClean": true 或 false,
      "violations": []
    }
  }
}

规则：
- 仅当 **level 为 "clear"** 且你确信存在**明确事实矛盾**时，可令 pass=false（rejectReason 说明矛盾，面向车主、简短）。
- level 为 "suspect" 或 "none" 时，**pass 应为 true**（除非触达内容合规底线）。
- 内容合规不通过时 pass=false，rejectReason 说明违规类型（如广告、辱骂）；
- 若材料图与评价整体可并存、仅有细节说不清，**pass=true**。

请直接输出 JSON。`;
}

function mapEvidenceContradictionResponse(raw) {
  let parsed = {};
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (_) {}

  const det = parsed.details && typeof parsed.details === 'object' ? parsed.details : {};
  const tti = det.textImageContradiction && typeof det.textImageContradiction === 'object' ? det.textImageContradiction : {};
  const level = String(tti.level || 'none').toLowerCase();
  const isClearContradiction = level === 'clear' || /明确|严重矛盾/.test(String(tti.level || ''));
  const viol = det.contentViolation && typeof det.contentViolation === 'object' ? det.contentViolation : {};
  const isClean = viol.isClean !== false;
  const structuralFail = isClearContradiction || !isClean;
  let pass = !structuralFail && parsed.pass !== false;
  if (structuralFail) pass = false;

  let rejectReason = pass
    ? null
    : String(parsed.rejectReason || '').trim() || '评价未通过材料与表述一致性审核';

  const details = {
    textImageContradiction: {
      level: tti.level || (level === 'clear' ? 'clear' : 'none'),
      note: tti.note || '',
    },
    contentViolation: {
      isClean: !!isClean,
      violations: Array.isArray(viol.violations) ? viol.violations : [],
    },
    evidenceContradictionAudit: true,
  };

  if (!pass && !rejectReason) {
    rejectReason = '评价未通过材料与表述一致性审核';
  }

  return {
    pass,
    rejectReason: pass ? null : rejectReason,
    details,
  };
}

/**
 * 主评价提交流程专用：不评判文字是否「优质/详细」，只判服务商图与车主表述是否明确矛盾 + 底线合规
 */
async function analyzeReviewEvidenceContradictionWithQwen({ order, review, images, apiKey }) {
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('未配置千问 API Key');
  }

  const content = [];
  const imageList = Array.isArray(images) ? images : [];
  if (imageList.length === 0) {
    return {
      pass: true,
      rejectReason: null,
      details: { skipped: true, reason: 'no_merchant_images' },
    };
  }

  const maxImages = 6;
  let added = 0;
  for (const img of imageList) {
    if (added >= maxImages) break;
    const url = String(img?.url || '').trim();
    if (!url.startsWith('http')) continue;
    content.push({ type: 'image_url', image_url: { url } });
    added++;
  }
  if (content.length === 0) {
    return {
      pass: true,
      rejectReason: null,
      details: { skipped: true, reason: 'no_valid_image_urls' },
    };
  }

  const userPrompt = buildReviewEvidenceContradictionUserPrompt(order, review, imageList);
  content.push({ type: 'text', text: userPrompt });

  const raw = await callQwenVision(content, apiKey, REVIEW_EVIDENCE_CONTRADICTION_SYSTEM_PROMPT);
  return mapEvidenceContradictionResponse(raw);
}

// ========== 材料审核（维修完成凭证） ==========

const MATERIAL_AUDIT_SYSTEM_PROMPT = `你是资深汽车维修专家，在汽修行业拥有超过五年的经验，请你负责审核维修完成时上传的材料。根据订单维修方案、报价金额、车辆信息，审核服务商上传的维修完成凭证（修复后照片、结算单、物料照片），判断材料是否真实、与订单匹配、合规。

审核原则（金额）：
- 结算单金额与订单报价/锁价不必逐分一致；拆检后内部损伤、增项、定损或方案变更导致**合理上浮**是行业常见情况，只要材料看起来是真实结算凭证且与维修范围大体匹配即可，勿因「与报价有差异」单独判失败。
- 仅当金额与方案明显矛盾（如订单大额维修却结算极低且无合理解释）或疑似伪造票据时，再从严。

审核原则：
1. 车辆一致性：照片中的车辆必须与订单车辆一致（车牌、品牌、车型、颜色）。若订单有车牌且照片中可见车牌，必须一致；否则判不通过，防止上传其他车辆照片冒充。
2. 外观判定：若车辆外观完好、无明显损伤，应视为维修已完成。专业维修后外观恢复如新属正常情况，不得以「未见修复痕迹」「无法确认施工效果」等为由不通过。`;

function buildMaterialAuditUserPrompt(order, evidenceDesc) {
  const repairItems = (order.repair_plan?.items || [])
    .map((i) => {
      const part = i.damage_part || i.part || '';
      const type = i.repair_type || i.type || '';
      const pt = i.repair_type === '换' && i.parts_type ? `，承诺配件类型：${i.parts_type}` : '';
      const pr = i.price != null ? `，分项价¥${i.price}` : '';
      const wm = i.warranty_months != null ? `，项目质保${i.warranty_months}月` : '';
      return `- ${part}：${type}${pt}${pr}${wm}`;
    })
    .join('\n');
  const quotedAmount = order.quoted_amount != null ? Number(order.quoted_amount) : null;
  const expectedAmount = order.expected_amount != null ? Number(order.expected_amount) : null;
  const vi = order.vehicle_info || {};
  const plate = (vi.plate_number || vi.plateNumber || '').trim();
  const brand = (vi.brand || '').trim();
  const model = (vi.model || '').trim();
  const color = (vi.color || '').trim();
  const vehicleDesc = [plate && `车牌 ${plate}`, brand && `品牌 ${brand}`, model && `车型 ${model}`, color && `颜色 ${color}`].filter(Boolean).join('；') || '（无）';
  return `## 订单信息
- 报价金额：${quotedAmount != null ? `¥${quotedAmount}` : '未知'}
- 系统结算金额（核验用）：${expectedAmount != null ? `¥${expectedAmount}` : '未知'}
- 本单车辆：${vehicleDesc}
- 维修项目：
${repairItems || '（无明细）'}

## 上传材料说明
${evidenceDesc}

## 审核要求
1. **结算单**：
   - 必须判断是否为维修/定损结算单，是否含商户名或公章；
   - 必须尽力从结算单中识别“最终应付金额”（元），写入 details.settlementCheck.extracted_amount；
   - extracted_amount 与「系统结算金额」应一致；若不一致或无法识别金额，请将 settlementCheck.valid=false 并在 note 说明原因（将转人工核验）。
2. **车辆一致性**：修复后照片中的车辆必须与本单车辆一致。
   - 若订单有车牌号：照片中车牌需与订单一致，否则不通过（防止上传其他车辆照片）。
   - 若照片中车牌不可见：可结合品牌、车型、颜色等综合判断是否为同一辆车；若明显不符则不通过。
3. **施工图（修复后照片）**：
   - 通过：车辆一致 + 照片覆盖维修项目涉及部位 + 车辆外观正常、无明显损伤。
   - 不通过：车辆不一致；或车辆仍有明显损伤（凹陷、破损、未喷漆等）；或照片与订单车型/部位明显不符。
   - 重要：若车辆外观完好、无明显损伤，应视为维修已完成，不得以「未见修复痕迹」「无法确认施工效果」等为由不通过。专业维修后外观恢复如新属正常情况。
4. **物料照片**：是否展示配件/材料，与维修项目是否相关；若订单含「换」类项目，物料/包装/标识图应能辅助核对**配件类型承诺**（原厂件/同质品牌件/普通副厂件/再制造件/回用拆车件）。不要求单次照片覆盖全部法定证明，但应能体现与承诺等级相符的线索（如品牌 LOGO、再制造字样、合格证、溯源或票据类信息等之一或多项）。若明显无任何可核对线索且订单含多项「换」，可将 materialCheck 标为 valid=false 并说明缺什么。

## 返回格式（严格 JSON，不要输出其他内容）
{
  "pass": true 或 false,
  "rejectReason": "不通过时给服务商的提示，通过时为 null。若有多个不通过项，必须一次性列出所有原因，格式如：1. 定损单/结算单：xxx；2. 车辆照片：xxx；3. 物料照片：xxx",
  "details": {
    "settlementCheck": { "valid": true/false, "extracted_amount": 数字或 null, "note": "定损单/结算单不通过时的具体原因。若可识别最终结算金额，请写入 extracted_amount（元），无法识别则为 null" },
    "vehicleMatchCheck": { "matches": true/false, "plateVisible": true/false, "note": "车辆一致性不通过时的具体原因" },
    "constructionCheck": { "matchesProject": true/false, "vehicleAppearanceNormal": true/false, "note": "修复后照片不通过时的具体原因" },
    "materialCheck": { "valid": true/false, "note": "物料照片不通过时的具体原因" }
  }
}

重要：不通过时 rejectReason 必须涵盖 details 中所有 valid=false 或 matches=false 的项，一次性输出全部失败原因。
请直接输出 JSON，不要输出其他文字。`;
}

/**
 * 材料审核（维修完成凭证 AI 审核）
 * @param {Object} params - { order, evidence, baseUrl, apiKey }
 * @param {Object} params.order - { repair_plan, quoted_amount }
 * @param {Object} params.evidence - { repair_photos, settlement_photos, material_photos } 数组，元素为 URL 或路径
 * @param {string} params.baseUrl - 用于将相对路径转为绝对 URL
 * @param {string} params.apiKey - 千问 API Key
 * @returns {Promise<{pass: boolean, rejectReason?: string, details?: Object}>}
 */
async function analyzeCompletionEvidenceWithQwen({ order, evidence, baseUrl, apiKey }) {
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('未配置千问 API Key');
  }
  const toAbs = (u) => {
    const s = String(u || '').trim();
    if (!s) return null;
    if (s.startsWith('http')) return s;
    const base = (baseUrl || '').replace(/\/$/, '');
    return base + (s.startsWith('/') ? s : '/' + s);
  };
  const arr = (v) => (Array.isArray(v) ? v : []);
  const allUrls = [
    ...arr(evidence?.repair_photos).map(toAbs).filter(Boolean),
    ...arr(evidence?.settlement_photos).map(toAbs).filter(Boolean),
    ...arr(evidence?.material_photos).map(toAbs).filter(Boolean)
  ];
  const unique = [...new Set(allUrls)];
  if (unique.length === 0) {
    return { pass: true, rejectReason: null, details: { skipped_no_images: true } };
  }

  const content = [];
  const maxImages = 8;
  for (let i = 0; i < Math.min(unique.length, maxImages); i++) {
    content.push({ type: 'image_url', image_url: { url: unique[i] } });
  }
  const evidenceDesc = [
    `修复后照片：${arr(evidence?.repair_photos).length} 张`,
    `结算单：${arr(evidence?.settlement_photos).length} 张`,
    `物料照片：${arr(evidence?.material_photos).length} 张`
  ].join('；');
  content.push({ type: 'text', text: buildMaterialAuditUserPrompt(order, evidenceDesc) });

  const raw = await callQwenVision(content, apiKey, MATERIAL_AUDIT_SYSTEM_PROMPT);
  return mapMaterialAuditResponse(raw);
}

function mapMaterialAuditResponse(raw) {
  let parsed = {};
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (_) {}
  const pass = parsed.pass === true;
  const details = parsed.details || {};
  // 兼容：将 extracted_amount 规范为 number|null
  try {
    const sc = details && typeof details === 'object' ? details.settlementCheck : null;
    if (sc && typeof sc === 'object' && sc.extracted_amount != null && sc.extracted_amount !== '') {
      const n = Number(sc.extracted_amount);
      if (Number.isFinite(n)) sc.extracted_amount = n;
      else sc.extracted_amount = null;
    }
  } catch (_) {}
  let rejectReason = null;
  if (!pass) {
    // 从不通过的 details 中汇总所有失败原因，一次性输出
    const reasons = [];
    const labels = {
      settlementCheck: '定损单/结算单',
      vehicleMatchCheck: '车辆照片',
      constructionCheck: '修复后照片',
      materialCheck: '物料照片'
    };
    for (const [key, label] of Object.entries(labels)) {
      const d = details[key];
      if (!d || typeof d !== 'object') continue;
      const failed = key === 'vehicleMatchCheck' ? d.matches === false
        : key === 'constructionCheck' ? (d.matchesProject === false || d.vehicleAppearanceNormal === false)
        : d.valid === false;
      if (failed && d.note && String(d.note).trim()) {
        const note = String(d.note).trim().replace(/[。；]+$/, '');
        if (note) reasons.push(`${label}：${note}`);
      }
    }
    const combined = reasons.length > 0 ? reasons.join('；') : null;
    rejectReason = (combined || String(parsed.rejectReason || '').trim() || '材料未通过 AI 审核');
  }
  return {
    pass,
    rejectReason: pass ? null : rejectReason,
    details
  };
}

// ========== 商户申诉材料 AI 初审 ==========

const APPEAL_AUDIT_SYSTEM_PROMPT = `你是汽修行业的资深专家，拥有二十年以上的经验。你将专门审核商户申诉材料。车主在评价中对某题选「否」，商户提交材料申诉。请根据题目含义，判断商户上传的材料是否有效证明其合规。`;

function buildAppealAuditUserPrompt(questionKey, questionLabel) {
  const requirements = {
    q1_progress_synced: '材料需能证明维修进度与车主同步（如系统通知截图、微信/短信记录、通话记录、车主签字确认单等）',
    q2_parts_shown: '材料需能证明已向车主展示新旧配件（如配件实拍图/视频、车主签字确认单、车间监控片段等）',
    q3_fault_resolved: '材料需能证明车辆故障已解决（如竣工检验单、检测报告、试车记录等），或能证明用户反馈不实'
  };
  const req = requirements[questionKey] || '材料需与题目相关且能证明商户合规';
  return `## 题目
${questionLabel || questionKey}

## 审核要求
${req}

## 返回格式（严格 JSON，不要输出其他内容）
{
  "pass": true 或 false,
  "rejectReason": "不通过时简要说明，通过时为 null",
  "needHumanReview": true 或 false,
  "note": "审核说明"
}

- needHumanReview：当材料模糊、难以判断、或涉及复杂争议时设为 true，转人工复核
- 能明确判断通过/不通过时，needHumanReview 为 false

请直接输出 JSON，不要输出其他文字。`;
}

/**
 * 商户申诉材料 AI 初审
 * @param {Object} params - { questionKey, questionLabel, evidenceUrls, baseUrl, apiKey }
 */
async function analyzeAppealEvidenceWithQwen({ questionKey, questionLabel, evidenceUrls, baseUrl, apiKey }) {
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('未配置千问 API Key');
  }
  const toAbs = (u) => {
    const s = String(u || '').trim();
    if (!s) return null;
    if (s.startsWith('http')) return s;
    const base = (baseUrl || '').replace(/\/$/, '');
    return base + (s.startsWith('/') ? s : '/' + s);
  };
  const urls = (Array.isArray(evidenceUrls) ? evidenceUrls : []).map(toAbs).filter(Boolean);
  const unique = [...new Set(urls)];
  if (unique.length === 0) {
    return { pass: false, rejectReason: '未提供有效图片', note: '' };
  }

  const content = [];
  const maxImages = 8;
  for (let i = 0; i < Math.min(unique.length, maxImages); i++) {
    content.push({ type: 'image_url', image_url: { url: unique[i] } });
  }
  content.push({ type: 'text', text: buildAppealAuditUserPrompt(questionKey, questionLabel) });

  const raw = await callQwenVision(content, apiKey, APPEAL_AUDIT_SYSTEM_PROMPT);
  let parsed = {};
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch (_) {}
  const pass = parsed.pass === true;
  const needHumanReview = parsed.needHumanReview === true;
  const rejectReason = pass ? null : (String(parsed.rejectReason || '').trim() || '申诉材料未通过 AI 初审');
  return { pass, rejectReason, needHumanReview, note: parsed.note || '' };
}

// ========== 服务商商品（标品）智能审核 ==========

const SHOP_PRODUCT_AUDIT_SYSTEM_PROMPT = `你是汽车维修/服务电商平台的商品审核员。根据商家填写的标题、分类、描述以及商品配图（若有），判断是否允许自动上架。

## 必须通过的条件（同时满足）
1. **合法合规**：无违法违规、色情、赌博、诈骗、政治敏感、人身攻击等内容；无「包过」「内部关系」等明显虚假宣传。
2. **汽车服务领域**：商品必须是面向汽车（含新能源车）的维修、保养、洗美、装潢、轮胎、钣金喷漆、机修、电路、事故车相关服务或套餐。禁止：纯食品、数码 unrelated、房产、招聘、金融理财等与到店汽车服务无关的商品。
3. **图文一致**：若上传了图片，图片应大致与汽车服务相关（车间、车辆、配件、工具、施工场景、服务环境等）。若图片明显为无关内容（如风景、人物自拍、其他商品广告），则不通过。若**未上传图片**，仅根据文字判断，文字合规且在汽车服务域内即可通过。
4. **与所选分类一致**：商家选择的平台分类为「钣金喷漆、发动机维修、电路维修、保养服务」之一，标题/描述应与该分类相符或合理相关（如保养类可含小保养、机油机滤等）。

## 输出
仅输出一个 JSON 对象，不要其他文字：
{"pass":true} 或 {"pass":false,"reason":"简短中文原因，供运营参考"}`;

function buildShopProductAuditUserPrompt(name, category, description) {
  const n = String(name || '').trim().slice(0, 200);
  const c = String(category || '').trim();
  const d = String(description || '').trim().slice(0, 2000);
  return `## 商家提交的商品信息
- 标题：${n}
- 平台分类：${c}
- 描述：${d || '（无）'}

请按系统规则判断是否自动通过（pass=true）或转人工（pass=false 并写 reason）。`;
}

/**
 * 服务商商品智能审核（千问视觉，图片为可选）
 * @returns {Promise<{pass: boolean, reason?: string}>}
 */
async function auditShopProductWithQwen({ name, category, description, imageUrls, apiKey }) {
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('未配置千问 API Key');
  }
  const content = [];
  const urls = Array.isArray(imageUrls) ? imageUrls : [];
  const maxImages = 4;
  let added = 0;
  for (const u of urls) {
    if (added >= maxImages) break;
    const url = String(u || '').trim();
    if (!url.startsWith('http')) continue;
    content.push({ type: 'image_url', image_url: { url } });
    added++;
  }
  content.push({ type: 'text', text: buildShopProductAuditUserPrompt(name, category, description) });
  const raw = await callQwenVision(content, apiKey, SHOP_PRODUCT_AUDIT_SYSTEM_PROMPT);
  let parsed = {};
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch (_) {}
  const pass = parsed.pass === true;
  const reason = String(parsed.reason || parsed.rejectReason || '').trim() || '未通过自动审核';
  return { pass, reason: pass ? undefined : reason };
}

/**
 * CSV 已解析后的行 → 与平台模板对齐（配件五类、分项价、项目质保），并列出缺失项
 * @param {object[]} items
 * @param {number} [amountSum]
 */
async function enrichQuoteItemsWithQwen(items, amountSum, apiKey) {
  const sys = `你是汽车维修报价数据规范化助手。平台每条维修项目字段必须为：
- damage_part 损失部位
- repair_type 仅「换」或「修」
- parts_type：repair_type 为「换」时必须是以下之一：${CANONICAL_PARTS_TYPES.join('、')}；为「修」时必须为 null
- price 分项金额（元，数字）
- warranty_months 该项目质保月数（非负整数）

将用户输入的 JSON 规范化：同义配件类型映射到上述五类；无法映射时在 missing_fields 说明哪一行需要人工改。
不要编造不存在的项目。输出仅一个 JSON 对象。`;
  const user = `amount_sum（CSV 分项合计，仅供参考）: ${amountSum != null ? amountSum : 'null'}
items（输入）:
${JSON.stringify(items).slice(0, 12000)}

请输出：
{"items":[...],"missing_fields":[],"warnings":[]}`;
  const raw = await callQwenText(sys, user, apiKey);
  let parsed = {};
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch (_) {}
  const outItems = [];
  const arr = Array.isArray(parsed.items) ? parsed.items : [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const part = String(it.damage_part || it.name || it.item || '').trim();
    if (!part) continue;
    let rt = String(it.repair_type || '修').trim();
    if (rt !== '换' && rt !== '修') rt = /换|更/.test(rt) ? '换' : '修';
    let pt = it.parts_type != null && String(it.parts_type).trim() ? normalizePartsType(it.parts_type) : null;
    if (rt === '修') pt = null;
    else if (rt === '换' && !pt) pt = normalizePartsType(it.parts_type) || null;
    const row = {
      damage_part: part,
      repair_type: rt,
      parts_type: pt,
    };
    if (it.price != null && !Number.isNaN(parseFloat(it.price))) row.price = parseFloat(it.price);
    if (it.warranty_months != null && !Number.isNaN(parseInt(it.warranty_months, 10))) {
      row.warranty_months = parseInt(it.warranty_months, 10);
    }
    outItems.push(row);
  }
  const missing = Array.isArray(parsed.missing_fields) ? parsed.missing_fields.map(String) : [];
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [];
  return { items: outItems.length ? outItems : items, missing_fields: missing, warnings };
}

/**
 * 维修报价单/手写报价表 拍照识别 → 结构化项目（与小程序 / CSV 模板对齐）
 * @param {string} imgUrl
 * @param {string} apiKey
 * @returns {Promise<{ items: object[], amount?: number, duration?: number, warranty?: number, missing_fields: string[], recognition_failed: boolean }>}
 */
async function analyzeRepairQuoteSheetWithQwen(imgUrl, apiKey) {
  const url = String(imgUrl || '').trim();
  if (!url.startsWith('http')) {
    throw new Error('请提供有效的报价单图片 URL');
  }
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('未配置千问 API Key');
  }

  const content = [
    { type: 'image_url', image_url: { url } },
    {
      type: 'text',
      text: `你是汽车维修报价录入助手。识别图片中的维修报价明细（可为机打单、手写单、Excel 截图）。

请严格输出一个 JSON 对象，不要其它文字：
{
  "recognition_failed": false,
  "items": [
    {
      "damage_part": "损失部位名称",
      "repair_type": "换" 或 "修",
      "parts_type": "换时必填，只能是：${CANONICAL_PARTS_TYPES.join('、')} 之一；修时为 null",
      "price": 数字（该项分项金额，元）,
      "warranty_months": 整数（该项质保月数）
    }
  ],
  "amount": 总价数字或省略（可与分项之和互相校验）,
  "duration": 工期天数或省略,
  "missing_fields": ["无法从图中识别的必填项：须逐条写明，如「第2行分项价」「第1行项目质保月数」「换件项目的配件类型」等"]
}

规则：
- 每一项都必须尽量给出 price 与 warranty_months；图中没有则写入 missing_fields，不要猜价格。
- repair_type 只能是「换」或「修」；钣金/喷漆等归为「修」。
- 配件类型禁止使用「原厂配件」等旧称，应输出五类规范名之一。
- 若完全无法辨认为报价单，设 recognition_failed 为 true，items 为空数组。`,
    },
  ];

  const raw = await callQwenVision(content, apiKey);
  let parsed = {};
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch (_) {}

  const failed = parsed.recognition_failed === true || parsed.recognition_failed === 'true';
  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  const items = [];
  for (const it of rawItems) {
    if (!it || typeof it !== 'object') continue;
    const part = String(it.damage_part || it.name || it.item || '').trim();
    if (!part) continue;
    let rt = String(it.repair_type || it.type || '修').trim();
    if (rt !== '换' && rt !== '修') rt = /换|更/.test(rt) ? '换' : '修';
    let pt = it.parts_type != null && String(it.parts_type).trim() ? normalizePartsType(it.parts_type) : null;
    if (rt === '修') pt = null;
    else if (rt === '换' && !pt) pt = '原厂件';
    const row = {
      damage_part: part,
      repair_type: rt,
      parts_type: pt,
    };
    if (it.price != null && !Number.isNaN(parseFloat(it.price))) row.price = parseFloat(it.price);
    if (it.warranty_months != null && !Number.isNaN(parseInt(it.warranty_months, 10))) {
      row.warranty_months = parseInt(it.warranty_months, 10);
    }
    items.push(row);
  }

  const missing = Array.isArray(parsed.missing_fields) ? parsed.missing_fields.map(String) : [];
  for (let i = 0; i < items.length; i++) {
    const row = items[i];
    if (row.price == null || Number.isNaN(row.price)) {
      missing.push(`「${row.damage_part}」分项金额（元）需在小程序中补填`);
    }
    if (row.warranty_months == null || Number.isNaN(row.warranty_months)) {
      missing.push(`「${row.damage_part}」项目质保（月）需在小程序中补填`);
    }
    if (row.repair_type === '换' && (!row.parts_type || !CANONICAL_PARTS_TYPES.includes(row.parts_type))) {
      missing.push(`「${row.damage_part}」为换件，配件类型需选五类之一`);
    }
  }
  if (failed || items.length === 0) {
    return {
      items: [],
      missing_fields: missing.length ? missing : ['无法从图片识别有效项目'],
      recognition_failed: true,
    };
  }

  return {
    items,
    amount: parsed.amount != null ? parseFloat(parsed.amount) : undefined,
    duration: parsed.duration != null ? parseInt(parsed.duration, 10) : undefined,
    missing_fields: missing,
    recognition_failed: false,
  };
}

/**
 * 维修前后外观对比：输出修复完成度百分比（供评价公示），不作合规/责任结论
 * @param {{ beforeUrls: string[], afterUrls: string[], apiKey: string }} opts
 * @returns {Promise<{ status: string, repair_degree_percent: number|null, note?: string, confidence?: string, model?: string }>}
 */
async function analyzeExteriorRepairDegreeWithQwen(opts) {
  const apiKey = opts.apiKey;
  const before = (opts.beforeUrls || []).map(trimVisionImageUrl).filter(Boolean).slice(0, 3);
  const after = (opts.afterUrls || []).map(trimVisionImageUrl).filter(Boolean).slice(0, 3);
  if (!apiKey || !String(apiKey).trim()) {
    return { status: 'skipped', repair_degree_percent: null, note: '未配置视觉模型' };
  }
  if (!before.length || !after.length) {
    return { status: 'skipped', repair_degree_percent: null, note: '缺少维修前或维修后可对比的外观照片' };
  }
  const systemPrompt = `你是汽车外观钣金喷漆修复评估助手。用户会提供维修前与维修后的车身外观照片（可能为多张）。
请仅根据可见外观（凹痕、裂缝、漆面、保险杠等）对比，估计「外观修复完成度」repair_degree_percent：0-100 的整数（100 表示可见范围内损伤已妥善处理、无明显未修复瑕疵）。
若照片不清晰、无法对应同一部位、或主要为内饰/发动机舱等非外观，将 repair_degree_percent 设为 null。
只输出一个 JSON 对象，不要其它文字：{"repair_degree_percent":整数或null,"note":"30字内中性说明","confidence":"high"|"medium"|"low"}
禁止输出「合规」「违规」「责任」等结论，不推荐或批评维修厂。`;

  const content = [
    {
      type: 'text',
      text: '以下先列为「维修前」外观图，后列为「维修后」外观图。请输出 JSON。',
    },
  ];
  for (const u of before) {
    content.push({ type: 'image_url', image_url: { url: u } });
  }
  for (const u of after) {
    content.push({ type: 'image_url', image_url: { url: u } });
  }

  try {
    const raw = await callQwenVision(content, apiKey, systemPrompt);
    let parsed = {};
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    let pct = parsed.repair_degree_percent;
    if (pct != null) {
      pct = parseInt(pct, 10);
      if (Number.isNaN(pct)) pct = null;
      else pct = Math.max(0, Math.min(100, pct));
    } else {
      pct = null;
    }
    return {
      status: pct != null ? 'ok' : 'uncertain',
      repair_degree_percent: pct,
      note: typeof parsed.note === 'string' ? parsed.note.slice(0, 80) : '',
      confidence: parsed.confidence || 'medium',
      model: QWEN_MODEL,
      analyzed_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[analyzeExteriorRepairDegreeWithQwen]', err.message);
    return {
      status: 'failed',
      repair_degree_percent: null,
      note: '外观对比分析暂不可用，请结合实拍自行判断',
      confidence: 'low',
    };
  }
}

/**
 * 维修方案分项 vs 店端配件/物料照片：一致性归纳（非司法鉴定、非合规裁决）
 * @param {{ repairItems: object[], imageUrls: string[], apiKey: string }} opts
 * @returns {Promise<{ status: string, match_level: string|null, user_conclusion: string, mismatch_reasons: string[], analysis_process: string, model?: string, analyzed_at?: string }>}
 */
async function analyzePartsTraceabilityWithQwen(opts) {
  const apiKey = opts.apiKey;
  const items = Array.isArray(opts.repairItems) ? opts.repairItems : [];
  const urls = (opts.imageUrls || [])
    .map(trimVisionImageUrl)
    .filter(Boolean)
    .slice(0, MAX_VL_IMAGES_PER_REQUEST);

  if (!apiKey || !String(apiKey).trim()) {
    return {
      status: 'skipped',
      match_level: null,
      user_conclusion: '',
      mismatch_reasons: [],
      analysis_process: '未调用模型：未配置 API Key',
    };
  }
  if (!urls.length) {
    return {
      status: 'skipped',
      match_level: null,
      user_conclusion: '无配件/物料照片，未执行比对',
      mismatch_reasons: [],
      analysis_process: '',
    };
  }
  if (!items.length) {
    return {
      status: 'skipped',
      match_level: null,
      user_conclusion: '方案无分项明细，未执行比对',
      mismatch_reasons: [],
      analysis_process: '',
    };
  }

  const systemPrompt = `你是汽车维修「配件留档与维修方案一致性」评估助手，只做可见线索与方案文字的交叉归纳，**不下合规/造假/责任认定**。

## 图像与分项的对应关系（极其重要）
- 与事故定损里「多车、多部位」类似：**不要**机械规定「一张照片只能对应一个维修项」。
- **允许**同一张照片中同时出现多种配件、包装、标签或局部合影；也**允许**多个维修项的证据分散在多张照片中，只要整体上能建立合理对应即可。
- 「换」类项目：照片中可出现新件包装、旧件、标签、品牌 LOGO、再制造字样等任一可核对线索，即视为该项有可视依据（不要求单独一张图只拍该项）。
- 「修」类项目：可见修复部位或完工外观与方案部位不矛盾即可记为可对上。
- 若因远景、反光、遮挡导致**看不清**，记为「无法确认」，**不等于**不匹配；只有发现**明确矛盾**或**多项换件完全无任何可视线索且无法被合影解释**时，才可判 mismatch。

## 匹配度三档（输出 match_level 必须三选一）
- **full_match**：各分项在全部照片中能找到合理对应线索，未见明显矛盾。
- **basic_match**：多数分项可对上；少数因合影/角度/清晰度无法逐项确认，但**未见明确矛盾**；或照片偏少但已覆盖主要换件线索。
- **mismatch**：存在**明确矛盾**（例如方案要求更换某外观件，而全部照片中无任何可与该项关联的配件/包装线索且无法推断为其他图涵盖），或**多项「换」**完全无可见依据。

## 输出格式
只输出 **一个 JSON 对象**，不要 markdown，不要其它文字。字段：
- match_level: 字符串，仅允许 "full_match" | "basic_match" | "mismatch"
- user_conclusion: 字符串，**18 字以内**，给车主看的一句话（中性表述）
- mismatch_reasons: 字符串数组；**仅当 match_level 为 mismatch 时**填 1～6 条简短原因；其它情况必须为 []
- analysis_process: 字符串，**完整推理过程**（可较长、可分点），供平台入库，车主端不展示全文

禁止输出「违法」「欺诈」「假件」等定性用语；可用「未见与某某项对应线索」「与某某项存在明显不一致」等中性表述。`;

  const itemLines = items
    .map((it, i) => {
      const name = String(it.damage_part || it.name || it.part || `项目${i + 1}`).trim();
      const rt = String(it.repair_type || it.type || '').trim();
      const pt = it.parts_type ? `；承诺配件类型：${String(it.parts_type).trim()}` : '';
      return `${i + 1}. ${name}；${rt || '—'}${pt}`;
    })
    .join('\n');

  const content = [
    {
      type: 'text',
      text: `以下为锁定后的维修方案分项（以文字为准）：\n${itemLines}\n\n随后共 ${urls.length} 张图为门店上传的配件/物料/包装类照片。请按 system 说明输出 JSON。`,
    },
  ];
  for (const u of urls) {
    content.push({ type: 'image_url', image_url: { url: u } });
  }

  try {
    const raw = await callQwenVision(content, apiKey, systemPrompt);
    let parsed = {};
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    let level = String(parsed.match_level || '').trim().toLowerCase();
    if (!['full_match', 'basic_match', 'mismatch'].includes(level)) {
      if (/完全|full|高/.test(level)) level = 'full_match';
      else if (/不匹配|mismatch|矛盾|低/.test(level)) level = 'mismatch';
      else level = 'basic_match';
    }
    const userConclusion =
      typeof parsed.user_conclusion === 'string' ? parsed.user_conclusion.trim().slice(0, 40) : '';
    let reasons = Array.isArray(parsed.mismatch_reasons)
      ? parsed.mismatch_reasons.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
      : [];
    if (level !== 'mismatch') reasons = [];
    const analysisProcess =
      typeof parsed.analysis_process === 'string' ? parsed.analysis_process.trim().slice(0, 12000) : '';
    return {
      status: 'ok',
      match_level: level,
      user_conclusion: userConclusion || (level === 'full_match' ? '分项与留档照片整体一致' : level === 'mismatch' ? '存在未对上项' : '多数可对上，部分待确认'),
      mismatch_reasons: reasons,
      analysis_process: analysisProcess,
      /** 模型原始输出摘录，便于运营核对（非车主端展示） */
      raw_model_excerpt: String(raw || '').slice(0, 4000),
      model: QWEN_MODEL,
      analyzed_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[analyzePartsTraceabilityWithQwen]', err.message);
    return {
      status: 'failed',
      match_level: null,
      user_conclusion: '',
      mismatch_reasons: [],
      analysis_process: String(err.message || 'vision_error').slice(0, 500),
      raw_model_excerpt: '',
    };
  }
}

module.exports = {
  callQwenText,
  analyzeWithQwen,
  analyzeLicenseWithQwen,
  analyzeVocationalCertificateWithQwen,
  analyzeQualificationCertificateWithQwen,
  analyzeReviewWithQwen,
  analyzeReviewEvidenceContradictionWithQwen,
  analyzeCompletionEvidenceWithQwen,
  analyzeAppealEvidenceWithQwen,
  auditShopProductWithQwen,
  analyzeRepairQuoteSheetWithQwen,
  enrichQuoteItemsWithQwen,
  analyzeExteriorRepairDegreeWithQwen,
  analyzePartsTraceabilityWithQwen,
};
