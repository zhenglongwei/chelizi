const axios = require('axios');
const crypto = require('crypto');

function randStr(len = 16) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

function sha1Hex(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex');
}

// 进程内缓存（足够MVP；多实例再上 Redis）
const cache = {
  accessToken: null,
  accessTokenExpAt: 0,
  jsapiTicket: null,
  jsapiTicketExpAt: 0,
};

async function getAccessToken(appId, secret) {
  const now = Date.now();
  if (cache.accessToken && cache.accessTokenExpAt > now + 60 * 1000) {
    return cache.accessToken;
  }
  const url =
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}` +
    `&secret=${encodeURIComponent(secret)}`;
  const res = await axios.get(url, { timeout: 15000 });
  const data = res.data || {};
  if (!data.access_token) {
    throw new Error(data.errmsg || '获取 access_token 失败');
  }
  cache.accessToken = data.access_token;
  const expiresIn = parseInt(data.expires_in, 10) || 7200;
  cache.accessTokenExpAt = now + expiresIn * 1000;
  return cache.accessToken;
}

async function getJsapiTicket(appId, secret) {
  const now = Date.now();
  if (cache.jsapiTicket && cache.jsapiTicketExpAt > now + 60 * 1000) {
    return cache.jsapiTicket;
  }
  const token = await getAccessToken(appId, secret);
  const url = `https://api.weixin.qq.com/cgi-bin/ticket/getticket?type=jsapi&access_token=${encodeURIComponent(token)}`;
  const res = await axios.get(url, { timeout: 15000 });
  const data = res.data || {};
  if (!data.ticket || data.errcode !== 0) {
    throw new Error(data.errmsg || '获取 jsapi_ticket 失败');
  }
  cache.jsapiTicket = data.ticket;
  const expiresIn = parseInt(data.expires_in, 10) || 7200;
  cache.jsapiTicketExpAt = now + expiresIn * 1000;
  return cache.jsapiTicket;
}

/**
 * 生成 wx.config 签名参数
 * @param {string} appId
 * @param {string} secret
 * @param {string} url - 当前页面完整URL（不含 hash）
 */
async function buildJssdkConfig(appId, secret, url) {
  const ticket = await getJsapiTicket(appId, secret);
  const nonceStr = randStr(16);
  const timestamp = Math.floor(Date.now() / 1000);
  const cleanUrl = String(url || '').split('#')[0];
  const signStr = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${cleanUrl}`;
  const signature = sha1Hex(signStr);
  return { appId, timestamp, nonceStr, signature };
}

module.exports = {
  buildJssdkConfig,
};

