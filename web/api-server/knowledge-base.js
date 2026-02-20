/**
 * 事故车维修知识库（基于《事故车维修AI软件知识库.md》）
 * 来源：JT/T 795-2023、GB16735-2019、GB7258、T/IAC CAMRA 50-2024、机动车维修管理规定
 * 用于：定损分析时匹配事故类别、生成合规维修建议
 *
 * 扩展说明：
 * - 接入真实 AI（如阿里云通义）时，可将本模块规则作为 prompt 上下文注入，
 *   或作为 AI 输出后的校验与补充层
 * - 新增零部件/损伤形式时，在 REPAIR_REPLACE_RULES、PART_ALIAS、DAMAGE_TYPE_ALIAS 中补充
 */

// 零部件别名映射（AI可能返回的名称 -> 知识库标准名称）
const PART_ALIAS = {
  '前保险杠': '保险杠蒙皮',
  '后保险杠': '保险杠蒙皮',
  '保险杠': '保险杠蒙皮',
  '机盖': '前机盖',
  '引擎盖': '前机盖',
  '前盖': '前机盖',
  '翼子板': '前翼子板',
  '前翼子板': '前翼子板',
  '后翼子板': '后翼子板',
  '尾门': '行李箱盖/尾门',
  '后备箱盖': '行李箱盖/尾门',
  '挡风玻璃': '汽车玻璃',
  '前挡': '汽车玻璃',
  '车灯': '灯具',
  '大灯': '灯具',
  '前大灯': '灯具',
  '轮毂': '钢圈',
  '轮圈': '钢圈',
  '车身': '车身结构件',
  'A柱': '车身结构件',
  'B柱': '车身结构件',
  '纵梁': '车身结构件'
};

// 损伤形式别名
const DAMAGE_TYPE_ALIAS = {
  '凹陷': '塑性变形',
  '凹坑': '塑性变形',
  '变形': '塑性变形',
  '皱褶': '褶皱',
  '裂纹': '开裂',
  '裂缝': '开裂',
  '破损': '破损',
  '断裂': '断裂',
  '脱落': '脱落',
  '刮伤': '划伤',
  '刮痕': '刮痕',
  '划痕': '划伤',
  '缺失': '缺失',
  '弯曲': '弯曲变形',
  '折曲': '折曲变形',
  '扭曲': '扭曲变形'
};

/**
 * 零部件修换判别表（T/IAC CAMRA 50-2024、JT/T 795-2023）
 * 结构：{ 零部件: { 材质: { 损伤形式: 判定标准 } } }
 */
const REPAIR_REPLACE_RULES = {
  '保险杠蒙皮': {
    钢质: {
      开裂: '长度≥50mm→更换；否则修复',
      塑性变形: '面积>20%→更换；否则修复'
    },
    热塑塑料: {
      缺失: '非安装部位>10%总面积/安装部位>5cm²→更换',
      开裂: '折弯角度>15°/非安装部位>150mm/安装部位>50mm→更换'
    }
  },
  '前机盖': {
    钢质: { 塑性变形: '面积>40%或加强筋变形→更换；否则修复' },
    铝质: {
      塑性变形: '面积≥50cm²且深度>20mm→更换；否则修复',
      开裂: '平整部位>50mm或伤及加强筋→更换；否则修复'
    }
  },
  '前翼子板': {
    铝质: { 凹陷变形: '深度>10mm→更换；否则修复' },
    钢质: {
      塑性变形: '面积>40%/凹陷>15mm/筋线曲折>20°→更换；否则修复'
    }
  },
  '后翼子板': {
    钢质: {
      塑性变形: '面积>40%/凹陷>15mm/筋线曲折>20°→更换；否则修复'
    }
  },
  '车门': {
    钢质: {
      内部加强筋变形: '长度>150mm→更换；否则修复',
      塑性变形: '面积>40%/凹陷>10mm/玻璃框扭曲→更换；否则修复'
    },
    铝质: { 塑性变形: '面积>25%/凹陷>8mm→更换；否则修复' }
  },
  '车身结构件': {
    钢制: {
      弯曲变形: '修复',
      折曲变形: '更换',
      扭曲变形: '更换'
    },
    铝制: {
      轻微弯曲: '校正',
      其他损伤: '更换'
    }
  },
  '安全气囊': { _: { '事故中触发': '必须更换（含关联安全部件按技术信息修复）' } },
  '安全带': { _: { 功能失效: '必须更换' } },
  '汽车玻璃': {
    夹层玻璃: {
      长裂缝: '主视区/边缘区域+长度>50mm→更换；否则修复',
      牛眼状破损: '主视区/边缘+冲击点>5mm+损伤>30mm→更换；否则修复'
    }
  },
  '钢圈': {
    铝质: {
      开裂: '长度≥30mm→更换；否则修复',
      划伤: '面积≥30%且漆层破坏>5mm→更换；否则修复'
    }
  },
  '动力蓄电池箱体': {
    铸铝合金: { '变形/破裂': '箱体破裂/挤压变形导致气密性破坏→更换' }
  },
  '电子控制单元': { _: { '撞击变形/烧蚀': '功能失效→更换，重新装配后需初始化' } },
  '灯具': {
    _: {
      开裂: '灯脚断裂>3个/固定孔开裂>2个/灯罩开裂→更换；否则修复',
      划伤: '表面深度>0.5mm/边缘>1mm/面积≥20%→更换；否则修复'
    }
  },
  '散热器框架': {
    金属: { 塑性变形: '面积>20%→更换；否则修复' },
    非金属: { 塑性变形: '面积≥50cm²且深度≥10mm→更换；否则修复' }
  }
};

/**
 * 损伤等级判定（JT/T 795-2023 附录B）
 * 一级：车身/发动机/动力蓄电池任一损坏；或 变速器+驱动电机+驱动桥+非驱动桥+制动+转向 ≥3
 * 二级：变速器+驱动电机+驱动桥+非驱动桥+制动+转向 ≥1
 * 三级：无总成损坏
 */
const DAMAGE_LEVEL_总成清单 = {
  一级: ['车身总成', '发动机总成', '动力蓄电池总成'],
  二级: ['变速器总成', '驱动电机总成', '驱动桥总成', '非驱动桥总成', '制动系统', '转向系统']
};

/**
 * 质保期规则（JT/T 795-2023）
 */
const WARRANTY_RULES = {
  一级: '20000km或100日，全项竣工检验，需签发竣工合格证',
  二级: '20000km或100日，针对性竣工检验，需签发竣工合格证',
  三级: '2000km或10日（漆面除外），局部检验',
  无伤: '经照片分析未发现明显损伤，建议实车查勘确认'
};

/**
 * 根据零部件、材质、损伤形式检索修换规则
 * @param {string} part - 零部件名称
 * @param {string} material - 材质（可选，默认钢质）
 * @param {string} damageForm - 损伤形式
 * @returns {string|null} 修换判定标准
 */
function getRepairRule(part, material = '钢质', damageForm) {
  const stdPart = PART_ALIAS[part] || part;
  const stdDamage = DAMAGE_TYPE_ALIAS[damageForm] || damageForm;

  const rules = REPAIR_REPLACE_RULES[stdPart];
  if (!rules) return null;

  const materialRules = rules[material] || rules['钢质'] || rules['钢制'] || rules['_'];
  if (!materialRules) return null;

  return materialRules[stdDamage] || materialRules[damageForm] || Object.values(materialRules)[0];
}

/**
 * 判断损伤项是否为「无伤」占位（如 AI 无损伤时返回的占位数据）
 */
function isNoDamagePlaceholder(d) {
  const part = (d.part || '').trim();
  const type = (d.type || '').trim();
  const noDamagePartValues = ['未识别', '无伤', '无损伤', '无事故损伤', '无异常', '未发现损伤', '未见损伤'];
  return (
    !part ||
    noDamagePartValues.some((v) => part === v || part.includes(v)) ||
    (type === '待确认' && (!part || part === '未识别'))
  );
}

/**
 * 根据损伤部位列表推断损伤等级
 * @param {Array<{part:string,type?:string}>} damages - 损伤列表
 * @returns {{level:string, warranty:string}}
 */
function getDamageLevel(damages) {
  if (!damages || damages.length === 0) {
    return { level: '无伤', warranty: WARRANTY_RULES['无伤'] };
  }

  // 若全部为无伤占位，则判定为无伤
  const hasRealDamage = damages.some((d) => !isNoDamagePlaceholder(d));
  if (!hasRealDamage) {
    return { level: '无伤', warranty: WARRANTY_RULES['无伤'] };
  }

  const parts = damages.map((d) => d.part || '').join(' ');
  const level1Keywords = ['车身', '发动机', '动力蓄电池', '电池箱'];
  const level2Keywords = ['变速器', '驱动电机', '驱动桥', '制动', '转向', '悬挂', '减震'];

  for (const kw of level1Keywords) {
    if (parts.includes(kw)) {
      return { level: '一级', warranty: WARRANTY_RULES['一级'] };
    }
  }

  let level2Count = 0;
  for (const kw of level2Keywords) {
    if (parts.includes(kw)) level2Count++;
  }
  if (level2Count >= 3) {
    return { level: '一级', warranty: WARRANTY_RULES['一级'] };
  }
  if (level2Count >= 1) {
    return { level: '二级', warranty: WARRANTY_RULES['二级'] };
  }

  return { level: '三级', warranty: WARRANTY_RULES['三级'] };
}

/**
 * 根据 AI 分析结果补充知识库维修建议
 * @param {Object} analysisResult - AI 返回的损伤分析（damages 数组）
 * @returns {Object} 补充了 rule_based_suggestions 和 damage_level 的结果
 */
function enhanceAnalysisWithKnowledge(analysisResult) {
  const damages = analysisResult.damages || [];
  const repairSuggestions = analysisResult.repair_suggestions || [];
  const repairText = repairSuggestions.map((r) => r.item || '').join(' ');

  // 若维修建议中明确写了「无事故损伤」「未发现明显损伤」，且无真实损伤，则判定为无伤
  const noDamageInRepair = /无事故损伤|未发现明显损伤|无可见损伤|未见.*损伤/.test(repairText);

  const enhancedDamages = damages.map((d) => {
    const part = d.part || '';
    const damageForm = d.type || d.damage_form || '塑性变形';
    const material = d.material || '钢质';
    const rule = getRepairRule(part, material, damageForm);

    return {
      ...d,
      knowledge_rule: rule,
      rule_source: rule ? 'T/IAC CAMRA 50-2024、JT/T 795-2023' : null
    };
  });

  let { level, warranty } = getDamageLevel(damages);
  if (level === '三级' && noDamageInRepair && (!damages.length || damages.every(isNoDamagePlaceholder))) {
    level = '无伤';
    warranty = WARRANTY_RULES['无伤'];
  }

  const ruleBasedSuggestions = [];
  for (const d of enhancedDamages) {
    if (d.knowledge_rule) {
      ruleBasedSuggestions.push({
        item: `${d.part}：${d.knowledge_rule}`,
        source: '国家标准',
        price_range: null
      });
    }
  }

  return {
    ...analysisResult,
    damages: enhancedDamages,
    damage_level: level,
    warranty: warranty,
    rule_based_suggestions: ruleBasedSuggestions,
    repair_suggestions: repairSuggestions.length > 0
      ? repairSuggestions
      : ruleBasedSuggestions.length > 0
        ? ruleBasedSuggestions
        : analysisResult.repair_suggestions || []
  };
}

/**
 * 生成用于注入 AI 提示词的知识库规则摘要（T/IAC CAMRA 50-2024、JT/T 795-2023）
 * @returns {string}
 */
function getKnowledgeBasePromptText() {
  const lines = [
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
  ];
  return lines.join('\n');
}

module.exports = {
  getRepairRule,
  getDamageLevel,
  enhanceAnalysisWithKnowledge,
  getKnowledgeBasePromptText,
  REPAIR_REPLACE_RULES,
  WARRANTY_RULES
};
