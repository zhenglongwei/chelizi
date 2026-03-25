#!/usr/bin/env node
/**
 * 端到端全流程测试：服务商注册 → 资质审核 → 定损→竞价→选厂→接单→维修→确认→评价→返佣→提现
 *
 * 用法：node web/scripts/test-e2e-full-flow.js
 *
 * 环境变量：
 *   API_BASE        默认 https://simplewin.cn
 *   ADMIN_USERNAME  默认 admin
 *   ADMIN_PASSWORD  默认 admin123
 *   USER_ID         默认 USER001
 */

const http = require('http');
const https = require('https');

const API_BASE = (process.env.API_BASE || 'https://simplewin.cn').replace(/\/$/, '');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const USER_ID = process.env.USER_ID || 'USER001';

// 生成唯一手机号（11 位），避免与已有数据冲突
const TEST_PHONE = '139' + String(Date.now()).slice(-8);
const TEST_PASSWORD = 'Test123456';

function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const body = options.body ? JSON.stringify(options.body) : null;
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const req = lib.request(
      url,
      {
        method: method || 'GET',
        headers: body ? { ...headers, 'Content-Length': Buffer.byteLength(body) } : headers,
        timeout: 20000,
      },
      (res) => {
        let buf = '';
        res.on('data', (ch) => (buf += ch));
        res.on('end', () => {
          try {
            const json = buf ? JSON.parse(buf) : {};
            resolve({ status: res.statusCode, data: json });
          } catch {
            resolve({ status: res.statusCode, data: null, raw: buf });
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function ok(step, res, msg = '') {
  if (res.status >= 200 && res.status < 300 && (res.data?.code === 200 || res.data?.code === undefined)) {
    console.log(`  ✓ ${step}${msg ? ': ' + msg : ''}`);
    return true;
  }
  console.log(`  ✗ ${step} 失败: status=${res.status} code=${res.data?.code} msg=${res.data?.message || ''}`);
  return false;
}

async function main() {
  console.log('\n========== 辙见 端到端全流程测试 ==========\n');
  console.log('API:', API_BASE);
  console.log('测试服务商手机号:', TEST_PHONE);
  console.log('');

  let adminToken = null;
  let merchantId = null;

  // ========== 1. 服务商注册 ==========
  console.log('--- 1. 服务商注册 ---');
  const regBody = {
    name: '测试维修厂' + Date.now(),
    license_id: '91110000MA01' + String(Date.now()).slice(-8),
    legal_representative: '张三',
    contact: '李四',
    address: '北京市朝阳区测试路1号',
    latitude: 39.9,
    longitude: 116.4,
    phone: TEST_PHONE,
    password: TEST_PASSWORD,
    qualification_ai_recognized: '二类',
    qualification_ai_result: 'recognized',
  };
  const regRes = await request('POST', '/api/v1/merchant/register', { body: regBody });
  if (!ok('1.1 服务商注册', regRes)) {
    console.log('  提示: 若手机号已存在，可更换 TEST_PHONE 或使用已有服务商跳过注册');
    process.exit(1);
  }
  merchantId = regRes.data?.data?.merchant_id || regRes.data?.merchant_id;
  if (!merchantId) {
    console.log('  ✗ 未获取到 merchant_id');
    process.exit(1);
  }
  console.log(`     merchant_id: ${merchantId}`);

  // ========== 2. 管理员资质审核 ==========
  console.log('\n--- 2. 管理员资质审核 ---');
  const adminLogin = await request('POST', '/api/v1/admin/login', {
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  if (adminLogin.status !== 200 || !adminLogin.data?.data?.token) {
    console.log('  ✗ 管理员登录失败');
    process.exit(1);
  }
  adminToken = adminLogin.data.data.token;

  const auditRes = await request('POST', `/api/v1/admin/merchants/${merchantId}/qualification-audit`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { auditStatus: 'approved' },
  });
  if (!ok('2.1 资质审核通过', auditRes)) {
    process.exit(1);
  }

  // ========== 3. 全流程模拟（定损→竞价→选厂→接单→维修→确认→评价→返佣） ==========
  console.log('\n--- 3. 定损→竞价→选厂→接单→维修→确认→评价→返佣 ---');
  const simRes = await request('POST', '/api/v1/dev/simulate-full-flow', {
    body: {
      user_id: USER_ID,
      merchant_phone: TEST_PHONE,
      merchant_password: TEST_PASSWORD,
    },
  });
  if (simRes.data?.code !== 200) {
    console.log('  ✗ 全流程模拟失败:', simRes.data?.message || simRes.status);
    process.exit(1);
  }
  const d = simRes.data?.data || {};
  console.log('  ✓ 3.1 全流程完成');
  console.log(`     report_id: ${d.report_id} bidding_id: ${d.bidding_id} order_id: ${d.order_id}`);
  console.log(`     review_id: ${d.review_id} 返佣: ${d.rebate_amount} 元`);

  // ========== 4. 用户余额与提现 ==========
  console.log('\n--- 4. 用户余额与提现 ---');
  const devTokenRes = await request('POST', '/api/v1/dev/test-token', {
    body: { type: 'user', user_id: USER_ID },
  });
  if (devTokenRes.data?.code !== 200 || !devTokenRes.data?.data?.token) {
    console.log('  ○ 4.1 获取用户 token 跳过（dev 接口可能不可用）');
  } else {
    const userToken = devTokenRes.data.data.token;
    const balanceRes = await request('GET', '/api/v1/user/balance', {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (ok('4.1 查询余额', balanceRes)) {
      const bal = balanceRes.data?.data?.balance ?? balanceRes.data?.balance ?? 0;
      console.log(`     当前余额: ${bal} 元`);
      if (bal > 0) {
        const withdrawRes = await request('POST', '/api/v1/user/withdraw', {
          headers: { Authorization: `Bearer ${userToken}` },
          body: { amount: Math.min(1, Number(bal)) },
        });
        ok('4.2 提现申请', withdrawRes, withdrawRes.data?.code === 200 ? '已提交' : '');
      } else {
        console.log('  ○ 4.2 余额为 0，跳过提现');
      }
    }
  }

  console.log('\n========== 测试完成 ==========\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('执行异常:', err);
  process.exit(1);
});
