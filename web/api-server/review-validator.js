/**
 * 评价有效性校验（分阶管控）
 * 按《全指标底层逻辑梳理》2.2 实现
 * 支付凭证：L1-L2 不要求；L3-L4 非必传，仅作优质加分项
 * 必传图片：L1-L2 需 1-2 张；L3-L4 需 2 张核心图；差评需问题实拍图，无需沟通记录
 */

const WATER_WORDS = ['好', '不错', '划算', '可以', '满意', '很好', '还行'];
const MIN_CONTENT_LEN_L1L2 = 5;
const MIN_CONTENT_LEN_L3L4 = 15;

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
 * 校验必传图片（有效评价门槛）
 * @param {string} complexityLevel - L1/L2/L3/L4
 * @param {boolean} isNegative - 是否差评（rating<=2 或负面内容）
 * @param {object} images - { completion_images, after_images, settlement_list_image }
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateRequiredImages(complexityLevel, isNegative, images) {
  const level = (complexityLevel || 'L2').toUpperCase();
  const isL1L2 = level === 'L1' || level === 'L2';
  const completionCount = parseImageCount(images?.completion_images);
  const afterCount = parseImageCount(images?.after_images);
  const hasSettlement = !!(images?.settlement_list_image && String(images.settlement_list_image).trim());

  if (isNegative) {
    // 差评：L1-L2 需 1 张及以上问题实拍图；L3-L4 需问题实拍图 + 维修明细单
    if (isL1L2) {
      if (afterCount < 1 && completionCount < 1) {
        return { valid: false, reason: '差评需上传至少 1 张问题实拍图' };
      }
    } else {
      if (afterCount < 1 && completionCount < 1) {
        return { valid: false, reason: '差评需上传问题实拍图' };
      }
      if (!hasSettlement && completionCount < 2) {
        return { valid: false, reason: 'L3-L4 差评需上传问题实拍图及维修明细单' };
      }
    }
    return { valid: true };
  }

  // 好评：L1-L2 需 1-2 张（新旧配件对比 or 施工结果图）
  if (isL1L2) {
    if (completionCount < 1 && afterCount < 1) {
      return { valid: false, reason: '请上传至少 1 张施工图或新旧配件对比图' };
    }
    return { valid: true };
  }

  // L3-L4 好评：需 2 张核心图（结果图 + 新旧件/明细单/定损单）
  if (completionCount < 2 && !(completionCount >= 1 && hasSettlement)) {
    return { valid: false, reason: 'L3-L4 订单需上传 2 张核心实拍图（维修结果图 + 新旧配件对比图/维修明细单/定损单）' };
  }
  return { valid: true };
}

/**
 * 校验内容有效性（至少 1 句与项目相关描述，非纯水评）
 * @param {string} content - 评价内容
 * @param {string} complexityLevel - L1/L2/L3/L4
 * @param {boolean} isNegative - 是否差评
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateContent(content, complexityLevel, isNegative) {
  const text = String(content || '').trim();
  const level = (complexityLevel || 'L2').toUpperCase();
  const isL1L2 = level === 'L1' || level === 'L2';
  const minLen = isL1L2 ? MIN_CONTENT_LEN_L1L2 : MIN_CONTENT_LEN_L3L4;

  if (text.length < minLen) {
    return { valid: false, reason: isL1L2 ? '请至少写 1 句与维修项目相关的描述' : '请补充项目、价格或服务细节等相关描述' };
  }

  // 纯无意义水评：仅含水词
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
 * 判断是否为优质评价（完成加分项，拿浮动奖励）
 * @param {object} params - { completion_images, after_images, settlement_list_image, content, hasFollowup7d }
 * @param {string} complexityLevel - L1/L2/L3/L4
 * @returns {boolean}
 */
function checkIsPremium(params, complexityLevel) {
  const level = (complexityLevel || 'L2').toUpperCase();
  const isL1L2 = level === 'L1' || level === 'L2';
  const completionCount = parseImageCount(params?.completion_images);
  const hasSettlement = !!(params?.settlement_list_image && String(params.settlement_list_image).trim());
  const content = String(params?.content || '').trim();

  const hasPriceHint = /价格|避坑|对比|明细|花费|费用/.test(content);
  const hasDetail = /过程|细节|步骤|师傅|技师|服务|维修/.test(content) && content.length >= 30;

  if (isL1L2) {
    if (hasSettlement) return true;
    if (completionCount >= 3) return true;
    if (hasPriceHint || hasDetail) return true;
    if (params?.hasFollowup7d) return true;
    return false;
  }

  // L3-L4
  if (completionCount >= 5 || hasSettlement) return true;
  if (hasPriceHint && hasDetail && content.length >= 50) return true;
  if (params?.hasFollowup7d && params?.hasFollowup30d) return true;
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
      hasFollowup7d: params.hasFollowup7d,
      hasFollowup30d: params.hasFollowup30d,
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
