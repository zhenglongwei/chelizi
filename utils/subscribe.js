/**
 * 小程序订阅消息工具
 * 在适当时机调用 wx.requestSubscribeMessage 获取用户授权
 * 模板 ID 需在 mp.weixin.qq.com 订阅消息中选用，并配置到 config.js
 */

const config = require('../config.js');

// 模板 ID 配置，需与 mp.weixin.qq.com 中选用的模板一致
// 在微信公众平台 功能 -> 订阅消息 -> 选用模板 获取
const TEMPLATE_IDS = config.SUBSCRIBE_TEMPLATE_IDS || {};

/**
 * 请求订阅授权（车主端）
 * @param {string} scene - 场景：order_update | bidding_quote | review_remind
 * @returns {Promise<boolean>} 是否已授权（用户同意或已勾选总是保持）
 */
function requestUserSubscribe(scene) {
  const map = {
    order_update: TEMPLATE_IDS.user_order_update || TEMPLATE_IDS.order_update,
    bidding_quote: TEMPLATE_IDS.user_bidding_quote || TEMPLATE_IDS.user_order_update,
    review_remind: TEMPLATE_IDS.user_order_update || TEMPLATE_IDS.order_update,
  };
  const tmplId = map[scene] || TEMPLATE_IDS.user_order_update || TEMPLATE_IDS.order_update;
  if (!tmplId) return Promise.resolve(false);
  return requestSubscribe([tmplId]);
}

/**
 * 请求订阅授权（服务商端）
 * @param {string} scene - 场景：bidding_new | order_new | qualification_audit | material_audit
 * @returns {Promise<boolean>}
 */
function requestMerchantSubscribe(scene) {
  const map = {
    bidding_new: TEMPLATE_IDS.merchant_bidding_new || TEMPLATE_IDS.bidding_new,
    order_new: TEMPLATE_IDS.merchant_order_new || TEMPLATE_IDS.order_new,
    qualification_audit: TEMPLATE_IDS.merchant_qualification_audit || TEMPLATE_IDS.qualification_audit,
    material_audit: TEMPLATE_IDS.merchant_material_audit || TEMPLATE_IDS.material_audit,
    commission_alert: TEMPLATE_IDS.merchant_commission_alert || TEMPLATE_IDS.merchant_order_new,
  };
  const tmplId = map[scene];
  if (!tmplId) return Promise.resolve(false);
  return requestSubscribe([tmplId]);
}

/**
 * 请求多个模板订阅（用于一次弹窗订阅多种消息）
 */
function requestSubscribe(tmplIds) {
  if (!tmplIds || tmplIds.length === 0) return Promise.resolve(false);
  const valid = tmplIds.filter(Boolean);
  if (valid.length === 0) return Promise.resolve(false);

  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: valid,
      success: (res) => {
        const accepted = valid.some((id) => res[id] === 'accept' || res[id] === 'acceptWithAudio' || res[id] === 'acceptWithAlert');
        resolve(accepted);
      },
      fail: () => resolve(false),
    });
  });
}

module.exports = {
  requestUserSubscribe,
  requestMerchantSubscribe,
  requestSubscribe,
  TEMPLATE_IDS,
};
