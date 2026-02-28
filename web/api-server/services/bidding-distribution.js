/**
 * 竞价单分发服务
 * 按《07-竞价单分发机制》及《竞价单分发机制-实施计划》实现
 * 先过滤，后分层，再排序；资质+能力+合规+违规；梯队划分；推送消息
 */

const crypto = require('crypto');
const complexityService = require('./complexity-service');
const shopScore = require('../shop-score');

const LOG_PREFIX = '[BiddingDistribution]';

const DEFAULT_CONFIG = {
  filterComplianceMin: 80,
  filterViolationDays: 30,
  filterCapacityCheck: false,
  fallbackDistanceExpandRate: 0.2,
  fallbackMinShops: 3,
  tier1MatchScoreMin: 80,
  tier1ComplianceMin: 95,
  tier2MatchScoreMin: 60,
  tier2MatchScoreMax: 79,
  tier2ComplianceMin: 85,
  tier1ExclusiveMinutes: 15,
  tier3MaxShops: 2,
  distributeL1L2Max: 10,
  distributeL1L2ValidStop: 5,
  distributeL3L4Max: 15,
  distributeL3L4ValidStop: 8,
  newShopDays: 90,
  newShopBaseScore: 60,
  sameProjectScorePriority: 15,
  sameProjectScoreFallback: 5,
  sceneWeightL1L2: 0.35,
  sceneWeightL3L4: 0.6,
};

const LEVEL_ORDER = { L1: 1, L2: 2, L3: 3, L4: 4 };

/**
 * 读取竞价分发配置
 */
async function getBiddingDistributionConfig(pool) {
  try {
    const [rows] = await pool.execute(
      "SELECT `value` FROM settings WHERE `key` = 'biddingDistribution'"
    );
    if (rows.length === 0 || !rows[0].value) {
      return { ...DEFAULT_CONFIG };
    }
    const parsed = JSON.parse(rows[0].value || '{}');
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (err) {
    console.warn(`${LOG_PREFIX} getConfig error:`, err.message);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * 从竞价定损解析维修项目及每项复杂度
 * @returns {Promise<Array<{name:string, level:string}>>}
 */
async function parseBiddingItemsWithComplexity(pool, analysisResult) {
  const items = [];
  const suggestions = analysisResult?.repair_suggestions || [];
  const damages = analysisResult?.damages || [];

  for (const s of suggestions) {
    const name = (s.item || s.name || s.damage_part || s.repair_type || '').toString().trim();
    if (name) items.push({ name });
  }
  for (const d of damages) {
    const part = (d.part || '').toString().trim();
    const type = (d.type || '').toString().trim();
    if (part || type) items.push({ name: part ? `${part} ${type}`.trim() : type });
  }

  if (items.length === 0) return [{ name: '维修', level: 'L2' }];

  try {
    const [rows] = await pool.execute(
      "SELECT `level`, project_type FROM repair_complexity_levels WHERE `level` IN ('L1','L2','L3','L4')"
    );
    if (!rows || rows.length === 0) {
      return items.map((i) => ({ ...i, level: 'L2' }));
    }

    const result = [];
    for (const item of items) {
      const text = (item.name || '').toLowerCase();
      let matchedLevel = 'L2';
      for (const r of rows) {
        const L = (r.level || '').toUpperCase();
        if (!LEVEL_ORDER[L]) continue;
        const keywords = String(r.project_type || '').split(/[|,，]/).map((k) => k.trim().toLowerCase()).filter(Boolean);
        for (const kw of keywords) {
          if (kw && text.includes(kw)) {
            if (LEVEL_ORDER[L] > LEVEL_ORDER[matchedLevel]) matchedLevel = L;
            break;
          }
        }
      }
      result.push({ name: item.name, level: matchedLevel });
    }
    return result;
  } catch (err) {
    console.warn(`${LOG_PREFIX} parseBiddingItemsWithComplexity error:`, err.message);
    return items.map((i) => ({ ...i, level: 'L2' }));
  }
}

/**
 * 资质校验：按《修理厂资质等级和维修复杂度之间的关系》
 * L1: 三类对应专项/二类/一类；L2: 二类/一类全量、三类对应专项；L3: 二类及以上；L4: 仅一类
 */
async function checkShopQualificationForBidding(pool, shopId, biddingId) {
  const [biddingRows] = await pool.execute(
    `SELECT dr.analysis_result FROM biddings b
     INNER JOIN damage_reports dr ON b.report_id = dr.report_id
     WHERE b.bidding_id = ?`,
    [biddingId]
  );
  if (biddingRows.length === 0) return false;

  let analysisResult = {};
  try {
    analysisResult = typeof biddingRows[0].analysis_result === 'string'
      ? JSON.parse(biddingRows[0].analysis_result || '{}')
      : (biddingRows[0].analysis_result || {});
  } catch (_) {}

  const items = complexityService.normalizeRepairItems([], analysisResult);
  const { level: maxLevel } = await complexityService.resolveComplexityFromItems(pool, items);

  const [shopRows] = await pool.execute(
    `SELECT qualification_status, qualification_level, categories, technician_certs
     FROM shops WHERE shop_id = ?`,
    [shopId]
  );
  if (shopRows.length === 0) return false;
  const shop = shopRows[0];

  if (shop.qualification_status !== 1 && shop.qualification_status !== '1') return false;

  const ql = (shop.qualification_level || '').toString();
  const hasYilei = /一类|1类/i.test(ql);
  const hasErlei = /二类|2类/i.test(ql);
  const hasSanlei = /三类|3类/i.test(ql);

  let categories = [];
  try {
    categories = Array.isArray(shop.categories) ? shop.categories : JSON.parse(shop.categories || '[]');
  } catch (_) {}
  const categoryStr = categories.map((c) => String(c || '').toLowerCase()).join(' ');

  if (maxLevel === 'L4') {
    return hasYilei;
  }
  if (maxLevel === 'L3') {
    if (hasSanlei) return false;
    if (hasYilei || hasErlei) return true;
    return false;
  }
  if (maxLevel === 'L2') {
    if (hasYilei || hasErlei) return true;
    if (hasSanlei) {
      const needPaint = /钣金|喷漆|补漆/i.test(categoryStr) || items.some((i) => /钣金|喷漆|补漆/i.test(i.name || ''));
      const needEngine = /发动机|保养|机油/i.test(categoryStr) || items.some((i) => /发动机|保养|机油/i.test(i.name || ''));
      if (needPaint && /钣金|喷漆|补漆/i.test(categoryStr)) return true;
      if (needEngine && /保养|发动机|机油/i.test(categoryStr)) return true;
      return categoryStr.length > 0;
    }
    return false;
  }
  if (maxLevel === 'L1') {
    if (hasYilei || hasErlei) return true;
    if (hasSanlei && categoryStr.length > 0) return true;
    return false;
  }
  return true;
}

/**
 * 同项目完单：按复杂度分层，优先匹配最高复杂度项目
 * @returns {{ passed: boolean, isPriorityMatch: boolean }}
 */
async function hasSameProjectCompletion(pool, shopId, biddingId, config, isNewShop) {
  if (isNewShop) return { passed: true, isPriorityMatch: false };

  const [biddingRows] = await pool.execute(
    `SELECT dr.analysis_result FROM biddings b
     INNER JOIN damage_reports dr ON b.report_id = dr.report_id
     WHERE b.bidding_id = ?`,
    [biddingId]
  );
  if (biddingRows.length === 0) return { passed: false, isPriorityMatch: false };

  let analysisResult = {};
  try {
    analysisResult = typeof biddingRows[0].analysis_result === 'string'
      ? JSON.parse(biddingRows[0].analysis_result || '{}')
      : (biddingRows[0].analysis_result || {});
  } catch (_) {}

  const biddingItems = await parseBiddingItemsWithComplexity(pool, analysisResult);
  if (biddingItems.length === 0) return { passed: true, isPriorityMatch: false };

  const levels = biddingItems.map((i) => i.level);
  const maxLevel = levels.reduce((a, b) => (LEVEL_ORDER[b] > LEVEL_ORDER[a] ? b : a), 'L1');
  const highItems = biddingItems.filter((i) => i.level === maxLevel).map((i) => (i.name || '').toLowerCase());
  const allKeywords = biddingItems.map((i) => (i.name || '').toLowerCase()).filter(Boolean);

  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const [orders] = await pool.execute(
    `SELECT o.order_id, o.repair_plan, q.items as quote_items
     FROM orders o
     LEFT JOIN quotes q ON o.quote_id = q.quote_id
     WHERE o.shop_id = ? AND o.status = 3 AND COALESCE(o.completed_at, o.updated_at) >= ?`,
    [shopId, ninetyDaysAgo]
  );

  const extractItemNames = (order) => {
    const names = [];
    if (order.repair_plan) {
      try {
        const rp = typeof order.repair_plan === 'string' ? JSON.parse(order.repair_plan) : order.repair_plan;
        const items = rp?.items || [];
        items.forEach((i) => {
          const n = i.name || i.damage_part || i.repair_type;
          if (n) names.push(String(n).toLowerCase());
        });
      } catch (_) {}
    }
    if (order.quote_items) {
      try {
        const qi = typeof order.quote_items === 'string' ? JSON.parse(order.quote_items) : order.quote_items;
        (qi || []).forEach((i) => {
          const n = i.name || i.damage_part || i.repair_type;
          if (n) names.push(String(n).toLowerCase());
        });
      } catch (_) {}
    }
    return names;
  };

  for (const order of orders) {
    const completedNames = extractItemNames(order);
    const text = completedNames.join(' ');

    for (const kw of highItems) {
      if (kw && text.includes(kw)) return { passed: true, isPriorityMatch: true };
    }
  }

  for (const order of orders) {
    const completedNames = extractItemNames(order);
    const text = completedNames.join(' ');

    for (const kw of allKeywords) {
      if (kw && text.includes(kw)) return { passed: true, isPriorityMatch: false };
    }
  }

  return { passed: false, isPriorityMatch: false };
}

/**
 * 计算服务商综合匹配分
 * 公式：店铺综合得分×场景权重 + 同项目完单量分 + 报价历史准确度分 + 时效履约率分
 */
async function calcMerchantMatchScore(pool, shop, bidding, opts = {}) {
  const config = opts.config || await getBiddingDistributionConfig(pool);
  const biddingItems = opts.biddingItems || [];
  const sameProjectResult = opts.sameProjectResult || { isPriorityMatch: false };

  const newShopDays = config.newShopDays || 90;
  const created = shop.created_at ? new Date(shop.created_at) : null;
  const isNewShop = created && (Date.now() - created) / (24 * 60 * 60 * 1000) <= newShopDays;

  let shopScoreVal = shop.shop_score != null ? parseFloat(shop.shop_score) : null;
  if (shopScoreVal == null && shop.rating != null) shopScoreVal = parseFloat(shop.rating) * 20;
  if (shopScoreVal == null || isNaN(shopScoreVal)) {
    try {
      const { score } = await shopScore.computeShopScore(pool, shop.shop_id);
      shopScoreVal = score;
    } catch (_) {
      shopScoreVal = isNewShop ? (config.newShopBaseScore || 60) : 50;
    }
  }
  if (isNewShop) shopScoreVal = config.newShopBaseScore || 60;

  const maxLevel = biddingItems.length > 0
    ? biddingItems.map((i) => i.level).reduce((a, b) => (LEVEL_ORDER[b] > LEVEL_ORDER[a] ? b : a), 'L1')
    : 'L2';
  const sceneWeight = (maxLevel === 'L3' || maxLevel === 'L4') ? (config.sceneWeightL3L4 || 0.6) : (config.sceneWeightL1L2 || 0.35);

  const baseScore = Math.min(100, Math.max(0, shopScoreVal)) * sceneWeight;

  const deviation = shop.deviation_rate != null ? parseFloat(shop.deviation_rate) : 0;
  let deviationScore = 20;
  if (deviation > 30) deviationScore = 0;
  else if (deviation > 10) deviationScore = Math.max(0, 20 - (deviation - 10));

  const sameProjectScore = sameProjectResult.isPriorityMatch
    ? (config.sameProjectScorePriority || 15)
    : (config.sameProjectScoreFallback || 5);

  const responseScore = 5;

  return Math.round((baseScore + deviationScore + sameProjectScore + responseScore) * 10) / 10;
}

/**
 * 硬门槛过滤 + 兜底扩大距离
 * @returns {Promise<Array<{shop_id, ...}>>}
 */
async function filterShopsForBidding(pool, biddingId, userId) {
  const config = await getBiddingDistributionConfig(pool);

  const [biddingRows] = await pool.execute(
    `SELECT b.*, u.latitude as user_lat, u.longitude as user_lng, dr.analysis_result
     FROM biddings b
     INNER JOIN users u ON b.user_id = u.user_id
     INNER JOIN damage_reports dr ON b.report_id = dr.report_id
     WHERE b.bidding_id = ?`,
    [biddingId]
  );
  if (biddingRows.length === 0) return [];
  const bidding = biddingRows[0];
  if (!bidding.user_lat || !bidding.user_lng) return [];

  let rangeKm = parseFloat(bidding.range_km) || 5;
  const fallbackMin = config.fallbackMinShops || 3;
  const expandRate = config.fallbackDistanceExpandRate || 0.2;

  const acosArg = 'cos(radians(?)) * cos(radians(s.latitude)) * cos(radians(s.longitude) - radians(?)) + sin(radians(?)) * sin(radians(s.latitude))';

  let shops = [];
  let currentRange = rangeKm;

  while (shops.length < fallbackMin && currentRange <= 200) {
    const [rows] = await pool.execute(
      `SELECT s.shop_id, s.name, s.latitude, s.longitude, s.qualification_status, s.qualification_level,
              s.categories, s.technician_certs, s.compliance_rate, s.deviation_rate, s.total_orders,
              s.shop_score, s.rating, s.created_at,
              (6371 * acos(LEAST(1, GREATEST(-1, ${acosArg})))) as distance_km
       FROM shops s
       WHERE s.status = 1 AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
         AND (6371 * acos(LEAST(1, GREATEST(-1, ${acosArg})))) <= ?
         AND (s.qualification_status = 1 OR s.qualification_status = '1')`,
      [bidding.user_lat, bidding.user_lng, bidding.user_lat, bidding.user_lat, bidding.user_lng, bidding.user_lat, currentRange]
    );

    const [violationRows] = await pool.execute(
      `SELECT target_id FROM violation_records
       WHERE target_type = 'shop' AND violation_level = 4
         AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [config.filterViolationDays || 30]
    );
    const violatedShopIds = new Set((violationRows || []).map((r) => r.target_id));

    const newShopDays = config.newShopDays || 90;
    const complianceMin = config.filterComplianceMin || 80;

    const biddingItems = await parseBiddingItemsWithComplexity(
      pool,
      typeof bidding.analysis_result === 'string' ? JSON.parse(bidding.analysis_result || '{}') : (bidding.analysis_result || {})
    );

    shops = [];
    for (const row of rows || []) {
      if (violatedShopIds.has(row.shop_id)) continue;

      const created = row.created_at ? new Date(row.created_at) : null;
      const isNewShop = created && (Date.now() - created) / (24 * 60 * 60 * 1000) <= newShopDays;

      const compliance = row.compliance_rate != null ? parseFloat(row.compliance_rate) : null;
      if (!isNewShop && compliance != null && compliance < complianceMin) continue;

      const qualOk = await checkShopQualificationForBidding(pool, row.shop_id, biddingId);
      if (!qualOk) continue;

      const sameProject = await hasSameProjectCompletion(pool, row.shop_id, biddingId, config, isNewShop);
      if (!sameProject.passed) continue;

      row.sameProjectResult = sameProject;
      row.isNewShop = isNewShop;
      row.biddingItems = biddingItems;
      shops.push(row);
    }

    if (shops.length >= fallbackMin) break;
    currentRange = Math.round(currentRange * (1 + expandRate) * 10) / 10;
  }

  return shops;
}

/**
 * 划分梯队并计算匹配分
 */
async function assignTiers(pool, shops, biddingId, config) {
  const [biddingRows] = await pool.execute(
    `SELECT b.tier1_window_ends_at, b.created_at FROM biddings b WHERE b.bidding_id = ?`,
    [biddingId]
  );
  const tier1EndsAt = biddingRows[0]?.tier1_window_ends_at
    ? new Date(biddingRows[0].tier1_window_ends_at)
    : null;

  const scored = [];
  for (const shop of shops) {
    const score = await calcMerchantMatchScore(pool, shop, { shop_id: shop.shop_id }, {
      config,
      biddingItems: shop.biddingItems || [],
      sameProjectResult: shop.sameProjectResult || {},
    });
    const compliance = shop.compliance_rate != null ? parseFloat(shop.compliance_rate) : null;
    const isNewShop = shop.isNewShop;

    let tier = 3;
    const compForTier1 = isNewShop ? 100 : (compliance || 0);
    const compForTier2 = isNewShop ? 100 : (compliance || 0);

    if (score >= (config.tier1MatchScoreMin || 80) && compForTier1 >= (config.tier1ComplianceMin || 95)) {
      tier = 1;
    } else if (
      score >= (config.tier2MatchScoreMin || 60) &&
      score <= (config.tier2MatchScoreMax || 79) &&
      compForTier2 >= (config.tier2ComplianceMin || 85)
    ) {
      tier = 2;
    }

    scored.push({ ...shop, _matchScore: score, _tier: tier });
  }

  scored.sort((a, b) => {
    if (a._tier !== b._tier) return a._tier - b._tier;
    return (b._matchScore || 0) - (a._matchScore || 0);
  });

  return scored;
}

/**
 * 向店铺批量发送竞价消息
 */
async function sendBiddingMessagesToShops(pool, shopIds, biddingId, title = '新竞价待报价') {
  if (!shopIds || shopIds.length === 0) return;

  const [merchantRows] = await pool.execute(
    `SELECT mu.merchant_id, mu.shop_id FROM merchant_users mu WHERE mu.shop_id IN (${shopIds.map(() => '?').join(',')}) AND mu.status = 1`,
    shopIds
  );

  const shopToMerchant = {};
  for (const r of merchantRows || []) {
    shopToMerchant[r.shop_id] = r.merchant_id;
  }

  const seen = new Set();
  for (const shopId of shopIds) {
    const merchantId = shopToMerchant[shopId];
    if (!merchantId || seen.has(merchantId)) continue;
    seen.add(merchantId);

    const msgId = 'mmsg_' + crypto.randomBytes(12).toString('hex');
    try {
      await pool.execute(
        `INSERT INTO merchant_messages (message_id, merchant_id, type, title, content, related_id, is_read)
         VALUES (?, ?, 'bidding', ?, ?, ?, 0)`,
        [msgId, merchantId, title, `您有新的竞价需求待报价，点击查看。`, biddingId]
      );
    } catch (err) {
      if (!String(err.message || '').includes('Duplicate')) {
        console.warn(`${LOG_PREFIX} sendBiddingMessages error:`, err.message);
      }
    }
  }

  // 预留公众号推送
  // await reserveWechatBiddingPush(shopIds, biddingId);
}

/**
 * 执行竞价分发：过滤、分层、推送第一梯队
 */
async function runBiddingDistribution(pool, biddingId) {
  const config = await getBiddingDistributionConfig(pool);

  const [biddingRows] = await pool.execute(
    `SELECT b.user_id, b.report_id FROM biddings b WHERE b.bidding_id = ?`,
    [biddingId]
  );
  if (biddingRows.length === 0) return { success: false, error: '竞价不存在' };

  const userId = biddingRows[0].user_id;

  const shops = await filterShopsForBidding(pool, biddingId, userId);
  if (shops.length === 0) {
    console.log(`${LOG_PREFIX} no shops passed filter for bidding ${biddingId}`);
    return { success: true, tier1Shops: [], tier2Shops: [], tier3Shops: [] };
  }

  const scored = await assignTiers(pool, shops, biddingId, config);

  const tier1 = scored.filter((s) => s._tier === 1);
  const tier2 = scored.filter((s) => s._tier === 2);
  const tier3 = scored.filter((s) => s._tier === 3);

  const [reportRows] = await pool.execute(
    `SELECT dr.analysis_result FROM biddings b
     INNER JOIN damage_reports dr ON b.report_id = dr.report_id
     WHERE b.bidding_id = ?`,
    [biddingId]
  );
  const analysisResult = reportRows[0]?.analysis_result;
  let parsed = {};
  try {
    parsed = typeof analysisResult === 'string' ? JSON.parse(analysisResult || '{}') : (analysisResult || {});
  } catch (_) {}
  const items = complexityService.normalizeRepairItems([], parsed);
  const { level: maxLevel } = await complexityService.resolveComplexityFromItems(pool, items);

  const isL1L2 = maxLevel === 'L1' || maxLevel === 'L2';
  const maxDistribute = isL1L2 ? (config.distributeL1L2Max || 10) : (config.distributeL3L4Max || 15);

  const tier1Ids = tier1.slice(0, maxDistribute).map((s) => s.shop_id);
  const tier2Ids = tier2.slice(0, Math.max(0, maxDistribute - tier1Ids.length)).map((s) => s.shop_id);
  const tier3Ids = tier3.slice(0, config.tier3MaxShops || 2).map((s) => s.shop_id);

  await pool.execute('DELETE FROM bidding_distribution WHERE bidding_id = ?', [biddingId]);
  const toInsert = [];
  tier1.forEach((s) => toInsert.push([biddingId, s.shop_id, 1, s._matchScore]));
  tier2.forEach((s) => toInsert.push([biddingId, s.shop_id, 2, s._matchScore]));
  tier3.forEach((s) => toInsert.push([biddingId, s.shop_id, 3, s._matchScore]));
  for (const row of toInsert) {
    await pool.execute(
      'INSERT INTO bidding_distribution (bidding_id, shop_id, tier, match_score) VALUES (?, ?, ?, ?)',
      row
    );
  }

  await sendBiddingMessagesToShops(pool, tier1Ids, biddingId, '新竞价待报价（第一梯队）');

  return {
    success: true,
    tier1Shops: tier1Ids,
    tier2Shops: tier2Ids,
    tier3Shops: tier3Ids,
    allFilteredShops: scored.map((s) => s.shop_id),
  };
}

/**
 * 判断店铺是否在指定竞价的可见梯队内
 * 优先使用 bidding_distribution 表，若无则回退到全量计算
 */
async function isShopVisibleForBidding(pool, shopId, biddingId, status) {
  if (status === 'ended') return true;

  const [distRows] = await pool.execute(
    'SELECT tier FROM bidding_distribution WHERE bidding_id = ? AND shop_id = ?',
    [biddingId, shopId]
  );

  if (distRows.length === 0) {
    const shops = await filterShopsForBidding(pool, biddingId, null);
    const shopInList = shops.find((s) => s.shop_id === shopId);
    if (!shopInList) return false;
    const config = await getBiddingDistributionConfig(pool);
    const scored = await assignTiers(pool, shops, biddingId, config);
    const shopScored = scored.find((s) => s.shop_id === shopId);
    if (!shopScored) return false;
    return checkTierVisibility(pool, biddingId, shopScored._tier);
  }

  const tier = distRows[0].tier;
  return checkTierVisibility(pool, biddingId, tier);
}

async function checkTierVisibility(pool, biddingId, tier) {
  const [biddingRows] = await pool.execute(
    'SELECT tier1_window_ends_at FROM biddings WHERE bidding_id = ?',
    [biddingId]
  );
  const tier1EndsAt = biddingRows[0]?.tier1_window_ends_at
    ? new Date(biddingRows[0].tier1_window_ends_at)
    : null;
  const now = new Date();

  if (tier === 1) return true;
  if (tier === 2) return !tier1EndsAt || now >= tier1EndsAt;
  if (tier === 3) {
    const [quoteCount] = await pool.execute(
      'SELECT COUNT(*) as c FROM quotes WHERE bidding_id = ? AND quote_status = 0',
      [biddingId]
    );
    const validQuotes = quoteCount[0]?.c || 0;
    return validQuotes < 3 && (!tier1EndsAt || now >= tier1EndsAt);
  }
  return false;
}

/**
 * 检查该店铺是否已收到某竞价的推送消息
 */
async function hasReceivedBiddingMessage(pool, shopId, biddingId) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM merchant_messages mm
     INNER JOIN merchant_users mu ON mm.merchant_id = mu.merchant_id AND mu.shop_id = ?
     WHERE mm.type = 'bidding' AND mm.related_id = ? LIMIT 1`,
    [shopId, biddingId]
  );
  return rows.length > 0;
}

/**
 * 为指定店铺补发第二、第三梯队竞价消息（首次请求时调用）
 * 当服务商打开待报价列表时，检查是否有已开放但未推送的竞价，补发消息
 */
async function sendDelayedBiddingMessagesForShop(pool, shopId) {
  const now = new Date();
  const [biddings] = await pool.execute(
    `SELECT b.bidding_id, bd.tier,
        (SELECT COUNT(*) FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.quote_status = 0) as valid_quotes
     FROM biddings b
     INNER JOIN bidding_distribution bd ON bd.bidding_id = b.bidding_id AND bd.shop_id = ?
     WHERE b.status = 0 AND b.expire_at > ?
       AND (b.tier1_window_ends_at IS NULL OR b.tier1_window_ends_at <= ?)
       AND bd.tier IN (2, 3)`,
    [shopId, now, now]
  );

  const toSend = [];
  for (const row of biddings || []) {
    if (row.tier === 3 && (row.valid_quotes || 0) >= 3) continue;
    const alreadySent = await hasReceivedBiddingMessage(pool, shopId, row.bidding_id);
    if (!alreadySent) toSend.push({ bidding_id: row.bidding_id, tier: row.tier });
  }

  for (const { bidding_id, tier } of toSend) {
    const title = tier === 2 ? '新竞价待报价（第二梯队）' : '新竞价待报价（第三梯队）';
    await sendBiddingMessagesToShops(pool, [shopId], bidding_id, title);
  }
  return toSend.length;
}

/**
 * 全量补发第二、第三梯队消息（定时任务调用）
 * 遍历所有进行中的竞价，向已开放但未推送的店铺补发
 */
async function sendAllDelayedBiddingMessages(pool) {
  const now = new Date();
  const [biddings] = await pool.execute(
    `SELECT b.bidding_id, b.tier1_window_ends_at,
        (SELECT COUNT(*) FROM quotes q WHERE q.bidding_id = b.bidding_id AND q.quote_status = 0) as valid_quotes
     FROM biddings b
     WHERE b.status = 0 AND b.expire_at > ?
       AND (b.tier1_window_ends_at IS NULL OR b.tier1_window_ends_at <= ?)`,
    [now, now]
  );

  let sentCount = 0;
  for (const row of biddings || []) {
    const [distRows] = await pool.execute(
      'SELECT shop_id, tier FROM bidding_distribution WHERE bidding_id = ? AND tier IN (2, 3)',
      [row.bidding_id]
    );
    for (const d of distRows || []) {
      if (d.tier === 3 && (row.valid_quotes || 0) >= 3) continue;
      const alreadySent = await hasReceivedBiddingMessage(pool, d.shop_id, row.bidding_id);
      if (!alreadySent) {
        const title = d.tier === 2 ? '新竞价待报价（第二梯队）' : '新竞价待报价（第三梯队）';
        await sendBiddingMessagesToShops(pool, [d.shop_id], row.bidding_id, title);
        sentCount++;
      }
    }
  }
  return sentCount;
}

module.exports = {
  getBiddingDistributionConfig,
  parseBiddingItemsWithComplexity,
  checkShopQualificationForBidding,
  hasSameProjectCompletion,
  filterShopsForBidding,
  calcMerchantMatchScore,
  assignTiers,
  sendBiddingMessagesToShops,
  runBiddingDistribution,
  isShopVisibleForBidding,
  sendDelayedBiddingMessagesForShop,
  sendAllDelayedBiddingMessages,
  DEFAULT_CONFIG,
};
