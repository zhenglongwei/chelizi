/**
 * 报价全流程产品命名（与 web/api-server/utils/quote-nomenclature.js 语义一致）
 */

const QUOTE_STAGE_CODES = {
  BIDDING_PREQUOTE: 'bidding_prequote',
  SHOP_QUOTE_ROUND: 'shop_quote_round',
  FINAL_LOCKED: 'final_locked',
};

const QUOTE_LABELS = {
  biddingPrequoteFull: '预报价（首次·据照片与描述·无实物）',
  biddingPrequoteShort: '预报价',
  biddingPrequoteCaption:
    '依据您上传的照片与车辆情况描述，由服务商在车辆未到店时提交的首次报价（无实物检测）。',
  finalLockedFull: '确认报价（已锁价）',
  finalPendingConfirm: '确认报价（待您确认）',
  shopRoundScope: '到店后',
  preQuotePublicStatusText: '选厂时确定',
};

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function getShopNthQuoteLabel(revisionNo) {
  const r = Math.max(1, parseInt(revisionNo, 10) || 1);
  const overall = r + 1;
  let core;
  if (overall === 2) core = '二次报价';
  else if (overall <= 10) core = `${CN_NUM[overall]}次报价`;
  else core = `第${overall}次报价`;
  return `${core}（${QUOTE_LABELS.shopRoundScope}）`;
}

function getShopRoundStageCode(revisionNo) {
  const r = parseInt(revisionNo, 10) || 1;
  return `${QUOTE_STAGE_CODES.SHOP_QUOTE_ROUND}:${r}`;
}

function getProposalRoundsSummaryLabel(roundCount) {
  const n = Math.max(0, parseInt(roundCount, 10) || 0);
  if (n <= 0) return '';
  if (n === 1) return '含二次报价（到店后）';
  if (n === 2) return '含二次、三次报价（到店后）';
  const lastOverall = n + 1;
  if (lastOverall <= 10) return `含二次至${CN_NUM[lastOverall]}次报价（到店后）`;
  return `含二次至第${lastOverall}次报价（到店后）`;
}

module.exports = {
  QUOTE_STAGE_CODES,
  QUOTE_LABELS,
  getShopNthQuoteLabel,
  getShopRoundStageCode,
  getProposalRoundsSummaryLabel,
};
