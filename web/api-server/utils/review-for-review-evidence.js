/**
 * 评价页 for-review：模块一「系统固化证据」分区 + 软提示
 */

const { isInsuranceOrder, reviewScene } = require('./review-objective-schema');
const { countShopQuoteProposalRows } = require('./quote-proposal-public-list');

function sectionItem(type, label, urls, meta) {
  const arr = Array.isArray(urls) ? urls.filter(Boolean) : [];
  const isImage = type === 'image';
  return {
    type,
    label,
    urls: arr,
    count: arr.length,
    missing: isImage && arr.length === 0,
    meta: meta || null
  };
}

/** 从维修/报价方案生成分项质保行（与订单约定一致） */
function buildWarrantyLinesFromPlan(plan) {
  if (!plan || !Array.isArray(plan.items) || plan.items.length === 0) return [];
  const lines = [];
  for (const it of plan.items) {
    const part = String(it.damage_part || it.name || it.item || '项目').trim() || '项目';
    const type = String(it.repair_type || '').trim() || '维修';
    const pts =
      it.repair_type === '换' && it.parts_type ? ` · ${String(it.parts_type).trim()}` : '';
    const wm = it.warranty_months;
    const wn = parseInt(wm, 10);
    const wmText = !Number.isNaN(wn) && wn >= 0 ? `${wn} 个月` : '未填写';
    lines.push(`${part}：${type}${pts} · 分项质保 ${wmText}`);
  }
  return lines;
}

/**
 * @param {object} ctx - beforeImages, merchantSettlement, merchantCompletion, merchantMaterials,
 *   quote_timeline, quote_proposal_history, orderVerification, order, lossAssessmentUrls,
 *   repairPlan, quotePlan, warrantyPhotos（completion_evidence 扩展字段，可选）
 */
function buildEvidenceSections(ctx) {
  const {
    beforeImages = [],
    merchantSettlement = [],
    merchantCompletion = [],
    merchantMaterials = [],
    quote_timeline = null,
    quote_proposal_history = [],
    orderVerification = null,
    order = {},
    lossAssessmentUrls = [],
    repairPlan = null,
    quotePlan = null,
    warrantyPhotos = []
  } = ctx;

  const shopProposalRounds = countShopQuoteProposalRows(quote_proposal_history);
  const hasAnyProposalRow = Array.isArray(quote_proposal_history) && quote_proposal_history.length > 0;

  const preQuoteItems = [];
  // 与下方「报价协商过程公示」去重：有公示列表（含合成预报价行）时不再塞一条点分摘要
  if (quote_timeline && quote_timeline.summary && !hasAnyProposalRow) {
    preQuoteItems.push(sectionItem('text', '本单价格与方案摘要', [], { text: quote_timeline.summary }));
  }
  preQuoteItems.push(
    sectionItem('image', '事故/车损照片（定损前）', beforeImages)
  );
  preQuoteItems.push(
    sectionItem('image', '结算单/票据（店端上传）', merchantSettlement)
  );

  const processItems = [sectionItem('image', '维修过程材料（新旧配件、施工等）', merchantMaterials)];
  // 有到店多轮报价时，轮次与明细已在公示卡展示，此处不再重复一行状态
  if (shopProposalRounds === 0) {
    processItems.push(
      sectionItem('mixed', '报价协商与变更记录', [], {
        proposal_rounds: 0,
        has_proposals: false
      })
    );
  }

  const deliveryItems = [
    sectionItem('image', '完工实拍（店端上传）', merchantCompletion)
  ];

  const warrantyItems = [];
  const planForWarranty = repairPlan && Array.isArray(repairPlan.items) && repairPlan.items.length ? repairPlan : quotePlan;
  const warrantyLines = buildWarrantyLinesFromPlan(planForWarranty);
  if (warrantyLines.length > 0) {
    warrantyItems.push(
      sectionItem('list', '分项质保约定', [], {
        lines: warrantyLines,
        hint: '以本单订单确认的维修/报价明细为准；由维修厂向您承担'
      })
    );
  } else {
    warrantyItems.push(
      sectionItem('list', '分项质保约定', [], {
        lines: ['暂无分项质保明细（订单未带明细分项质保月数）'],
        hint: null
      })
    );
  }

  const wPhotos = Array.isArray(warrantyPhotos) ? warrantyPhotos.filter(Boolean) : [];
  warrantyItems.push(sectionItem('image', '纸质或其它质保凭证（店端选传，补充）', wPhotos));
  if (orderVerification) {
    warrantyItems.push(
      sectionItem('text', '系统核验摘要', [], {
        settlement_match: orderVerification.settlement_match,
        warranty_informed: orderVerification.warranty_informed,
        on_time: orderVerification.on_time
      })
    );
  }

  const sections = [
    { id: 'pre_quote', title: '修前报价与约定', subtitle: '系统固化，供与客观题对照', items: preQuoteItems },
    { id: 'process', title: '维修过程', subtitle: '过程材料与协商留痕', items: processItems },
    { id: 'delivery', title: '修后交付', subtitle: '完工凭证', items: deliveryItems },
    { id: 'warranty', title: '售后质保', subtitle: '分项质保约定与核验摘要', items: warrantyItems }
  ];

  const accident = isInsuranceOrder(order);
  if (accident) {
    sections.push({
      id: 'accident_docs',
      title: '事故车相关凭证',
      subtitle: '定损单等（若有）',
      items: [sectionItem('image', '定损/保险相关材料', lossAssessmentUrls)]
    });
  }

  return { sections, review_scene: reviewScene(order) };
}

function buildObjectiveHints(order, orderVerification) {
  const hints = [];
  const quotedNum = parseFloat(order.quoted_amount) || 0;
  const actualNum = parseFloat(order.actual_amount) || 0;
  if (quotedNum > 0 && Math.abs(actualNum - quotedNum) / quotedNum > 0.1) {
    hints.push({
      code: 'settlement_mismatch',
      text:
        '预报价与到店后的确认报价、结算金额不同，在拆检后很常见；二次、三次报价之间也可能有调整，与当前流程设计一致。相关偏离度会参与店铺专业度与报价相关评分，用于排序及后续竞价参考，不代表平台认定商家恶意或虚假报价。请按实际支付情况如实选择客观题即可。'
    });
  }
  if (orderVerification && orderVerification.warranty_informed === false) {
    hints.push({
      code: 'warranty_weak',
      text: '系统未识别到完整分项质保信息。客观题「分项质保约定」请对照本单订单方案/报价明细中的质保月数填写，确保真实。'
    });
  }
  return hints;
}

module.exports = {
  buildEvidenceSections,
  buildObjectiveHints
};
