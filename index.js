// cloudfunctions/analyzeAccidentPhotos/index.js
// 使用阿里千问 qwen3-vl-plus API 分析事故照片
// 参考官方示例：https://help.aliyun.com/zh/model-studio/developer-reference/api-details-9

const cloud = require('wx-server-sdk');
const OpenAI = require('openai');
const standardsReferenceText = require('./standardsReference.js');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

// OpenAI 兼容模式的 API 配置
const QIANWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const QIANWEN_MODEL = 'qwen3-vl-plus';

/**
 * 主函数：分析事故照片
 */
exports.main = async (event, context) => {
  const { photos, analysisId, orderNo, ownerId, role } = event; 
  // analysisId: 必须由前端传入，云函数不生成
  // orderNo 可选，用于日志记录
  // ownerId: 用户ID（用于调用次数限制）
  // role: 用户角色 'merchant' | 'owner'（用于调用次数限制）

  console.log(`[analyzeAccidentPhotos] 开始分析照片，共 ${photos?.length || 0} 张${orderNo ? `（订单号：${orderNo}）` : ''}${analysisId ? `（分析ID：${analysisId}）` : ''}${role ? `（用户角色：${role}）` : ''}`);

  try {
    if (!photos || photos.length === 0) {
      return {
        success: false,
        message: '照片不能为空',
        apiCalled: false,
        apiStatus: 'skipped'
      };
    }

    // 限制最多 6 张参与分析，以降低接口耗时与超时风险（多图 VL 模型推理较慢）
    const MAX_PHOTOS = 6;
    if (photos.length > MAX_PHOTOS) {
      return {
        success: false,
        message: `参与分析的照片不能超过${MAX_PHOTOS}张，当前为${photos.length}张`,
        apiCalled: false,
        apiStatus: 'skipped'
      };
    }

    // 验证 analysisId（必须由前端传入，云函数不生成）
    if (!analysisId) {
      return {
        success: false,
        message: 'analysisId 不能为空，请在前端生成 analysisId 后再调用',
        apiCalled: false,
        apiStatus: 'skipped'
      };
    }

    // 从环境变量获取 API 密钥
    const QIANWEN_API_KEY = process.env.QIANWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '';

    let apiCalled = false;
    let apiStatus = 'not_configured';
    let apiError = null;

    // 检查 API 密钥
    if (!QIANWEN_API_KEY) {
      console.warn('[analyzeAccidentPhotos] 未配置阿里千问API密钥，使用默认分析结果');
      const defaultResult = getDefaultAnalysis(photos);
      return {
        ...defaultResult,
        apiCalled: false,
        apiStatus: 'not_configured',
        message: '未配置API密钥，使用默认分析结果'
      };
    }

    // 检查用户今日调用次数是否超限（仅在提供了 ownerId 和 role 时检查）
    if (ownerId && role) {
      const limitCheck = await checkDailyLimit(ownerId, role);
      if (!limitCheck.allowed) {
        console.warn(`[analyzeAccidentPhotos] 用户 ${ownerId} (${role}) 调用次数超限: ${limitCheck.message}`);
        return {
          success: false,
          message: limitCheck.message,
          apiCalled: false,
          apiStatus: 'limit_exceeded',
          limitInfo: {
            currentCount: limitCheck.currentCount,
            maxCount: limitCheck.maxCount,
            role: role
          }
        };
      }
      console.log(`[analyzeAccidentPhotos] 用户 ${ownerId} (${role}) 调用次数检查通过: ${limitCheck.message}`);
    }

    console.log('[analyzeAccidentPhotos] 已检测到API密钥，开始调用阿里千问API');
    apiCalled = true;
    apiStatus = 'calling';

    // 构建分析提示词（包含全局判断和多图联动要求）
    const prompt = buildAnalysisPrompt();

    console.log(`[analyzeAccidentPhotos] 开始一次性分析所有 ${photos.length} 张照片（多图联动）`);
    
    let analysisResult = null;
    try {
      analysisResult = await analyzeMultipleImagesWithQianwen(photos, prompt, QIANWEN_API_KEY);
      console.log(`[analyzeAccidentPhotos] 所有照片综合分析成功`);
      apiStatus = 'success';

      console.log('多图片分析结果', analysisResult);
      
      // 检查是否有有效的分析结果
      const isValid = analysisResult && 
        analysisResult.isCompliant !== false && 
        analysisResult.isVehicleRelated === true;
      
      // analysisId 已在前面验证过，直接使用传入的 analysisId
      console.log(`[analyzeAccidentPhotos] 使用传入的分析ID: ${analysisId}`);
      
      // 记录调用次数（异步，不等待）
      if (ownerId && role) {
        recordCallCount(ownerId, role, analysisId).catch(err => {
          console.error(`[analyzeAccidentPhotos] 记录调用次数失败（不影响返回）:`, err);
        });
      }
      
      // 异步保存分析结果到数据库（不等待，减少延迟）
      saveAnalysisResult(analysisId, analysisResult, {
        apiCalled,
        apiStatus,
        apiError: null,
        successCount: isValid ? photos.length : 0,
        failCount: isValid ? 0 : photos.length,
        totalPhotos: photos.length
      }).catch(err => {
        console.error(`[analyzeAccidentPhotos] 保存分析结果失败（不影响返回）:`, err);
      });

      // 直接返回 analysisResult 和 analysisId，不等待保存完成
      return {
        success: true,
        apiCalled: true,
        apiStatus: apiStatus,
        apiError: null,
        analysisId: analysisId, // 返回分析ID，用于关联询价单
        apiStats: {
          totalPhotos: photos.length,
          successCount: isValid ? photos.length : 0,
          failCount: isValid ? 0 : photos.length
        },
        data: analysisResult // 直接返回完整的分析结果对象
      };
    } catch (error) {
      console.error(`[analyzeAccidentPhotos] 综合分析失败:`, error);
      apiError = error.message;
      apiStatus = 'failed';
      
      // 构建失败结果对象
      const failedResult = {
        isVehicleRelated: false,
        isAccidentRelated: false,
        isCompliant: false,
        photoDetails: photos.map((photoUrl, index) => ({
          photoIndex: index + 1,
          photoUrl: photoUrl,
          isClear: false,
          identifiedVehicles: [],
          contribution: `分析失败: ${error.message}`
        })),
        vehicles: [],
        accidentInfo: null,
        unattributedDamage: [],
        additionalInfo: null,
        error: error.message
      };
      
      // analysisId 已在前面验证过，直接使用传入的 analysisId
      console.log(`[analyzeAccidentPhotos] 分析失败，使用传入的分析ID: ${analysisId}`);
      
      // 异步保存失败结果（不等待）
      saveAnalysisResult(analysisId, failedResult, {
        apiCalled,
        apiStatus,
        apiError,
        successCount: 0,
        failCount: photos.length,
        totalPhotos: photos.length
      }).catch(err => {
        console.error(`[analyzeAccidentPhotos] 保存失败结果失败:`, err);
      });
      
      return {
        success: false,
        message: apiError || 'AI分析失败，请重试', // 与 apiError 一致，供前端 api 层 result.message 展示
        apiCalled: true,
        apiStatus: 'failed',
        apiError: apiError,
        analysisId: analysisId, // 返回分析ID，即使失败也返回
        apiStats: {
          totalPhotos: photos.length,
          successCount: 0,
          failCount: photos.length
        },
        data: failedResult // 直接返回失败结果对象
      };
    }
  } catch (error) {
    console.error('[analyzeAccidentPhotos] 分析事故照片失败:', error);
    return {
      success: false,
      message: error.message || '分析失败',
      apiCalled: false,
      apiStatus: 'error',
      apiError: error.message
    };
  }
};

/**
 * 构建分析提示词（损伤部位/类型/程度 + 专业维修意见，并引用汽修国标/行标摘要）
 */
function buildAnalysisPrompt() {
  return `你是一位熟悉**国家与行业标准**的车险理赔查勘定损专家，需要分析**同一场事故的多张照片**，并给出**专业、详细**的定损与维修建议。

## 必须输出的核心内容
1. **损伤部位**：受损部位名称列表（如：前保险杠、左前翼子板、左前大灯、发动机舱盖、前纵梁）。
2. **损伤类型**：损伤类型列表（如：凹陷、刮擦、破损、变形、断裂、错位）。
3. **损伤程度**：整体严重程度，取值为「轻微」「中等」「严重」之一。
4. **维修意见（必填且须详细、专业）**：
   - 每个损伤部位须明确是「修复」还是「更换」，并简要说明理由（如涉及安全/强度建议更换；仅外观可钣金修复等）。
   - 工艺表述须具体：钣金、喷漆、更换总成、拆检、校正等。
   - 若涉及结构件、安全件（纵梁、A/B柱、制动/转向相关、大灯等），须在建议中明确更换或拆检，并符合安全与竣工检验要求。
   - 综合维修建议（lossAssessmentSuggestion）须汇总各车要点，便于定损与报价；禁止只写「根据AI分析建议」等笼统表述。

${standardsReferenceText}

## 多车情况
若照片中有多辆受损车辆，请为每辆车分别输出上述四项；vehicles 数组中每项须含 damagedParts、damageTypes、overallSeverity、damageSummary（每车维修建议须详细）；accidentInfo.lossAssessmentSuggestion 为综合维修意见（必填，汇总各车）。

## 返回格式（严格遵守，JSON）
{
  "isVehicleRelated": true,
  "isAccidentRelated": true,
  "isCompliant": true,
  "photoDetails": [
    { "photoIndex": 1, "isClear": true, "identifiedVehicles": ["车辆1"], "contribution": "简要描述" }
  ],
  "vehicles": [
    {
      "vehicleId": "车辆1",
      "brand": "品牌或null",
      "model": "车型或null",
      "color": "颜色或null",
      "plateNumber": "车牌或null",
      "damagedParts": ["部位1", "部位2"],
      "damageTypes": ["类型1", "类型2"],
      "overallSeverity": "轻微|中等|严重",
      "damageSummary": "本车详细维修建议：各部位修/换及工艺说明，禁止笼统表述"
    }
  ],
  "accidentInfo": {
    "accidentType": "事故类型或null",
    "collisionDirection": "碰撞方向或null",
    "accidentLocation": "位置或null",
    "weather": "天气或null",
    "lossAssessmentSuggestion": "综合维修意见（必填，汇总各车，详细且可执行）"
  },
  "unattributedDamage": [],
  "additionalInfo": { "liability": null, "specialNotes": null }
}

## 注意事项
- 损伤部位、类型、程度必须基于照片实际内容，不得臆测。
- overallSeverity 只能是：轻微、中等、严重。
- damageSummary 与 lossAssessmentSuggestion 必须为**具体、可执行**的维修建议（按部位写修/换及工艺），并符合上述规范要点；禁止出现「根据AI分析建议」等空泛用语。
- 确保返回合法 JSON，字段无遗漏。`;
}

/**
 * 使用阿里千问 API 一次性分析多张图片（多图联动综合分析）
 * 入参 photoUrls：云存储地址数组 string[]，每项为 cloud://，由前端 uploadPhotos 保证；云函数内 getTempFileURL 得到临时公网链接后按千问要求提交。
 */
async function analyzeMultipleImagesWithQianwen(photoUrls, prompt, apiKey) {
  try {
    const list = Array.isArray(photoUrls) ? photoUrls : [];
    const cloudFileIDs = list.filter(
      (id) => typeof id === 'string' && id.trim().toLowerCase().startsWith('cloud://')
    );
    if (cloudFileIDs.length === 0) {
      throw new Error('没有可用的照片：请传入 cloud:// 格式的云存储地址');
    }
    const tempResult = await cloud.getTempFileURL({ fileList: cloudFileIDs });
    const fileIDMap = {};
    (tempResult.fileList || []).forEach((item) => {
      if (item.status === 0 && item.tempFileURL) {
        fileIDMap[item.fileID] = item.tempFileURL.trim();
      }
    });
    // 按原顺序得到临时链接，只传成功取到链接的（不传 cloud:// 给千问）
    const imageUrlsForAPI = cloudFileIDs.map((id) => fileIDMap[id]).filter(Boolean);
    if (imageUrlsForAPI.length === 0) {
      throw new Error('无法获取照片临时链接，请确认已上传到云存储');
    }
    console.log(`[analyzeAccidentPhotos] 调用 qwen3-vl-plus API，共 ${imageUrlsForAPI.length} 张图片`);

    const openai = new OpenAI({
      apiKey: apiKey,
      baseURL: QIANWEN_BASE_URL
    });

    const content = [];
    imageUrlsForAPI.forEach((url) => {
      content.push({
        type: 'image_url',
        image_url: { url }
      });
    });
    
    // 添加提示词文本
    content.push({
      type: 'text',
      text: prompt
    });
    
    const messages = [
      {
        role: 'user',
        content: content
      }
    ];

    // 4. 调用 API（一次性分析所有图片）
    const completion = await openai.chat.completions.create({
      model: QIANWEN_MODEL,
      messages: messages,
      temperature: 0.1
    });

    // 5. 解析返回结果
    const result = completion;
    console.log('[analyzeAccidentPhotos] API 调用成功（多图联动）');
    console.log('[analyzeAccidentPhotos] API 返回结果预览:', JSON.stringify(result).substring(0, 300));

    if (!result.choices || result.choices.length === 0) {
      throw new Error('API返回格式异常：未找到 choices');
    }

    const content_result = result.choices[0].message.content;
    console.log('[analyzeAccidentPhotos] 解析到的内容长度:', content_result?.length || 0);
    console.log('[analyzeAccidentPhotos] 解析到的内容预览:', content_result?.substring(0, 200) || '无内容');

    // 6. 解析 JSON 响应
    try {
      // 尝试提取 JSON 代码块
      let jsonContent = content_result;
      const jsonMatch = content_result.match(/```json\s*([\s\S]*?)\s*```/) || content_result.match(/```\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonContent = jsonMatch[1];
        console.log('[analyzeAccidentPhotos] 从代码块中提取 JSON');
      }
      
      const parsed = JSON.parse(jsonContent);
      console.log('[analyzeAccidentPhotos] JSON 解析成功（多图联动分析）');
      return parsed;
    } catch (parseError) {
      // JSON 解析失败，尝试从文本中提取信息
      console.warn('[analyzeAccidentPhotos] JSON 解析失败，尝试提取信息:', parseError.message);
      
      const extracted = extractInfoFromText(content_result);
      if (extracted) {
        console.log('[analyzeAccidentPhotos] 成功从文本中提取信息');
        return extracted;
      }
      
      // 返回默认值，但保留原始内容以便调试
      console.warn('[analyzeAccidentPhotos] 无法提取信息，返回默认值');
      return {
        isVehicleRelated: true,
        isAccidentRelated: true,
        isCompliant: true,
        photoDetails: [],
        vehiclesComprehensive: [],
        accidentComprehensive: null,
        unattributedDamage: [],
        compliance: {
          isAppropriate: true,
          isClear: true,
          isRelevant: true
        },
        rawContent: content_result // 保存原始内容以便调试
      };
    }
  } catch (error) {
    console.error('[analyzeAccidentPhotos] 调用阿里千问API失败（多图联动）:', error);
    
    // OpenAI SDK 的错误处理
    if (error.status) {
      console.error('[analyzeAccidentPhotos] API错误响应:', error.status, error.message);
      throw new Error(`API调用失败: ${error.status} - ${error.message}`);
    } else {
      throw error;
    }
  }
}
/**
 * 从文本中提取信息的辅助函数（当JSON解析失败时使用）
 */
function extractInfoFromText(text) {
  try {
    // 尝试提取关键信息
    const vehicleBrandMatch = text.match(/品牌[：:]\s*([^\n,，]+)/i);
    const vehicleModelMatch = text.match(/车型[：:]\s*([^\n,，]+)/i);
    const severityMatch = text.match(/严重程度[：:]\s*([轻微中等严重]+)/i);
    
    if (vehicleBrandMatch || vehicleModelMatch || severityMatch) {
      return {
        isVehicleRelated: true,
        isAccidentRelated: true,
        isCompliant: true,
        vehicleInfo: {
          brand: vehicleBrandMatch ? vehicleBrandMatch[1].trim() : null,
          model: vehicleModelMatch ? vehicleModelMatch[1].trim() : null,
          color: null
        },
        damageInfo: {
          damagedParts: [],
          damageTypes: [],
          severity: severityMatch ? severityMatch[1].trim() : '中等',
          needsReplacement: false
        },
        compliance: {
          isAppropriate: true,
          isClear: true,
          isRelevant: true
        }
      };
    }
  } catch (e) {
    console.warn('[analyzeAccidentPhotos] 提取信息失败:', e);
  }
  return null;
}


/**
 * 检查用户今日调用次数是否超限
 * @param {string} ownerId - 用户ID
 * @param {string} role - 用户角色 'merchant' | 'owner'
 * @returns {Promise<{allowed: boolean, currentCount: number, maxCount: number, message: string}>}
 */
async function checkDailyLimit(ownerId, role) {
  try {
    if (!ownerId || !role) {
      // 如果没有提供 ownerId 或 role，允许调用
      return {
        allowed: true,
        currentCount: 0,
        maxCount: 0,
        message: '未提供用户信息，跳过次数限制检查'
      };
    }

    // 定义每日调用次数限制
    const DAILY_LIMITS = {
      merchant: 50, // 服务商每日50次
      owner: 3      // 车主每日3次
    };

    const maxCount = DAILY_LIMITS[role] || 3; // 默认为3次

    // 获取今天的日期（YYYY-MM-DD格式）
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // 查询今日调用记录
    const callRecords = await db.collection('photo_analysis_results')
      .where({
        ownerId: ownerId,
        date: todayStr
      })
      .get();

    const currentCount = callRecords.data.length;

    if (currentCount >= maxCount) {
      return {
        allowed: false,
        currentCount: currentCount,
        maxCount: maxCount,
        message: `${role === 'merchant' ? '服务商' : '车主'}每日最多可调用${maxCount}次，今日已调用${currentCount}次，已达到上限`
      };
    }

    return {
      allowed: true,
      currentCount: currentCount,
      maxCount: maxCount,
      message: `今日已调用${currentCount}次，剩余${maxCount - currentCount}次`
    };
  } catch (error) {
    console.error('[analyzeAccidentPhotos] 检查调用次数失败:', error);
    // 出错时允许调用（避免影响正常流程）
    return {
      allowed: true,
      currentCount: 0,
      maxCount: 0,
      message: '检查调用次数失败，允许调用'
    };
  }
}

/**
 * 记录调用次数（写入 ai_call_records，不写入 photo_analysis_results，避免同一 analysisId 出现两条记录）
 * 有 ownerId+role 表示用户主动调用；无 role 表示后台 auditOrder 调用，不记入用户次数
 * @param {string} ownerId - 用户ID
 * @param {string} role - 用户角色（仅用户主动调用时传入）
 * @param {string} analysisId - 分析ID
 */
async function recordCallCount(ownerId, role, analysisId) {
  try {
    if (!ownerId || !role) {
      return; // 如果没有用户信息或角色（后台调用无 role），不记录
    }

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    await db.collection('ai_call_records').add({
      data: {
        ownerId,
        role,
        analysisId,
        date: todayStr,
        callTime: new Date()
      }
    });

    console.log(`[analyzeAccidentPhotos] 已记录用户 ${ownerId} (${role}) 的调用次数`);
  } catch (error) {
    console.error('[analyzeAccidentPhotos] 记录调用次数失败:', error);
  }
}

/**
 * 保存分析结果到数据库（使用 analysisId 关联）
 * @param {string} analysisId - 分析ID（用于关联询价单和AI分析结果）
 * @param {object} analysisResult - 完整的分析结果对象（包含 photoDetails, vehicles, accidentInfo 等）
 * @param {object} apiInfo - API 调用信息
 */
async function saveAnalysisResult(analysisId, analysisResult, apiInfo = {}) {
  try {
    if (!analysisId) {
      console.error('[analyzeAccidentPhotos] analysisId 不存在，无法保存分析结果');
      return;
    }

    // 检查是否已存在（根据 analysisId）
    const existing = await db.collection('photo_analysis_results')
      .where({ analysisId })
      .get();
    
    const analysisData = {
      analysisId: analysisId, // 使用 analysisId 作为主键
      analysisResult: analysisResult, // 保存完整的分析结果对象
      apiInfo: {
        apiCalled: apiInfo.apiCalled || false,
        apiStatus: apiInfo.apiStatus || 'unknown',
        apiError: apiInfo.apiError || null,
        successCount: apiInfo.successCount || 0,
        failCount: apiInfo.failCount || 0,
        totalPhotos: apiInfo.totalPhotos || 0
      },
      updateTime: new Date()
    };

    if (existing.data.length > 0) {
      // 更新现有记录
      await db.collection('photo_analysis_results')
        .where({ analysisId })
        .update({
          data: analysisData
        });
      console.log(`[analyzeAccidentPhotos] 已更新分析ID ${analysisId} 的分析结果`);
    } else {
      // 创建新记录
      analysisData.createTime = new Date();
      await db.collection('photo_analysis_results').add({
        data: analysisData
      });
      console.log(`[analyzeAccidentPhotos] 已保存分析ID ${analysisId} 的分析结果`);
    }

    // 不再更新订单表，只保存到 photo_analysis_results 集合
  } catch (error) {
    console.error('[analyzeAccidentPhotos] 保存分析结果失败:', error);
    // 不抛出错误，分析结果可以后续查询
  }
}

/**
 * 默认分析结果（当API不可用时）
 * 返回原始格式，不做汇总处理
 */
function getDefaultAnalysis(photos) {
  return {
    success: true,
    apiCalled: false,
    apiStatus: 'not_configured',
    apiStats: {
      totalPhotos: photos.length,
      successCount: 0,
      failCount: 0
    },
    data: {
      details: photos.map((url, index) => ({
        photoIndex: index,
        photoUrl: url,
        analysis: {
          isVehicleRelated: true,
          isAccidentRelated: true,
          isCompliant: true,
          vehicles: [], // 新格式：空数组
          compliance: {
            isAppropriate: true,
            isClear: true,
            isRelevant: true
          }
        },
        isValid: true,
        apiSuccess: false
      })),
      isValid: true
    }
  };
}
