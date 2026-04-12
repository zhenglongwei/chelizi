/**
 * 小程序订阅消息服务
 * 在创建 user_messages / merchant_messages 时，同步发送微信订阅消息
 * 需在 mp.weixin.qq.com 订阅消息中选用模板，并将 template_id 配置到 .env
 *
 * 微信「一次性订阅」规则（与长期订阅不同）：
 * - 用户每次在小程序内点「允许」授权某模板，通常仅增加有限次数（多为 1 次）下发额度；
 * - 同一模板多次下发需用户多次授权，不能只靠「发起竞价时授权一次」覆盖后续每一次新报价；
 * - errcode 43101 等表示用户拒绝、额度已用尽或未订阅。业务上应配合站内消息（user_messages）等兜底。
 */

const axios = require('axios');

const LOG_PREFIX = '[subscribe-msg]';

// access_token 缓存（约 2 小时有效，提前 5 分钟刷新）
let _accessToken = null;
let _accessTokenExpire = 0;

/**
 * 获取小程序 access_token
 */
async function getAccessToken(appId, appSecret) {
  if (_accessToken && Date.now() < _accessTokenExpire) {
    return _accessToken;
  }
  const res = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
    params: { grant_type: 'client_credential', appid: appId, secret: appSecret },
  });
  const data = res.data;
  if (data.errcode) {
    throw new Error(`获取 access_token 失败: ${data.errmsg || data.errcode}`);
  }
  _accessToken = data.access_token;
  _accessTokenExpire = Date.now() + (data.expires_in || 7200 - 300) * 1000;
  return _accessToken;
}

/**
 * 发送订阅消息
 * @param {string} accessToken
 * @param {string} openid - 用户 openid
 * @param {string} templateId - 模板 ID
 * @param {object} data - 模板数据，格式 { key1: { value: 'xxx' }, key2: { value: 'xxx' } }
 * @param {string} [page] - 点击跳转的小程序页面路径，如 pages/order/detail/index?id=xxx
 * @returns {Promise<{ ok: boolean, errcode?: number, errmsg?: string }>}
 */
async function sendSubscribeMessage(accessToken, openid, templateId, data, page) {
  const body = {
    touser: openid,
    template_id: templateId,
    data,
    miniprogram_state: process.env.NODE_ENV === 'production' ? 'formal' : 'developer',
  };
  if (page) body.page = page;

  const res = await axios.post(
    `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${accessToken}`,
    body
  );
  const d = res.data;
  if (d.errcode === 0) return { ok: true };
  return { ok: false, errcode: d.errcode, errmsg: d.errmsg };
}

/** 统一模板 ID（当 5 种消息共用同一模板时，.env 只需配置此项） */
const UNIFIED_TEMPLATE_ID = process.env.SUBSCRIBE_TEMPLATE_ID;

/**
 * 获取模板 ID：优先用类型专属变量，否则用统一模板
 */
function getTemplateId(envKey) {
  return process.env[envKey] || UNIFIED_TEMPLATE_ID;
}

/**
 * 日期/时间格式化：与 test-subscribe-message.js 保持一致
 * 微信 date 支持 yyyy-MM-dd、yyyy/MM/dd 等
 */
function formatDateForTemplate() {
  return new Date().toLocaleString('zh-CN');
}

/**
 * 模板配置：消息类型 -> { templateId 环境变量名, 构建 data 的函数 }
 * 仅传递模板实际含有的关键词，多余参数会导致 data format error
 * thing1(订单状态/结果)、thing2(温馨提醒)、date1(变更时间) - 适用于「订单状态变更提醒」类模板
 */
// 订单状态限 5 字，温馨提醒限 20 字，便于用户一眼看懂并点击
const STATUS_MAX = 5;
const REMINDER_MAX = 20;

const TEMPLATE_CONFIG = {
  // 车主端
  user_order_update: {
    envKey: 'SUBSCRIBE_TEMPLATE_ORDER_UPDATE',
    buildData: (payload) => ({
      thing1: { value: (payload.title || '方案待确认').slice(0, STATUS_MAX) },
      thing2: { value: (payload.content || '请前往订单详情确认').slice(0, REMINDER_MAX) },
      date1: { value: payload.date || formatDateForTemplate() },
    }),
    page: (payload) => `pages/order/detail/index?id=${payload.relatedId || ''}`,
  },
  user_bidding_quote: {
    envKey: 'SUBSCRIBE_TEMPLATE_BIDDING_QUOTE',
    buildData: (payload) => ({
      thing1: { value: (payload.title || '您有新报价').slice(0, STATUS_MAX) },
      thing2: { value: (payload.content || '请前往竞价详情查看').slice(0, REMINDER_MAX) },
      date1: { value: payload.date || formatDateForTemplate() },
    }),
    page: (payload) => `pages/bidding/detail/index?id=${payload.relatedId || ''}`,
  },

  // 服务商端
  merchant_bidding_new: {
    envKey: 'SUBSCRIBE_TEMPLATE_BIDDING_NEW',
    buildData: (payload) => ({
      thing1: { value: (payload.title || '新竞价待报价').slice(0, STATUS_MAX) },
      thing2: { value: (payload.content || '请尽快报价').slice(0, REMINDER_MAX) },
      date1: { value: payload.date || formatDateForTemplate() },
    }),
    page: (payload) => `pages/merchant/bidding/detail/index?id=${payload.relatedId || ''}`,
  },
  merchant_order_new: {
    envKey: 'SUBSCRIBE_TEMPLATE_ORDER_NEW',
    buildData: (payload) => ({
      thing1: { value: (payload.title || '新订单已生成').slice(0, STATUS_MAX) },
      thing2: { value: (payload.content || '请按方案维修').slice(0, REMINDER_MAX) },
      date1: { value: payload.date || formatDateForTemplate() },
    }),
    page: (payload) => `pages/merchant/order/detail/index?id=${payload.relatedId || ''}`,
  },
  merchant_qualification_audit: {
    envKey: 'SUBSCRIBE_TEMPLATE_QUALIFICATION_AUDIT',
    buildData: (payload) => ({
      thing1: { value: (payload.title || '审核结果').slice(0, STATUS_MAX) },
      thing2: { value: (payload.content || '请前往店铺查看').slice(0, REMINDER_MAX) },
      date1: { value: payload.date || formatDateForTemplate() },
    }),
    page: (payload) => 'pages/merchant/shop/profile/index',
  },
  merchant_commission_alert: {
    envKey: 'SUBSCRIBE_TEMPLATE_COMMISSION_ALERT',
    buildData: (payload) => ({
      thing1: { value: (payload.title || '佣金提醒').slice(0, STATUS_MAX) },
      thing2: { value: (payload.content || '请前往佣金账户处理').slice(0, REMINDER_MAX) },
      date1: { value: payload.date || formatDateForTemplate() },
    }),
    page: (_payload) => 'pages/merchant/commission/index',
  },
  merchant_material_audit: {
    envKey: 'SUBSCRIBE_TEMPLATE_MATERIAL_AUDIT',
    // 模板字段映射：phrase2=订单状态(5字)、thing4=温馨提醒(20字)
    buildData: (payload) => {
      const title = (payload.title || '审核结果').slice(0, STATUS_MAX);
      const content = (payload.content || '请前往订单详情查看').slice(0, REMINDER_MAX);
      const now = new Date();
      const date = payload.date || now.toLocaleDateString('zh-CN');
      const time = now.toTimeString().slice(0, 8);
      const fallback = '点击查看';
      return {
        thing1: { value: title },
        thing2: { value: content },
        thing3: { value: (payload.relatedId ? '订单' + String(payload.relatedId).slice(-8) : fallback).slice(0, 20) },
        thing4: { value: content },
        phrase1: { value: content.slice(0, 5) || fallback.slice(0, 5) },
        phrase2: { value: title },
        date1: { value: date },
        time1: { value: time },
        time2: { value: time },
        time3: { value: time },
        time4: { value: time },
        time5: { value: time },
      };
    },
    page: (payload) => `pages/merchant/order/detail/index?id=${payload.relatedId || ''}`,
  },
};

/**
 * 向车主发送订阅消息
 * @param {object} pool - 数据库连接池
 * @param {string} userId - 用户 ID
 * @param {string} templateKey - 模板配置键，如 user_order_update
 * @param {object} payload - { title, content, relatedId, date }
 * @param {string} appId
 * @param {string} appSecret
 */
async function sendToUser(pool, userId, templateKey, payload, appId, appSecret) {
  if (!appId || !appSecret) {
    console.warn(`${LOG_PREFIX} sendToUser ${templateKey} skip: 未配置 WX_APPID/WX_SECRET`);
    return;
  }
  const cfg = TEMPLATE_CONFIG[templateKey];
  if (!cfg) {
    console.warn(`${LOG_PREFIX} sendToUser ${templateKey} skip: 未知模板键`);
    return;
  }
  const templateId = getTemplateId(cfg.envKey);
  if (!templateId) {
    console.warn(
      `${LOG_PREFIX} sendToUser ${templateKey} skip: 未配置模板ID（${cfg.envKey} 或 SUBSCRIBE_TEMPLATE_ID）`
    );
    return;
  }

  const [rows] = await pool.execute('SELECT openid FROM users WHERE user_id = ?', [userId]);
  if (!rows.length || !rows[0].openid) {
    console.warn(`${LOG_PREFIX} sendToUser ${templateKey} skip: user_id=${userId} 无 openid（用户需曾微信登录）`);
    return;
  }

  try {
    const token = await getAccessToken(appId, appSecret);
    const data = cfg.buildData(payload || {});
    const page = cfg.page ? cfg.page(payload || {}) : undefined;
    const result = await sendSubscribeMessage(token, rows[0].openid, templateId, data, page);
    if (!result.ok) {
      console.warn(
        `${LOG_PREFIX} sendToUser ${templateKey} err:`,
        result.errcode,
        result.errmsg,
        '(43101=拒收/无额度；一次性订阅每授权通常仅 1 条)'
      );
    } else {
      console.log(`${LOG_PREFIX} sendToUser ${templateKey} ok user_id=${userId}`);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} sendToUser ${templateKey} error:`, err.message);
  }
}

/**
 * 向服务商发送订阅消息
 * @param {object} pool - 数据库连接池
 * @param {string} merchantId - 服务商 ID
 * @param {string} templateKey - 模板配置键
 * @param {object} payload - { title, content, relatedId, date }
 * @param {string} appId
 * @param {string} appSecret
 */
async function sendToMerchant(pool, merchantId, templateKey, payload, appId, appSecret) {
  if (!appId || !appSecret) {
    console.warn(`${LOG_PREFIX} sendToMerchant ${templateKey} skip: 未配置 WX_APPID/WX_SECRET`);
    return;
  }
  const cfg = TEMPLATE_CONFIG[templateKey];
  if (!cfg) return;
  const templateId = getTemplateId(cfg.envKey);
  if (!templateId) {
    console.warn(`${LOG_PREFIX} sendToMerchant ${templateKey} skip: 未配置模板ID (SUBSCRIBE_TEMPLATE_MATERIAL_AUDIT 或 SUBSCRIBE_TEMPLATE_ID)`);
    return;
  }

  const [rows] = await pool.execute('SELECT openid FROM merchant_users WHERE merchant_id = ?', [merchantId]);
  if (!rows.length || !rows[0].openid) {
    console.warn(`${LOG_PREFIX} sendToMerchant ${templateKey} skip: merchant_id=${merchantId} 无 openid`);
    return;
  }

  try {
    const token = await getAccessToken(appId, appSecret);
    const data = cfg.buildData(payload || {});
    const page = cfg.page ? cfg.page(payload || {}) : undefined;
    const result = await sendSubscribeMessage(token, rows[0].openid, templateId, data, page);
    if (!result.ok) {
      console.warn(`${LOG_PREFIX} sendToMerchant ${templateKey} err:`, result.errcode, result.errmsg, 'payload=', JSON.stringify(payload));
    } else {
      console.log(`${LOG_PREFIX} sendToMerchant ${templateKey} ok`);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} sendToMerchant ${templateKey} error:`, err.message);
  }
}

/**
 * 向多个服务商批量发送（如竞价分发）
 */
async function sendToMerchantsByShopIds(pool, shopIds, templateKey, payload, appId, appSecret) {
  if (!shopIds?.length) return;
  const [rows] = await pool.execute(
    `SELECT merchant_id FROM merchant_users WHERE shop_id IN (${shopIds.map(() => '?').join(',')}) AND status = 1 AND openid IS NOT NULL`,
    shopIds
  );
  for (const r of rows || []) {
    await sendToMerchant(pool, r.merchant_id, templateKey, payload, appId, appSecret);
  }
}

module.exports = {
  sendToUser,
  sendToMerchant,
  sendToMerchantsByShopIds,
  TEMPLATE_CONFIG,
};
