/**
 * 小程序配置
 * 与 web/.env 中的服务器配置对应，小程序和网页后台共用同一阿里云 api-server
 *
 * 微信合法域名要求 HTTPS，BASE_URL 需与微信后台配置的 request 合法域名一致
 *
 * 本地/云端切换：在 web/.env 设置 ZHEJIAN_MINIPROGRAM=local|cloud，项目根目录执行
 * npm run sync:config，将生成 config.local.js（勿手改）。local 时须在开发者工具关闭域名校验。
 *
 * 订阅消息：在 mp.weixin.qq.com 功能->订阅消息 选用模板后，将模板 ID 填入此处
 * 同时需在 web/.env 配置对应变量（SUBSCRIBE_TEMPLATE_ORDER_UPDATE 等）
 */

const defaults = {
  BASE_URL: 'https://simplewin.cn',

  /** 订阅消息模板 ID（在微信公众平台选用后填入，与 .env 保持一致） */
  SUBSCRIBE_TEMPLATE_IDS: {
    user_order_update: 'QMnR-hGBLTi1FL9602l5LU-y0mEfY667yxl9586UzS4',      // 车主：维修方案已更新
    user_bidding_quote: 'QMnR-hGBLTi1FL9602l5LU-y0mEfY667yxl9586UzS4',     // 车主：新报价提醒（可与 order_update 共用模板）
    merchant_bidding_new: 'QMnR-hGBLTi1FL9602l5LU-y0mEfY667yxl9586UzS4',    // 服务商：新竞价待报价
    merchant_order_new: 'QMnR-hGBLTi1FL9602l5LU-y0mEfY667yxl9586UzS4',      // 服务商：新订单已生成（竞价流程自动接单）
    merchant_qualification_audit: 'QMnR-hGBLTi1FL9602l5LU-y0mEfY667yxl9586UzS4',  // 服务商：资质审核结果
    merchant_material_audit: 'QMnR-hGBLTi1FL9602l5LU-y0mEfY667yxl9586UzS4',       // 服务商：材料审核结果
    merchant_commission_alert: 'QMnR-hGBLTi1FL9602l5LU-y0mEfY667yxl9586UzS4',   // 服务商：佣金/余额提醒（可与上列共用模板）
  },
};

const local = require('./config.local.js');

module.exports = { ...defaults, ...local };
