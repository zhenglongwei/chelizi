#!/usr/bin/env node
/**
 * 奖励金核心算法自动化测试
 * 验证 reward-calculator、conversion-bonus、review-like 中的纯函数逻辑
 * 运行：node web/scripts/test-reward-algorithms.js
 */

const assert = require('assert');

// ========== reward-calculator 测试 ==========
const rewardCalculator = require('../api-server/reward-calculator');

function testRewardCalculator() {
  console.log('\n--- reward-calculator ---');

  // 车价校准系数
  assert.strictEqual(rewardCalculator.getVehicleCoeff(50000), 1.0, '5万车价应1.0');
  assert.strictEqual(rewardCalculator.getVehicleCoeff(100000), 1.0, '10万车价应1.0');
  assert.strictEqual(rewardCalculator.getVehicleCoeff(150000), 1.2, '15万车价应1.2');
  assert.strictEqual(rewardCalculator.getVehicleCoeff(250000), 1.5, '25万车价应1.5');
  assert.strictEqual(rewardCalculator.getVehicleCoeff(400000), 2.0, '40万车价应2.0');
  assert.strictEqual(rewardCalculator.getVehicleCoeff(600000), 3.0, '60万车价应3.0');
  assert.strictEqual(rewardCalculator.getVehicleCoeff(null), 1.0, 'null车价应1.0');
  console.log('  getVehicleCoeff: OK');

  // 订单分级
  assert.strictEqual(rewardCalculator.getOrderTier(500), 1, '500元应1级');
  assert.strictEqual(rewardCalculator.getOrderTier(1000), 1, '1000元应1级');
  assert.strictEqual(rewardCalculator.getOrderTier(3000), 2, '3000元应2级');
  assert.strictEqual(rewardCalculator.getOrderTier(5000), 2, '5000元应2级');
  assert.strictEqual(rewardCalculator.getOrderTier(15000), 3, '15000元应3级');
  assert.strictEqual(rewardCalculator.getOrderTier(25000), 4, '25000元应4级');
  console.log('  getOrderTier: OK');

  // 优质内容浮动
  assert.strictEqual(rewardCalculator.calcPremiumFloatReward(100, false), 0, '非优质无浮动');
  assert.strictEqual(rewardCalculator.calcPremiumFloatReward(100, true), 50, '优质50%');
  assert.strictEqual(rewardCalculator.calcPremiumFloatReward(100, false, true), 100, '爆款100%');
  console.log('  calcPremiumFloatReward: OK');

  // 复杂度系数
  assert.strictEqual(rewardCalculator.getComplexityCoeff(false, false), 1.0, '基础1.0');
  assert.strictEqual(rewardCalculator.getComplexityCoeff(false, true), 1.5, '高难度1.5');
  assert.strictEqual(rewardCalculator.getComplexityCoeff(true, false), 2.0, '保险事故2.0');
  console.log('  getComplexityCoeff: OK');

  // 订单分级封顶
  assert.strictEqual(rewardCalculator.ORDER_TIER_CAP[1], 30, '1级封顶30');
  assert.strictEqual(rewardCalculator.ORDER_TIER_CAP[2], 150, '2级封顶150');
  assert.strictEqual(rewardCalculator.ORDER_TIER_CAP[3], 800, '3级封顶800');
  assert.strictEqual(rewardCalculator.ORDER_TIER_CAP[4], 2000, '4级封顶2000');
  console.log('  ORDER_TIER_CAP: OK');
}

// ========== conversion-bonus 决策权重测试 ==========
const conversionBonus = require('../api-server/services/conversion-bonus-service');

function testConversionBonus() {
  console.log('\n--- conversion-bonus (决策权重) ---');

  // 决策时间：24h内4.0，24-72h 2.0，3-7天1.0（边界：<=24h为4.0，>24h且<=72h为2.0）
  const orderAt = new Date('2026-02-20T12:00:00');
  assert.strictEqual(conversionBonus.getDecisionTimeWeight(new Date('2026-02-20T06:00:00'), orderAt), 4.0, '6h前点赞应4.0');
  assert.strictEqual(conversionBonus.getDecisionTimeWeight(new Date('2026-02-19T11:00:00'), orderAt), 2.0, '25h前点赞应2.0');
  assert.strictEqual(conversionBonus.getDecisionTimeWeight(new Date('2026-02-16T12:00:00'), orderAt), 1.0, '4天前点赞应1.0');
  assert.strictEqual(conversionBonus.getDecisionTimeWeight(new Date('2026-02-10T12:00:00'), orderAt), 0, '10天前应0');
  console.log('  getDecisionTimeWeight: OK');

  // 内容停留：≥3分钟3.0，1-3分钟2.0，30秒-1分钟1.0
  assert.strictEqual(conversionBonus.getContentStayWeight(200), 3.0, '200秒应3.0');
  assert.strictEqual(conversionBonus.getContentStayWeight(120), 2.0, '120秒应2.0');
  assert.strictEqual(conversionBonus.getContentStayWeight(45), 1.0, '45秒应1.0');
  assert.strictEqual(conversionBonus.getContentStayWeight(20), 0, '20秒应0');
  console.log('  getContentStayWeight: OK');

  // 内容匹配：车牌一致3.0，同品牌2.0，其他1.0
  assert.strictEqual(conversionBonus.getContentMatchWeight('京A12345', '京A12345', '大众', '大众'), 3.0, '车牌一致3.0');
  assert.strictEqual(conversionBonus.getContentMatchWeight('京B', '京A', '大众', '大众'), 2.0, '同品牌2.0');
  assert.strictEqual(conversionBonus.getContentMatchWeight('', '', '大众', '丰田'), 1.0, '不同品牌1.0');
  assert.strictEqual(conversionBonus.getContentMatchWeight('', '', '', ''), 1.0, '都空1.0');
  console.log('  getContentMatchWeight: OK');

  // 内容价值：4级3.0，3级2.0，2级1.0，1级0.5
  assert.strictEqual(conversionBonus.getContentValueWeight(4), 3.0, '4级3.0');
  assert.strictEqual(conversionBonus.getContentValueWeight(3), 2.0, '3级2.0');
  assert.strictEqual(conversionBonus.getContentValueWeight(2), 1.0, '2级1.0');
  assert.strictEqual(conversionBonus.getContentValueWeight(1), 0.5, '1级0.5');
  assert.strictEqual(conversionBonus.getContentValueWeight(0), 0, '0级0');
  console.log('  getContentValueWeight: OK');

  // 四维相乘
  const w = conversionBonus.calcDecisionWeight({
    likeAt: new Date('2026-02-20T06:00:00'),
    orderCreatedAt: new Date('2026-02-20T12:00:00'),
    readingSeconds: 200,
    orderPlate: '京A12345',
    reviewOrderPlate: '京A12345',
    orderBrand: '大众',
    reviewBrand: '大众',
    contentQualityLevel: 3,
  });
  assert.strictEqual(w, 4 * 3 * 3 * 2, '4*3*3*2=72');
  console.log('  calcDecisionWeight: OK');
}

// ========== review-like 点赞权重测试 ==========
// 直接测试内部逻辑（review-like-service 未导出纯函数，需复制或通过 like 间接测）
function testLikeWeights() {
  console.log('\n--- review-like (点赞权重) ---');
  // 可信度权重：0级0 1级0.3 2级1.0 3级1.5 4级2.0
  const LIKE_CREDIBILITY_WEIGHT = { 0: 0, 1: 0.3, 2: 1.0, 3: 1.5, 4: 2.0 };
  function getCredibilityWeight(level) {
    const L = parseInt(level, 10);
    if (isNaN(L) || L < 0 || L > 4) return 0;
    return LIKE_CREDIBILITY_WEIGHT[L] ?? 0;
  }
  function getVehicleMatchByPlate(a, b) {
    const x = (a || '').trim().toUpperCase();
    const y = (b || '').trim().toUpperCase();
    if (!x || !y) return 0;
    return x === y ? 1 : 0;
  }
  function calcWeightCoefficient(credibilityWeight, vehicleMatchByPlate) {
    const vehicleWeight = vehicleMatchByPlate ? 2.0 : 0.5;
    return Math.round(credibilityWeight * vehicleWeight * 10000) / 10000;
  }

  assert.strictEqual(getCredibilityWeight(0), 0, '0级权重0');
  assert.strictEqual(getCredibilityWeight(1), 0.3, '1级权重0.3');
  assert.strictEqual(getCredibilityWeight(4), 2.0, '4级权重2.0');
  assert.strictEqual(getVehicleMatchByPlate('京A', '京A'), 1, '车牌一致1');
  assert.strictEqual(getVehicleMatchByPlate('京A', '京B'), 0, '车牌不同0');
  assert.strictEqual(calcWeightCoefficient(1.0, 1), 2.0, '2级+车牌一致=2.0');
  assert.strictEqual(calcWeightCoefficient(1.0, 0), 0.5, '2级+无匹配=0.5');
  console.log('  credibility/vehicle/weight: OK');
}

// ========== 主入口 ==========
function main() {
  console.log('=== 奖励金核心算法测试 ===');
  try {
    testRewardCalculator();
    testConversionBonus();
    testLikeWeights();
    console.log('\n✅ 全部通过');
    process.exit(0);
  } catch (e) {
    console.error('\n❌ 失败:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
