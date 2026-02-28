/**
 * 评价有效性校验（仅车主输入）
 * 按《02-评价内容质量等级体系》：有效评价仅与客观题、主观题相关；材料为服务商义务，不要求车主上传
 */

const WATER_WORDS = ['好', '不错', '划算', '可以', '满意', '很好', '还行'];
const MIN_CONTENT_LEN = 5;

/**
 * 解析图片数量（completion_images 为 JSON 数组或字符串）
 */
function parseImageCount(images) {
  if (!images) return 0;
  try {
    const arr = typeof images === 'string' ? JSON.parse(images || '[]') : images;
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

/**
 * 校验必传图片（已废弃：材料为服务商义务，不再作为有效评价门槛）
 * 保留函数以兼容调用方，始终返回 valid
 */
function validateRequiredImages(complexityLevel, isNegative, images) {
  return { valid: true };
}

/**
 * 校验内容有效性（至少 1 句与项目相关描述，非纯水评）
 * @param {string} content - 评价内容
 * @param {string} complexityLevel - L1/L2/L3/L4（保留参数兼容）
 * @param {boolean} isNegative - 是否差评（保留参数兼容）
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateContent(content, complexityLevel, isNegative) {
  const text = String(content || '').trim();

  if (text.length < MIN_CONTENT_LEN) {
    return { valid: false, reason: '请至少写 1 句与维修项目相关的描述' };
  }

  const onlyWater = WATER_WORDS.some(w => text === w || text === w + '。' || text === w + '！' || text === w + '，');
  if (onlyWater) {
    return { valid: false, reason: '请补充与维修项目相关的具体描述，无意义水评无法领取奖励金' };
  }
  if (text.length < 15 && WATER_WORDS.some(w => text.includes(w)) && text.length < 20) {
    const hasOther = text.replace(new RegExp(WATER_WORDS.join('|'), 'g'), '').trim().length >= 5;
    if (!hasOther) {
      return { valid: false, reason: '请补充与维修项目相关的具体描述' };
    }
  }

  return { valid: true };
}

/**
 * 判断是否为优质评价（仅与内容质量相关，不依赖材料）
 * 注：优质评价由 AI 优先判定（真实性、有效性、参考价值）；此处为规则回退
 * @param {object} params - { content }
 * @param {string} complexityLevel - L1/L2/L3/L4
 * @returns {boolean}
 */
function checkIsPremium(params, complexityLevel) {
  const content = String(params?.content || '').trim();
  const hasPriceHint = /价格|避坑|对比|明细|花费|费用/.test(content);
  const hasDetail = /过程|细节|步骤|师傅|技师|服务|维修/.test(content) && content.length >= 30;
  const hasReference = hasPriceHint || hasDetail;
  if (hasReference && content.length >= 30) return true;
  if (content.length >= 80 && /项目|维修|配件|故障|问题/.test(content)) return true;
  return false;
}

/**
 * 综合校验：有效评价门槛
 * @param {object} params - { complexityLevel, rating, content, completion_images, after_images, settlement_list_image }
 * @returns {{ valid: boolean, premium: boolean, reason?: string }}
 */
function validateReview(params) {
  const rating = parseFloat(params.rating) || 5;
  const isNegative = rating <= 2;

  const imgResult = validateRequiredImages(
    params.complexityLevel,
    isNegative,
    {
      completion_images: params.completion_images,
      after_images: params.after_images,
      settlement_list_image: params.settlement_list_image,
    }
  );
  if (!imgResult.valid) {
    return { valid: false, premium: false, reason: imgResult.reason };
  }

  const contentResult = validateContent(params.content, params.complexityLevel, isNegative);
  if (!contentResult.valid) {
    return { valid: false, premium: false, reason: contentResult.reason };
  }

  const premium = checkIsPremium(
    {
      completion_images: params.completion_images,
      after_images: params.after_images,
      settlement_list_image: params.settlement_list_image,
      content: params.content,
    },
    params.complexityLevel
  );

  return { valid: true, premium };
}

module.exports = {
  validateRequiredImages,
  validateContent,
  checkIsPremium,
  validateReview,
  parseImageCount,
};
