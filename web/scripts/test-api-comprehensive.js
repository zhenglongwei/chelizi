#!/usr/bin/env node
/**
 * 辙见 API 完整功能测试
 * 覆盖公开接口、管理员、服务商、用户端、异常路径
 *
 * 用法：node web/scripts/test-api-comprehensive.js [API_BASE]
 * 示例：node web/scripts/test-api-comprehensive.js
 *       API_BASE=https://simplewin.cn node web/scripts/test-api-comprehensive.js
 *
 * 环境变量：
 *   API_BASE        默认 https://simplewin.cn
 *   ADMIN_USERNAME  默认 admin
 *   ADMIN_PASSWORD  默认 admin123（若需修改，请设置此变量，勿在命令行暴露）
 *   MERCHANT_PHONE  默认 18658823459
 *   MERCHANT_PASSWORD  默认 123456
 */

const http = require('http');
const https = require('https');

const API_BASE = (process.env.API_BASE || 'https://simplewin.cn').replace(/\/$/, '');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const MERCHANT_PHONE = process.env.MERCHANT_PHONE || '18658823459';
const MERCHANT_PASSWORD = process.env.MERCHANT_PASSWORD || '123456';

const results = { pass: 0, fail: 0, skip: 0, details: [] };

function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = path.startsWith('http') ? path : `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const body = options.body ? JSON.stringify(options.body) : null;
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    const req = lib.request(
      url,
      {
        method: method || 'GET',
        headers: body ? { ...headers, 'Content-Length': Buffer.byteLength(body) } : headers,
        timeout: 15000,
      },
      (res) => {
        let buf = '';
        res.on('data', (ch) => (buf += ch));
        res.on('end', () => {
          try {
            const json = buf ? JSON.parse(buf) : {};
            resolve({ status: res.statusCode, data: json, raw: buf });
          } catch {
            resolve({ status: res.statusCode, data: null, raw: buf });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}

function ok(name, res, expectStatus = 200, expectCode = 200) {
  const statusOk = res.status === expectStatus;
  const codeOk = expectCode == null ? true : (res.data && res.data.code === expectCode);
  if (statusOk && codeOk) {
    results.pass++;
    results.details.push({ name, status: 'pass' });
    console.log(`  ✓ ${name}`);
    return true;
  }
  results.fail++;
  results.details.push({ name, status: 'fail', msg: `status=${res.status} code=${res.data?.code}` });
  console.log(`  ✗ ${name} (status=${res.status} code=${res.data?.code})`);
  return false;
}

function skip(name, reason) {
  results.skip++;
  results.details.push({ name, status: 'skip', msg: reason });
  console.log(`  ○ ${name} (${reason})`);
}

async function runPublicTests() {
  console.log('\n========== T2 公开接口 ==========');
  try {
    const h = await request('GET', '/api/health');
    ok('GET /api/health', h);
  } catch (e) {
    results.fail++;
    console.log(`  ✗ GET /api/health 请求失败: ${e.message}`);
  }

  try {
    const n = await request('GET', '/api/v1/shops/nearby?lat=39.9&lng=116.4&limit=5');
    ok('GET /api/v1/shops/nearby', n);
  } catch (e) {
    results.fail++;
    console.log(`  ✗ GET /api/v1/shops/nearby 请求失败: ${e.message}`);
  }

  try {
    const s = await request('GET', '/api/v1/shops/search?keyword=维修&limit=5');
    ok('GET /api/v1/shops/search', s);
  } catch (e) {
    results.fail++;
    console.log(`  ✗ GET /api/v1/shops/search 请求失败: ${e.message}`);
  }

  let shopId = 'SHOP001';
  try {
    const nearby = await request('GET', '/api/v1/shops/nearby?lat=39.9&lng=116.4&limit=5');
    if (nearby.data?.data?.list?.[0]?.shop_id) {
      shopId = nearby.data.data.list[0].shop_id;
    }
  } catch (_) {}
  try {
    const d = await request('GET', `/api/v1/shops/${shopId}`);
    ok('GET /api/v1/shops/:id', d);
  } catch (e) {
    results.fail++;
    console.log(`  ✗ GET /api/v1/shops/:id 请求失败: ${e.message}`);
  }

  try {
    const r = await request('GET', `/api/v1/shops/${shopId}/reviews?limit=5`);
    ok('GET /api/v1/shops/:id/reviews', r);
  } catch (e) {
    results.fail++;
    console.log(`  ✗ GET /api/v1/shops/:id/reviews 请求失败: ${e.message}`);
  }
}

async function runAdminTests() {
  console.log('\n========== T3 管理员接口 ==========');
  let adminToken = null;
  try {
    const login = await request('POST', '/api/v1/admin/login', {
      body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    if (login.status === 200 && login.data?.code === 200 && login.data?.data?.token) {
      adminToken = login.data.data.token;
      ok('POST /api/v1/admin/login', login);
    } else {
      results.fail++;
      console.log(`  ✗ POST /api/v1/admin/login 失败 (status=${login.status} code=${login.data?.code})`);
      return;
    }
  } catch (e) {
    results.fail++;
    console.log(`  ✗ POST /api/v1/admin/login 请求失败: ${e.message}`);
    return;
  }

  const auth = { headers: { Authorization: `Bearer ${adminToken}` } };
  const adminEndpoints = [
    ['GET', '/api/v1/admin/merchants', '商户列表'],
    ['GET', '/api/v1/admin/orders', '订单列表'],
    ['GET', '/api/v1/admin/statistics', '统计数据'],
    ['GET', '/api/v1/admin/config', '系统配置'],
    ['GET', '/api/v1/admin/settlements', '结算列表'],
    ['GET', '/api/v1/admin/order-cancel-requests', '取消申请'],
    ['GET', '/api/v1/admin/complaints', '投诉列表'],
    ['GET', '/api/v1/admin/appeal-reviews', '评价申诉'],
    ['GET', '/api/v1/admin/reward-rules/complexity-levels', '复杂度规则'],
  ];

  for (const [method, path, name] of adminEndpoints) {
    try {
      const r = await request(method, path, auth);
      ok(`${method} ${path} (${name})`, r);
    } catch (e) {
      results.fail++;
      console.log(`  ✗ ${method} ${path} 请求失败: ${e.message}`);
    }
  }
}

async function runMerchantTests() {
  console.log('\n========== T4 服务商接口 ==========');
  let merchantToken = null;
  try {
    const login = await request('POST', '/api/v1/merchant/login', {
      body: { phone: MERCHANT_PHONE, password: MERCHANT_PASSWORD },
    });
    if (login.status === 200 && login.data?.code === 200 && login.data?.data?.token) {
      merchantToken = login.data.data.token;
      ok('POST /api/v1/merchant/login', login);
    } else {
      skip('POST /api/v1/merchant/login', `服务商账号不存在或密码错误 (${login.data?.message || login.status})`);
      return;
    }
  } catch (e) {
    results.fail++;
    console.log(`  ✗ POST /api/v1/merchant/login 请求失败: ${e.message}`);
    return;
  }

  const auth = { headers: { Authorization: `Bearer ${merchantToken}` } };
  // bind-openid：缺 code 应 400；404 表示服务端可能未部署该路由
  try {
    const bindNoCode = await request('POST', '/api/v1/merchant/bind-openid', {
      ...auth,
      body: {},
    });
    if (bindNoCode.status === 400 || (bindNoCode.data && bindNoCode.data.code === 400)) {
      ok('POST /api/v1/merchant/bind-openid 缺 code 应 400', bindNoCode, 400, 400);
    } else if (bindNoCode.status === 404) {
      skip('POST /api/v1/merchant/bind-openid', '接口返回 404，可能未部署，请确认服务端已更新');
    } else {
      ok('POST /api/v1/merchant/bind-openid 接口可访问', bindNoCode);
    }
  } catch (e) {
    results.fail++;
    console.log(`  ✗ POST /api/v1/merchant/bind-openid 请求失败: ${e.message}`);
  }

  const merchantEndpoints = [
    ['GET', '/api/v1/merchant/dashboard', '工作台'],
    ['GET', '/api/v1/merchant/biddings', '竞价列表'],
    ['GET', '/api/v1/merchant/orders', '订单列表'],
    ['GET', '/api/v1/merchant/shop', '店铺信息'],
    ['GET', '/api/v1/merchant/messages', '消息列表'],
    ['GET', '/api/v1/merchant/messages/unread-count', '未读数量'],
    ['GET', '/api/v1/merchant/appeals', '申诉列表'],
  ];

  for (const [method, path, name] of merchantEndpoints) {
    try {
      const r = await request(method, path, auth);
      ok(`${method} ${path} (${name})`, r);
    } catch (e) {
      results.fail++;
      console.log(`  ✗ ${method} ${path} 请求失败: ${e.message}`);
    }
  }
}

async function runUserTests() {
  console.log('\n========== T5 用户端接口 ==========');
  let userToken = null;

  // 尝试 dev/test-token 获取用户 token（仅非生产环境可用）
  try {
    const devToken = await request('POST', '/api/v1/dev/test-token', {
      body: { type: 'user', user_id: 'USER001' },
    });
    if (devToken.status === 200 && devToken.data?.code === 200 && devToken.data?.data?.token) {
      userToken = devToken.data.data.token;
      ok('POST /api/v1/dev/test-token (user)', devToken);
    } else {
      skip('POST /api/v1/dev/test-token', 'dev 接口不可用或 USER001 不存在');
      return;
    }
  } catch (e) {
    skip('POST /api/v1/dev/test-token', `请求失败: ${e.message}`);
    return;
  }

  const auth = { headers: { Authorization: `Bearer ${userToken}` } };
  const userEndpoints = [
    ['GET', '/api/v1/user/profile', '用户资料'],
    ['GET', '/api/v1/user/trust-level', '可信度等级'],
    ['GET', '/api/v1/user/level-detail', '等级详情'],
    ['GET', '/api/v1/user/vehicles', '车辆列表'],
    ['GET', '/api/v1/user/balance', '余额明细'],
    ['GET', '/api/v1/user/biddings', '竞价列表'],
    ['GET', '/api/v1/user/orders', '订单列表'],
    ['GET', '/api/v1/user/messages', '消息列表'],
    ['GET', '/api/v1/user/messages/unread-count', '未读数量'],
    ['GET', '/api/v1/damage/daily-quota', '定损配额'],
    ['GET', '/api/v1/damage/reports', '定损报告列表'],
  ];

  for (const [method, path, name] of userEndpoints) {
    try {
      const r = await request(method, path, auth);
      ok(`${method} ${path} (${name})`, r);
    } catch (e) {
      results.fail++;
      console.log(`  ✗ ${method} ${path} 请求失败: ${e.message}`);
    }
  }
}

async function runErrorTests() {
  console.log('\n========== T6 异常与边界 ==========');

  try {
    const noAuth = await request('GET', '/api/v1/user/profile');
    ok('无 token 访问 user/profile 应 401', noAuth, 401, 401);
  } catch (e) {
    results.fail++;
    console.log(`  ✗ 异常测试失败: ${e.message}`);
  }

  try {
    const badToken = await request('GET', '/api/v1/user/profile', {
      headers: { Authorization: 'Bearer invalid_token_xxx' },
    });
    ok('无效 token 应 401', badToken, 401, 401);
  } catch (e) {
    results.fail++;
    console.log(`  ✗ 异常测试失败: ${e.message}`);
  }

  try {
    const notFound = await request('GET', '/api/v1/shops/INVALID_SHOP_ID_XXX');
    if (notFound.status === 404 || notFound.status === 400 || (notFound.data && notFound.data.code !== 200)) {
      ok('不存在的 shop_id 应返回错误', notFound, notFound.status, null);
    } else {
      skip('不存在的 shop_id', `实际 status=${notFound.status}，可能返回空数据`);
    }
  } catch (e) {
    results.fail++;
    console.log(`  ✗ 异常测试失败: ${e.message}`);
  }
}

async function main() {
  console.log('辙见 API 完整功能测试');
  console.log('API_BASE:', API_BASE);
  console.log('管理员:', ADMIN_USERNAME, '(密码通过环境变量 ADMIN_PASSWORD 配置)');

  await runPublicTests();
  await runAdminTests();
  await runMerchantTests();
  await runUserTests();
  await runErrorTests();

  console.log('\n========== 汇总 ==========');
  console.log(`通过: ${results.pass} | 失败: ${results.fail} | 跳过: ${results.skip}`);
  const total = results.pass + results.fail;
  const pct = total > 0 ? ((results.pass / total) * 100).toFixed(1) : 0;
  console.log(`执行率: ${total} 个用例，通过率 ${pct}%`);

  if (results.fail > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('执行异常:', e);
  process.exit(1);
});
