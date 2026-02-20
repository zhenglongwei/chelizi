/**
 * 系统配置工具函数
 * 用于处理系统配置的扁平化和解析
 */

/**
 * 将扁平化的系统配置转换为嵌套对象
 * 例如：{ "recommendationWeights.price": 40 } => { recommendationWeights: { price: 40 } }
 */
export function parseSystemConfig(configList: Array<{ key: string; value: any }>, defaultConfig: any = {}): any {
  const config: any = {};
  
  // 将扁平化配置转换为嵌套对象
  configList.forEach(item => {
    if (!item.key) return;
    
    // 支持点号分隔的嵌套键（如 "recommendationWeights.price"）
    const keys = item.key.split('.');
    let current = config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]]) {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = item.value;
  });
  
  // 补充默认配置（如果配置中不存在）
  Object.keys(defaultConfig).forEach(key => {
    if (config[key] === undefined) {
      config[key] = defaultConfig[key];
    }
  });
  
  return config;
}

/**
 * 将嵌套对象扁平化为系统配置格式
 * 例如：{ recommendationWeights: { price: 40 } } => { "recommendationWeights.price": 40 }
 */
export function flattenSystemConfig(config: any, prefix = ''): Record<string, any> {
  const result: Record<string, any> = {};
  
  for (const key in config) {
    if (config.hasOwnProperty(key)) {
      const value = config[key];
      const newKey = prefix ? `${prefix}.${key}` : key;
      
      // 跳过 null 和 undefined
      if (value === null || value === undefined) {
        continue;
      }
      
      // 如果是对象且不是数组、Date等，递归扁平化
      if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
        Object.assign(result, flattenSystemConfig(value, newKey));
      } else {
        result[newKey] = value;
      }
    }
  }
  
  return result;
}

/**
 * 获取系统配置的默认值
 */
export function getDefaultSystemConfig(): any {
  return {
    // 推荐规则权重
    recommendationWeights: {
      price: 40,        // 价格权重
      violations: 25,  // 违规记录权重
      accuracy: 10,    // 报价准确性权重
      satisfaction: 20, // 车主满意度权重
      distance: 5      // 距离权重
    },
    // 报价预警阈值
    quoteWarningThreshold: 30, // 低于同批次均值30%触发预警
    // 价格底线
    priceBottomLine: 90, // 最终维修金额≥竞价金额90%
    // 报价偏离度惩罚阈值
    quoteDeviationThreshold: 20, // 偏差超20%扣保证金
    // 报价时效（小时）
    quoteTimeoutHours: 2,
    // 报价有效期（小时）
    quoteValidityPeriod: 24,
    // 佣金比例
    commissionRate: {
      oem: 2,      // 原厂件2%
      nonOem: 12   // 非原厂件12%（包含2%平台佣金+10%车主返现）
    },
    // 返现比例
    refundRate: 10, // 非原厂件10%
    // 分账与评价开关：0=可提前评价，1=需等分账完成
    require_settlement_before_review: '0',
    // 保证金标准
    depositAmount: 10000,
    // 保证金补缴阈值
    depositRechargeThreshold: 5000,
    // 奖励金规则：订单分级金额阈值（元）
    rewardTierThresholds: {
      tier1Max: 1000,   // 一级订单≤1000
      tier2Max: 5000,   // 二级订单≤5000
      tier3Max: 20000,   // 三级订单≤20000
    },
    // 分账配置：平台基准佣金比例（%）
    settlementCommissionRate: 12,
    // 附近维修厂最大距离（km），首页/搜索按此过滤
    nearby_max_km: 50,
  };
}
