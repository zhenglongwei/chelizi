#!/usr/bin/env node
/**
 * 订阅消息发送测试
 * 验证 .env 配置、access_token、模板 ID，并尝试发送一条测试消息
 *
 * 用法：cd web/api-server && node scripts/test-subscribe-message.js
 *
 * 前置条件：
 *   1. web/.env 已配置 WX_APPID、WX_SECRET、SUBSCRIBE_TEMPLATE_ID
 *   2. 数据库中有带真实 openid 的用户或服务商（非 test_openid_001）
 *   3. 该用户/服务商曾在小程序中授权过订阅消息
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const axios = require('axios');
const mysql = require('mysql2/promise');

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'zhejian',
};

async function getAccessToken(appId, appSecret) {
  const res = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
    params: { grant_type: 'client_credential', appid: appId, secret: appSecret },
  });
  const d = res.data;
  if (d.errcode) throw new Error(`获取 access_token 失败: ${d.errmsg || d.errcode}`);
  return d.access_token;
}

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
  return res.data;
}

async function main() {
  console.log('\n=== 订阅消息发送测试 ===\n');

  const appId = process.env.WX_APPID;
  const appSecret = process.env.WX_SECRET;
  const templateId = process.env.SUBSCRIBE_TEMPLATE_ID || process.env.SUBSCRIBE_TEMPLATE_ORDER_UPDATE;

  if (!appId || !appSecret) {
    console.log('✗ 未配置 WX_APPID 或 WX_SECRET');
    process.exit(1);
  }
  console.log('✓ WX_APPID、WX_SECRET 已配置');

  if (!templateId) {
    console.log('✗ 未配置 SUBSCRIBE_TEMPLATE_ID 或任一 SUBSCRIBE_TEMPLATE_*');
    process.exit(1);
  }
  console.log('✓ 模板 ID 已配置:', templateId.slice(0, 24) + '...');

  let pool;
  try {
    pool = await mysql.createPool(DB_CONFIG);
    await pool.execute('SELECT 1');
    console.log('✓ 数据库连接成功');
  } catch (err) {
    console.log('✗ 数据库连接失败:', err.message);
    process.exit(1);
  }

  const [userRows] = await pool.execute(
    "SELECT user_id, openid FROM users WHERE openid IS NOT NULL AND openid != '' AND openid != 'test_openid_001' LIMIT 1"
  );
  const [merchantRows] = await pool.execute(
    "SELECT merchant_id, openid FROM merchant_users WHERE openid IS NOT NULL AND openid != '' LIMIT 1"
  );

  const target = userRows[0] || merchantRows[0];
  if (!target) {
    console.log('\n⚠ 未找到可用的 openid：');
    console.log('  - 车主：需通过小程序微信登录');
    console.log('  - 服务商：需登录后进入工作台完成 openid 绑定');
    console.log('\n配置检查通过。请先用小程序登录/绑定后，再运行本测试。\n');
    await pool.end();
    process.exit(0);
  }

  const openid = target.openid;
  const role = userRows[0] ? '车主' : '服务商';
  console.log(`\n向 ${role} (openid: ${openid.slice(0, 12)}...) 发送测试消息...`);

  try {
    const token = await getAccessToken(appId, appSecret);
    console.log('✓ access_token 获取成功');

    const data = {
      thing1: { value: '【测试】订阅消息' },
      thing2: { value: '配置验证成功，请忽略。' },
      date1: { value: new Date().toLocaleString('zh-CN') },
    };
    const result = await sendSubscribeMessage(token, openid, templateId, data, 'pages/index/index');

    if (result.errcode === 0) {
      console.log('✓ 发送成功！请检查微信「服务通知」是否收到消息。');
    } else {
      const msg = {
        43101: '用户拒绝接收（未授权或已取消订阅）',
        40037: '模板 ID 无效',
        40001: 'access_token 无效或过期',
        41001: '缺少 openid',
      }[result.errcode] || result.errmsg || '未知错误';
      console.log(`✗ 发送失败 (errcode=${result.errcode}): ${msg}`);
      process.exit(1);
    }
  } catch (err) {
    console.log('✗ 请求异常:', err.message);
    process.exit(1);
  }

  await pool.end();
  console.log('\n测试完成。\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
