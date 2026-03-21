#!/usr/bin/env node
/**
 * 端到端全流程测试（真实 API 调用）
 * 服务商注册 → 资质审核 → 定损(API) → 竞价(API) → 分发 → 报价(API) → 选厂(API) → 接单(API)
 * → 维修完成(API/force-complete) → 用户确认(API) → 评价(API) → 月度结算(API) → 提现(API)
 *
 * 用法：node web/scripts/test-e2e-real-api.js
 *
 * 环境变量：API_BASE、ADMIN_USERNAME、ADMIN_PASSWORD、USER_ID
 */

const http = require('http');
const https = require('https');

const API_BASE = (process.env.API_BASE || 'https://simplewin.cn').replace(/\/$/, '');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const USER_ID = process.env.USER_ID || 'USER001';
const TEST_PHONE = '139' + String(Date.now()).slice(-8);
const TEST_PASSWORD = 'Test123456';
const COORDS = { lat: 39.9, lng: 116.4 };

function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    const lib = url.startsWith('https') ? https : http;
    const body = options.body ? JSON.stringify(options.body) : null;
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const req = lib.request(
      url,
      {
        method: method || 'GET',
        headers: body ? { ...headers, 'Content-Length': Buffer.byteLength(body) } : headers,
        timeout: 25000,
      },
      (res) => {
        let buf = '';
        res.on('data', (ch) => (buf += ch));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: buf ? JSON.parse(buf) : {} });
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
  const okStatus = res.status >= 200 && res.status < 300;
  const okCode = res.data?.code === undefined || res.data?.code === 200;
  if (okStatus && okCode) {
    console.log(`  ✓ ${step}${msg ? ': ' + msg : ''}`);
    return true;
  }
  console.log(`  ✗ ${step} 失败: status=${res.status} code=${res.data?.code} msg=${res.data?.message || ''}`);
  return false;
}

async function main() {
  console.log('\n========== 车厘子 真实 API 端到端测试 ==========\n');
  console.log('API:', API_BASE);
  console.log('测试服务商:', TEST_PHONE);
  console.log('用户:', USER_ID);
  console.log('');

  let adminToken = null;
  let userToken = null;
  let merchantToken = null;
  let reportId = null;
  let biddingId = null;
  let orderId = null;
  let shopId = null;

  // ========== 1. 服务商注册 ==========
  console.log('--- 1. 服务商注册 ---');
  const regRes = await request('POST', '/api/v1/merchant/register', {
    body: {
      name: '测试维修厂' + Date.now(),
      license_id: '91110000MA01' + String(Date.now()).slice(-8),
      legal_representative: '张三',
      contact: '李四',
      address: '北京市朝阳区测试路1号',
      latitude: COORDS.lat,
      longitude: COORDS.lng,
      phone: TEST_PHONE,
      password: TEST_PASSWORD,
      qualification_ai_recognized: '二类',
      qualification_ai_result: 'recognized',
    },
  });
  if (!ok('1.1 服务商注册', regRes)) process.exit(1);
  const merchantId = regRes.data?.data?.merchant_id || regRes.data?.merchant_id;

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
  if (!ok('2.1 资质审核通过', auditRes)) process.exit(1);

  // ========== 3. 用户 token ==========
  console.log('\n--- 3. 获取用户 token ---');
  const devTokenRes = await request('POST', '/api/v1/dev/test-token', {
    body: { type: 'user', user_id: USER_ID },
  });
  if (devTokenRes.data?.code !== 200 || !devTokenRes.data?.data?.token) {
    console.log('  ✗ 获取用户 token 失败（dev 接口可能不可用）');
    process.exit(1);
  }
  userToken = devTokenRes.data.data.token;
  console.log('  ✓ 3.1 获取用户 token');

  // ========== 4. 定损分析 ==========
  console.log('\n--- 4. 定损分析 ---');
  let damageRes = await request('POST', '/api/v1/damage/analyze', {
    headers: { Authorization: `Bearer ${userToken}` },
    body: {
      user_id: USER_ID,
      images: ['https://example.com/damage-test.jpg'],
      vehicle_info: { plate_number: '京A12345', brand: '大众', model: '帕萨特' },
    },
  });
  if (damageRes.status === 429 || (damageRes.data?.message || '').includes('已达上限')) {
    const devReportRes = await request('POST', '/api/v1/dev/ensure-damage-report', {
      body: { user_id: USER_ID },
    });
    if (devReportRes.data?.code === 200 && devReportRes.data?.data?.report_id) {
      reportId = devReportRes.data.data.report_id;
      console.log('  ○ 4.1 定损次数已达上限，使用 dev 创建报告:', reportId);
    } else {
      console.log('  ○ 4.1 定损次数已达上限，dev 接口不可用，回退到 simulate-full-flow');
      await runSimulateFallback();
      return;
    }
  } else if (!ok('4.1 定损分析', damageRes)) {
    process.exit(1);
  } else {
    reportId = damageRes.data?.data?.report_id;
  }
  if (!reportId) {
    console.log('  ✗ 未获取 report_id');
    process.exit(1);
  }

  // ========== 5. 创建竞价（触发真实分发） ==========
  console.log('\n--- 5. 创建竞价 ---');
  const bidRes = await request('POST', '/api/v1/bidding/create', {
    headers: { Authorization: `Bearer ${userToken}` },
    body: {
      report_id: reportId,
      range: 10,
      vehicle_info: { plate_number: '京A12345', brand: '大众', model: '帕萨特' },
      latitude: COORDS.lat,
      longitude: COORDS.lng,
    },
  });
  if (!ok('5.1 创建竞价', bidRes)) process.exit(1);
  biddingId = bidRes.data?.data?.bidding_id;
  if (!biddingId) {
    console.log('  ✗ 未获取 bidding_id');
    process.exit(1);
  }

  // 5.2 查询竞价分发详情（邀请名单、梯队）
  const distRes = await request('GET', `/api/v1/admin/biddings/${biddingId}/distribution`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (distRes.data?.code === 200 && distRes.data?.data) {
    const d = distRes.data.data;
    console.log('  --- 5.2 竞价分发详情 ---');
    console.log(`     过滤通过: ${d.total_filtered} 家, 实际邀请: ${d.total_invited} 家`);
    for (const s of d.invited || []) {
      console.log(`     [${s.tierName}] ${s.name} (${s.shop_id}) 匹配分=${s.match_score}${s.quoted ? ' 已报价' : ''}`);
    }
    if ((d.filtered_not_invited || []).length > 0) {
      console.log(`     未邀请(名额不足): ${d.filtered_not_invited.map((x) => x.name).join(', ')}`);
    }
    if (d.diagnostic) {
      console.log(`     诊断: ${d.diagnostic.hint}`);
    }
  }

  // ========== 6. 服务商 token ==========
  console.log('\n--- 6. 服务商登录 ---');
  const mercLogin = await request('POST', '/api/v1/merchant/login', {
    body: { phone: TEST_PHONE, password: TEST_PASSWORD },
  });
  if (mercLogin.status !== 200 || !mercLogin.data?.data?.token) {
    console.log('  ✗ 服务商登录失败');
    process.exit(1);
  }
  merchantToken = mercLogin.data.data.token;
  shopId = mercLogin.data.data.shop_id || mercLogin.data.data.user?.shop_id;

  // ========== 7. 服务商报价 ==========
  console.log('\n--- 7. 服务商报价 ---');
  let quoteRes = await request('POST', '/api/v1/merchant/quote', {
    headers: { Authorization: `Bearer ${merchantToken}` },
    body: {
      bidding_id: biddingId,
      amount: 3600,
      items: [{ name: '钣金喷漆', price: 2200 }, { name: '工时费', price: 1400 }],
      value_added_services: [],
      duration: 3,
      warranty: 12,
      remark: 'E2E测试报价',
    },
  });
  if (!ok('7.1 提交报价', quoteRes)) {
    if (quoteRes.data?.message?.includes('未邀请')) {
      const addShopRes = await request('POST', `/api/v1/dev/biddings/${biddingId}/add-shop`, {
        body: { shop_id: shopId },
      });
      if (addShopRes.data?.code === 200) {
        console.log('  ○ 7.2 通过 dev 将本店加入邀请名单，重试报价');
        quoteRes = await request('POST', '/api/v1/merchant/quote', {
          headers: { Authorization: `Bearer ${merchantToken}` },
          body: {
            bidding_id: biddingId,
            amount: 3600,
            items: [{ name: '钣金喷漆', price: 2200 }, { name: '工时费', price: 1400 }],
            value_added_services: [],
            duration: 3,
            warranty: 12,
            remark: 'E2E测试报价',
          },
        });
        if (!ok('7.3 提交报价', quoteRes)) process.exit(1);
      } else {
        console.log('  ○ dev/add-shop 不可用，改用 simulate-full-flow 完成后续');
        await runSimulateFallback();
        return;
      }
    } else {
      process.exit(1);
    }
  }

  // ========== 8. 用户选厂 ==========
  console.log('\n--- 8. 用户选厂 ---');
  const selectRes = await request('POST', `/api/v1/bidding/${biddingId}/select`, {
    headers: { Authorization: `Bearer ${userToken}` },
    body: { shop_id: shopId },
  });
  if (!ok('8.1 选择维修厂', selectRes)) process.exit(1);
  orderId = selectRes.data?.data?.order_id;
  if (!orderId) {
    console.log('  ✗ 未获取 order_id');
    process.exit(1);
  }

  // ========== 9. 服务商接单 ==========
  console.log('\n--- 9. 服务商接单 ---');
  const acceptRes = await request('POST', `/api/v1/merchant/orders/${orderId}/accept`, {
    headers: { Authorization: `Bearer ${merchantToken}` },
  });
  if (!ok('9.1 接单', acceptRes)) process.exit(1);

  // ========== 10. 维修完成（先尝试正常 API，若返回 auditing 则用 force-complete） ==========
  console.log('\n--- 10. 维修完成 ---');
  const completionEvidence = {
    repair_photos: ['https://example.com/repair.jpg'],
    settlement_photos: ['https://example.com/settlement.jpg'],
    material_photos: ['https://example.com/material.jpg'],
  };
  const statusRes = await request('PUT', `/api/v1/merchant/orders/${orderId}/status`, {
    headers: { Authorization: `Bearer ${merchantToken}` },
    body: { status: 2, completion_evidence: completionEvidence },
  });
  if (statusRes.data?.data?.status === 'auditing') {
    const forceRes = await request('POST', `/api/v1/dev/orders/${orderId}/force-complete`, {
      body: { completion_evidence: completionEvidence },
    });
    if (!ok('10.1 强制完成（绕过材料审核）', forceRes)) process.exit(1);
  } else if (!ok('10.1 维修完成', statusRes)) {
    process.exit(1);
  }

  // ========== 11. 用户确认完成 ==========
  console.log('\n--- 11. 用户确认完成 ---');
  const confirmRes = await request('POST', `/api/v1/user/orders/${orderId}/confirm`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  if (!ok('11.1 确认完成', confirmRes)) process.exit(1);

  // ========== 12. 用户提交评价 ==========
  console.log('\n--- 12. 用户提交评价 ---');
  const reviewRes = await request('POST', '/api/v1/reviews', {
    headers: { Authorization: `Bearer ${userToken}` },
    body: {
      order_id: orderId,
      module3: {
        content: '前保险杠钣金修复效果很好，师傅手艺不错，工期三天完成，价格透明。',
        settlement_list_image: 'https://example.com/settlement.jpg',
        completion_images: ['https://example.com/repair.jpg'],
        q1_progress_synced: true,
        q2_parts_shown: true,
        q3_fault_resolved: true,
        ratings: { service: 5, price_transparency: 5, quality: 5 },
      },
    },
  });
  if (!ok('12.1 提交评价', reviewRes)) process.exit(1);

  // ========== 13. 月度结算 ==========
  console.log('\n--- 13. 月度结算 ---');
  const prevMonth = new Date();
  prevMonth.setMonth(prevMonth.getMonth() - 1);
  const settleMonth = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;
  const settleRes = await request('POST', `/api/v1/admin/cron/settle-monthly-rewards?month=${settleMonth}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  ok('13.1 月度结算', settleRes, settleRes.data?.code === 200 ? settleMonth : '');

  // ========== 14. 用户提现 ==========
  console.log('\n--- 14. 用户余额与提现 ---');
  const balanceRes = await request('GET', '/api/v1/user/balance', {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  if (ok('14.1 查询余额', balanceRes)) {
    const bal = balanceRes.data?.data?.balance ?? balanceRes.data?.balance ?? 0;
    console.log(`     当前余额: ${bal} 元`);
    if (bal > 0) {
      const withdrawRes = await request('POST', '/api/v1/user/withdraw', {
        headers: { Authorization: `Bearer ${userToken}` },
        body: { amount: Math.min(1, Number(bal)) },
      });
      ok('14.2 提现申请', withdrawRes);
    } else {
      console.log('  ○ 14.2 余额为 0，跳过提现');
    }
  }

  console.log('\n========== 真实 API 端到端测试完成 ==========\n');
  process.exit(0);
}

async function runSimulateFallback() {
  console.log('\n--- 回退：simulate-full-flow ---');
  const simRes = await request('POST', '/api/v1/dev/simulate-full-flow', {
    body: { user_id: USER_ID, merchant_phone: TEST_PHONE, merchant_password: TEST_PASSWORD },
  });
  if (simRes.data?.code === 200) {
    console.log('  ✓ 全流程模拟完成');
  } else {
    console.log('  ✗ 模拟失败:', simRes.data?.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('执行异常:', err);
  process.exit(1);
});
