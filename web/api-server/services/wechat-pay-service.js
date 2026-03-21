/**
 * 微信支付 APIv3（JSAPI、支付回调验签、申请退款）
 * 依赖环境变量：WECHAT_PAY_MCHID, WECHAT_PAY_SERIAL_NO, WECHAT_PAY_API_V3_KEY,
 * WECHAT_PAY_PRIVATE_KEY 或 WECHAT_PAY_PRIVATE_KEY_PATH,
 * WECHAT_PAY_PLATFORM_PUBLIC_KEY 或 WECHAT_PAY_PLATFORM_CERT_PATH（回调验签，建议配置）
 * 与小程序 WX_APPID 一致
 */

const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');

const BASE = 'https://api.mch.weixin.qq.com';

function getPrivateKey() {
  const pem = process.env.WECHAT_PAY_PRIVATE_KEY;
  if (pem && pem.includes('BEGIN')) {
    return pem.replace(/\\n/g, '\n');
  }
  const p = process.env.WECHAT_PAY_PRIVATE_KEY_PATH;
  if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return null;
}

function getPlatformPublicKey() {
  const pem = process.env.WECHAT_PAY_PLATFORM_PUBLIC_KEY;
  if (pem && pem.includes('BEGIN')) return pem.replace(/\\n/g, '\n');
  const p = process.env.WECHAT_PAY_PLATFORM_CERT_PATH;
  if (p && fs.existsSync(p)) {
    const buf = fs.readFileSync(p, 'utf8');
    return buf;
  }
  return null;
}

function isConfigured() {
  return !!(
    process.env.WECHAT_PAY_MCHID &&
    process.env.WECHAT_PAY_SERIAL_NO &&
    process.env.WECHAT_PAY_API_V3_KEY &&
    getPrivateKey() &&
    process.env.WX_APPID
  );
}

function buildAuthorization(method, urlPath, bodyStr, mchid, serialNo, privateKeyPem) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${bodyStr}\n`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  sign.end();
  const signature = sign.sign(privateKeyPem, 'base64');
  const token = [
    `mchid="${mchid}"`,
    `nonce_str="${nonceStr}"`,
    `timestamp="${timestamp}"`,
    `serial_no="${serialNo}"`,
    `signature="${signature}"`,
  ].join(',');
  return `WECHATPAY2-SHA256-RSA2048 ${token}`;
}

function firstCertificatePem(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  return m ? m[0] : null;
}

/** 用于加密敏感字段（如收款人姓名）：从平台证书取公钥 */
function getPlatformPublicKeyForEncrypt() {
  const raw = getPlatformPublicKey();
  if (!raw) return null;
  const certPem = firstCertificatePem(raw) || (raw.includes('BEGIN CERTIFICATE') ? raw : null);
  if (certPem) {
    try {
      const x509 = new crypto.X509Certificate(certPem);
      return x509.publicKey.export({ type: 'spki', format: 'pem' });
    } catch (_) {
      return null;
    }
  }
  if (raw.includes('BEGIN PUBLIC KEY') || raw.includes('BEGIN RSA PUBLIC KEY')) {
    return raw.replace(/\\n/g, '\n');
  }
  return null;
}

/** 请求头 Wechatpay-Serial：微信平台证书序列号或公钥 ID */
function getWechatPlatformEncryptSerial() {
  const env = process.env.WECHAT_PAY_ENCRYPT_SERIAL || process.env.WECHAT_PAY_PLATFORM_ENCRYPT_SERIAL;
  if (env && String(env).trim()) return String(env).trim();
  const p = process.env.WECHAT_PAY_PLATFORM_CERT_PATH;
  if (p && fs.existsSync(p)) {
    try {
      const pem = fs.readFileSync(p, 'utf8');
      const certPem = firstCertificatePem(pem);
      if (certPem) {
        const x509 = new crypto.X509Certificate(certPem);
        return String(x509.serialNumber || '').replace(/:/g, '').toUpperCase();
      }
    } catch (_) {}
  }
  return '';
}

/** 敏感信息加密（与官方 Java OAEPWithSHA-1AndMGF1Padding 对齐） */
function encryptSensitiveWithWechatPlatformPub(plain) {
  const pem = getPlatformPublicKeyForEncrypt();
  if (!pem) return null;
  const buf = crypto.publicEncrypt(
    {
      key: pem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha1',
    },
    Buffer.from(String(plain).trim(), 'utf8')
  );
  return buf.toString('base64');
}

async function requestV3(method, urlPath, bodyObj, extraHeaders = {}) {
  const pk = getPrivateKey();
  if (!pk) throw new Error('未配置 WECHAT_PAY_PRIVATE_KEY(_PATH)');
  const mchid = process.env.WECHAT_PAY_MCHID;
  const serial = process.env.WECHAT_PAY_SERIAL_NO;
  const upper = String(method).toUpperCase();
  const bodyStr =
    upper === 'GET' || upper === 'HEAD' ? '' : bodyObj === undefined || bodyObj === null ? '{}' : JSON.stringify(bodyObj);
  const auth = buildAuthorization(method, urlPath, bodyStr, mchid, serial, pk);
  const cfg = {
    method,
    url: BASE + urlPath,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: auth,
      'User-Agent': 'chelizi-api-server',
      ...extraHeaders,
    },
    validateStatus: () => true,
  };
  if (bodyStr !== '') cfg.data = bodyStr;
  const res = await axios(cfg);
  if (res.status >= 200 && res.status < 300) return res.data;
  const err = new Error(res.data?.message || res.data?.code || `WeChatPay HTTP ${res.status}`);
  err.detail = res.data;
  err.status = res.status;
  throw err;
}

/**
 * JSAPI 下单
 * @returns {{ prepay_id: string }}
 */
async function jsapiPrepay({ description, outTradeNo, amountFen, openid, notifyUrl }) {
  const appid = process.env.WX_APPID;
  const mchid = process.env.WECHAT_PAY_MCHID;
  const body = {
    appid,
    mchid,
    description: (description || '车厘子佣金').slice(0, 127),
    out_trade_no: outTradeNo,
    notify_url: notifyUrl,
    amount: { total: amountFen, currency: 'CNY' },
    payer: { openid },
  };
  return requestV3('POST', '/v3/pay/transactions/jsapi', body);
}

/**
 * 小程序调起支付参数
 */
function buildMiniProgramPayParams(prepayId) {
  const appid = process.env.WX_APPID;
  const pk = getPrivateKey();
  if (!pk) throw new Error('未配置商户私钥');
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const pkg = `prepay_id=${prepayId}`;
  const message = `${appid}\n${timeStamp}\n${nonceStr}\n${pkg}\n`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  sign.end();
  const paySign = sign.sign(pk, 'base64');
  return {
    timeStamp,
    nonceStr,
    package: pkg,
    signType: 'RSA',
    paySign,
  };
}

function decryptNotifyResource(resource) {
  const { ciphertext, associated_data, nonce } = resource;
  const key = Buffer.from(process.env.WECHAT_PAY_API_V3_KEY, 'utf8');
  if (key.length !== 32) throw new Error('WECHAT_PAY_API_V3_KEY 须为32字节');
  const buf = Buffer.from(ciphertext, 'base64');
  const authTag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'utf8'));
  if (associated_data != null && associated_data !== '') {
    decipher.setAAD(Buffer.from(String(associated_data), 'utf8'));
  }
  decipher.setAuthTag(authTag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

function verifyNotifySignature(headers, rawBody) {
  const platformPub = getPlatformPublicKey();
  if (!platformPub) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[wechat-pay] 生产环境未配置 WECHAT_PAY_PLATFORM_PUBLIC_KEY，跳过验签');
    }
    return true;
  }
  const signature = headers['wechatpay-signature'];
  const timestamp = headers['wechatpay-timestamp'];
  const nonce = headers['wechatpay-nonce'];
  if (!signature || !timestamp || !nonce) return false;
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  const verify = crypto.createVerify('RSA-SHA256');
  verify.update(message);
  verify.end();
  return verify.verify(platformPub, signature, 'base64');
}

/**
 * 申请退款
 */
async function refund({ outTradeNo, outRefundNo, reason, refundFen, totalFen }) {
  const body = {
    out_trade_no: outTradeNo,
    out_refund_no: outRefundNo,
    reason: (reason || '佣金账户退款').slice(0, 80),
    notify_url: process.env.WECHAT_PAY_REFUND_NOTIFY_URL || undefined,
    amount: {
      refund: refundFen,
      total: totalFen,
      currency: 'CNY',
    },
  };
  if (!body.notify_url) delete body.notify_url;
  return requestV3('POST', '/v3/refund/domestic/refunds', body);
}

/**
 * 商家转账到零钱（用户确认模式）- 发起转账单
 * @see https://pay.weixin.qq.com/doc/v3/merchant/4012716434
 * @param {object} opts
 * @param {string} opts.outBillNo 商户单号，与 withdrawals.withdraw_id 一致
 * @param {string} opts.openid 收款用户 openid（小程序 appid 下）
 * @param {number} opts.transferAmountFen 金额（分）
 * @param {string} opts.notifyUrl HTTPS 回调完整地址
 * @param {string} [opts.transferRemark]
 * @param {string} [opts.userRecvPerception] 用户端展示，如「活动奖励」
 * @param {string} [opts.transferSceneId] 默认 1000 现金营销
 * @param {Array<{info_type:string,info_content:string}>} [opts.transferSceneReportInfos]
 */
async function createTransferBill(opts) {
  const appid = process.env.WX_APPID;
  const {
    outBillNo,
    openid,
    transferAmountFen,
    notifyUrl,
    transferRemark = '奖励金提现',
    userRecvPerception = '活动奖励',
    transferSceneId = process.env.WECHAT_TRANSFER_SCENE_ID || '1000',
    transferSceneReportInfos,
    userNamePlain,
  } = opts;
  const body = {
    appid,
    out_bill_no: outBillNo,
    transfer_scene_id: String(transferSceneId),
    openid,
    transfer_amount: transferAmountFen,
    transfer_remark: String(transferRemark).slice(0, 32),
    notify_url: notifyUrl,
    user_recv_perception: String(userRecvPerception).slice(0, 32),
    transfer_scene_report_infos: transferSceneReportInfos || [],
  };
  const extraHeaders = {};
  if (userNamePlain) {
    const enc = encryptSensitiveWithWechatPlatformPub(userNamePlain);
    const wSerial = getWechatPlatformEncryptSerial();
    if (!enc || !wSerial) {
      throw new Error(
        '单笔≥2000元需传收款姓名加密：请配置 WECHAT_PAY_PLATFORM_CERT_PATH 或 WECHAT_PAY_PLATFORM_PUBLIC_KEY，并设置 WECHAT_PAY_ENCRYPT_SERIAL（或公钥 ID）'
      );
    }
    body.user_name = enc;
    extraHeaders['Wechatpay-Serial'] = wSerial;
  }
  return requestV3('POST', '/v3/fund-app/mch-transfer/transfer-bills', body, extraHeaders);
}

/** @see https://pay.weixin.qq.com/doc/v3/merchant/4012716437 */
async function getTransferBillByOutNo(outBillNo) {
  const enc = encodeURIComponent(outBillNo);
  return requestV3('GET', `/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/${enc}`);
}

/** @see https://pay.weixin.qq.com/doc/v3/merchant/4012716458 */
async function cancelTransferBillByOutNo(outBillNo) {
  const enc = encodeURIComponent(outBillNo);
  return requestV3('POST', `/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/${enc}/cancel`, {});
}

function isTransferBillConfigured() {
  return isConfigured();
}

module.exports = {
  isConfigured,
  isTransferBillConfigured,
  jsapiPrepay,
  buildMiniProgramPayParams,
  decryptNotifyResource,
  verifyNotifySignature,
  refund,
  createTransferBill,
  getTransferBillByOutNo,
  cancelTransferBillByOutNo,
  encryptSensitiveWithWechatPlatformPub,
  getWechatPlatformEncryptSerial,
};
