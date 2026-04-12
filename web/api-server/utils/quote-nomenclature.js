/**
 * 报价全流程产品命名（与小程序 utils/quote-nomenclature.js 语义一致）
 *
 * DB 映射（不新增列，仅口径）：
 * - quotes（竞价选中行）+ orders.quote_id → 预报价（首次·无实物）
 * - orders.pre_quote_snapshot → 双阶段下与选厂一致的预报价基准快照
 * - order_quote_proposals.revision_no（从 1 递增）→ 到店后报价；整体第 (revision_no+1) 次报价 → 二次、三次…
 * - orders.final_quote_snapshot + final_quote_status=2 → 确认报价（已锁价）
 */

const QUOTE_STAGE_CODES = {
  /** 竞价页 quotes 行 / 选厂成交行 */
  BIDDING_PREQUOTE: 'bidding_prequote',
  /** order_quote_proposals 每一行 */
  SHOP_QUOTE_ROUND: 'shop_quote_round',
  /** 车主已确认锁价 */
  FINAL_LOCKED: 'final_locked',
};

const QUOTE_LABELS = {
  /** C 端主标题、评价/订单对比左侧 */
  biddingPrequoteFull: '预报价（首次·据照片与描述·无实物）',
  biddingPrequoteShort: '预报价',
  /** 说明文案 */
  biddingPrequoteCaption:
    '依据您上传的照片与车辆情况描述，由服务商在车辆未到店时提交的首次报价（无实物检测）。',
  /** 双阶段锁价后 */
  finalLockedFull: '确认报价（已锁价）',
  /** 待车主点确认 */
  finalPendingConfirm: '确认报价（待您确认）',
  /** 接在多轮名称后 */
  shopRoundScope: '到店后',
  /** 报价公示列表首行（非 DB 行，无「车主确认」状态） */
  preQuotePublicStatusText: '选厂时确定',
};

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/**
 * 到店后第 revision_no 轮（DB 从 1 起）→ 产品名：整体第 (revision_no+1) 次报价
 * revision_no=1 → 二次报价；=2 → 三次报价
 */
function getShopNthQuoteLabel(revisionNo) {
  const r = Math.max(1, parseInt(revisionNo, 10) || 1);
  const overall = r + 1;
  let core;
  if (overall === 2) core = '二次报价';
  else if (overall <= 10) core = `${CN_NUM[overall]}次报价`;
  else core = `第${overall}次报价`;
  return `${core}（${QUOTE_LABELS.shopRoundScope}）`;
}

/** API 用：阶段码 + 序号，便于扩展 */
function getShopRoundStageCode(revisionNo) {
  const r = parseInt(revisionNo, 10) || 1;
  return `${QUOTE_STAGE_CODES.SHOP_QUOTE_ROUND}:${r}`;
}

/** 时间线摘要：到店 proposal 条数 n → 文案（预报价为整体第 1 次） */
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
