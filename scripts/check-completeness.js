#!/usr/bin/env node
/**
 * 车厘子项目完成度测试工具
 * 按《协作规范》与《车厘子-全流程需求梳理》检查项目整体是否完成
 *
 * 用法：node scripts/check-completeness.js [API_BASE_URL]
 * 示例：node scripts/check-completeness.js http://localhost:3000
 *       node scripts/check-completeness.js https://simplewin.cn/api
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const API_BASE = process.argv[2] || process.env.CHELIZI_API_URL || 'http://localhost:3000';

// 期望的页面（按《00-页面索引》）
const EXPECTED_OWNER_PAGES = [
  'pages/index/index',
  'pages/damage/upload/index',
  'pages/bidding/detail/index',
  'pages/bidding/list/index',
  'pages/shop/detail/index',
  'pages/shop/book/index',
  'pages/order/list/index',
  'pages/order/detail/index',
  'pages/auth/login/index',
  'pages/review/submit/index',
  'pages/user/index/index',
  'pages/user/settings/index',
  'pages/message/index',
  'pages/search/list/index',
  'pages/user/balance/index',
  'pages/review/followup/index',
  'pages/review/return/index',
  'pages/merchant/login',
  'pages/merchant/register',
];

const EXPECTED_MERCHANT_PAGES = [
  'pages/merchant/home',
  'pages/merchant/bidding/list/index',
  'pages/merchant/bidding/detail/index',
  'pages/merchant/order/list/index',
  'pages/merchant/order/detail/index',
  'pages/merchant/shop/profile/index',
];

const EXPECTED_ADMIN_ROUTES = [
  'dashboard',
  'merchants',
  'orders',
  'rules',
  'settlement',
  'disputes',
  'statistics',
  'config',
];

const EXPECTED_TABLES = [
  'users',
  'shops',
  'damage_reports',
  'biddings',
  'quotes',
  'orders',
  'reviews',
  'transactions',
  'withdrawals',
  'user_messages',
  'user_favorite_shops',
  'merchant_users',
  'shop_penalties',
  'settings',
];

const results = { pass: [], fail: [], skip: [] };

function log(msg, type = 'info') {
  const icons = { info: '  ', pass: '✓ ', fail: '✗ ', skip: '○ ' };
  console.log(`${icons[type] || '  '}${msg}`);
}

function addResult(type, category, msg) {
  results[type].push({ category, msg });
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (ch) => (data += ch));
        res.on('end', () => {
          try {
            const json = data ? JSON.parse(data) : {};
            resolve({ status: res.statusCode, data: json });
          } catch {
            resolve({ status: res.statusCode, data: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

function checkStructure() {
  log('\n========== 一、结构检查 ==========');
  const appJsonPath = path.join(ROOT, 'app.json');
  if (!fs.existsSync(appJsonPath)) {
    addResult('fail', '结构', 'app.json 不存在');
    return;
  }
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  const pages = appJson.pages || [];

  // 车主端 + 服务商端页面
  const allExpected = [...EXPECTED_OWNER_PAGES, ...EXPECTED_MERCHANT_PAGES];
  const missing = allExpected.filter((p) => !pages.includes(p));
  if (missing.length > 0) {
    addResult('fail', '结构', `缺失页面: ${missing.join(', ')}`);
    log(`缺失页面: ${missing.length} 个`, 'fail');
  } else {
    addResult('pass', '结构', `车主端+服务商端页面已注册 (${allExpected.length} 个)`);
    log(`车主端+服务商端页面已注册 (${allExpected.length} 个)`, 'pass');
  }

  // 页面文件存在性
  let missingFiles = 0;
  for (const p of pages) {
    const jsPath = path.join(ROOT, p + '.js');
    const wxmlPath = path.join(ROOT, p + '.wxml');
    if (!fs.existsSync(jsPath)) missingFiles++;
    if (!fs.existsSync(wxmlPath)) missingFiles++;
  }
  if (missingFiles > 0) {
    addResult('fail', '结构', `缺失页面文件: ${missingFiles} 个 .js/.wxml`);
    log(`缺失页面文件: ${missingFiles} 个`, 'fail');
  } else {
    addResult('pass', '结构', '所有页面 .js/.wxml 文件存在');
    log('所有页面 .js/.wxml 文件存在', 'pass');
  }

  // 后台路由
  const appTsxPath = path.join(ROOT, 'web/src/App.tsx');
  if (fs.existsSync(appTsxPath)) {
    const appTsx = fs.readFileSync(appTsxPath, 'utf8');
    const missingAdmin = EXPECTED_ADMIN_ROUTES.filter((r) => !appTsx.includes(`path="${r}"`));
    if (missingAdmin.length > 0) {
      addResult('fail', '结构', `缺失后台路由: ${missingAdmin.join(', ')}`);
      log(`缺失后台路由: ${missingAdmin.length} 个`, 'fail');
    } else {
      addResult('pass', '结构', `后台路由已配置 (${EXPECTED_ADMIN_ROUTES.length} 个)`);
      log(`后台路由已配置 (${EXPECTED_ADMIN_ROUTES.length} 个)`, 'pass');
    }
  } else {
    addResult('fail', '结构', 'web/src/App.tsx 不存在');
  }

  // Schema 表
  const schemaPath = path.join(ROOT, 'web/database/schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const missingTables = EXPECTED_TABLES.filter((t) => !schema.includes(`CREATE TABLE IF NOT EXISTS ${t}`));
    if (missingTables.length > 0) {
      addResult('fail', '结构', `Schema 缺失表: ${missingTables.join(', ')}`);
      log(`Schema 缺失表: ${missingTables.length} 个`, 'fail');
    } else {
      addResult('pass', '结构', `Schema 包含核心表 (${EXPECTED_TABLES.length} 张)`);
      log(`Schema 包含核心表 (${EXPECTED_TABLES.length} 张)`, 'pass');
    }
  } else {
    addResult('fail', '结构', 'web/database/schema.sql 不存在');
  }
}

async function checkApi() {
  log('\n========== 二、接口可用性检查 ==========');
  const base = API_BASE.replace(/\/$/, '');
  // base 若已含 /api（如 https://simplewin.cn/api），则 API 路径不再加 /api 前缀
  const apiPrefix = base.endsWith('/api') ? '' : '/api';

  // 1. 健康检查（/health 或 /api/health）
  const healthPath = base.endsWith('/api') ? '/health' : '/health';
  try {
    const res = await httpRequest(`${base}${healthPath}`);
    if (res.status === 200) {
      addResult('pass', 'API', 'GET /health 正常');
      log('GET /health 正常', 'pass');
    } else {
      addResult('fail', 'API', `GET /health 返回 ${res.status}`);
      log(`GET /health 返回 ${res.status}`, 'fail');
    }
  } catch (e) {
    const errMsg = e.message || e.code || String(e);
    addResult('fail', 'API', `GET /health 失败: ${errMsg}`);
    log(`GET /health 失败: ${errMsg}`, 'fail');
    log('  提示: 请确保 API 已启动 (cd web/api-server && node server.js)', 'skip');
    log(`  请求地址: ${base}${healthPath}`, 'skip');
    log('  后续 API 检查跳过（可能无法连接）', 'skip');
    return;
  }

  // 2. 公开接口：附近维修厂
  try {
    const res = await httpRequest(`${base}${apiPrefix}/v1/shops/nearby?limit=5`);
    if (res.status === 200 && res.data?.code === 200) {
      addResult('pass', 'API', 'GET /api/v1/shops/nearby 正常');
      log('GET /api/v1/shops/nearby 正常', 'pass');
    } else {
      addResult('fail', 'API', `GET /api/v1/shops/nearby 返回 ${res.status} 或 code=${res.data?.code}`);
      log(`GET /api/v1/shops/nearby 异常`, 'fail');
    }
  } catch (e) {
    addResult('fail', 'API', `GET /api/v1/shops/nearby 失败: ${e.message}`);
    log(`GET /api/v1/shops/nearby 失败`, 'fail');
  }

  // 3. 后台登录
  try {
    const res = await httpRequest(`${base}${apiPrefix}/v1/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { username: 'admin', password: 'admin123' },
    });
    if (res.status === 200 && res.data?.code === 200 && res.data?.data?.token) {
      addResult('pass', 'API', 'POST /api/v1/admin/login 正常');
      log('POST /api/v1/admin/login 正常', 'pass');

      const token = res.data.data.token;

      // 4. 需要 token 的接口
      const adminEndpoints = [
        ['GET', '/api/v1/admin/orders', '订单列表'],
        ['GET', '/api/v1/admin/merchants', '商户列表'],
        ['GET', '/api/v1/admin/statistics', '统计'],
        ['GET', '/api/v1/admin/config', '配置'],
      ];

      for (const [method, urlPath, name] of adminEndpoints) {
        try {
          const path = (apiPrefix ? urlPath : urlPath.replace(/^\/api/, ''));
          const r = await httpRequest(`${base}${path}`, {
            method,
            headers: { Authorization: `Bearer ${token}` },
          });
          if (r.status === 200 && (r.data?.code === 200 || r.data?.code === undefined)) {
            addResult('pass', 'API', `${method} ${urlPath} (${name}) 正常`);
            log(`${method} ${urlPath} (${name}) 正常`, 'pass');
          } else {
            addResult('fail', 'API', `${method} ${urlPath} 返回 ${r.status}`);
            log(`${method} ${urlPath} 异常`, 'fail');
          }
        } catch (e) {
          addResult('fail', 'API', `${method} ${urlPath} 失败: ${e.message}`);
          log(`${method} ${urlPath} 失败`, 'fail');
        }
      }
    } else {
      addResult('fail', 'API', `POST /api/v1/admin/login 返回 ${res.status} 或未获取 token`);
      log('POST /api/v1/admin/login 异常', 'fail');
    }
  } catch (e) {
    addResult('fail', 'API', `POST /api/v1/admin/login 失败: ${e.message}`);
    log(`POST /api/v1/admin/login 失败: ${e.message}`, 'fail');
  }

  // 5. 服务商登录（需存在账号，无则可能 401）
  try {
    const res = await httpRequest(`${base}${apiPrefix}/v1/merchant/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { phone: '13800000000', password: 'test123' },
    });
    if (res.status === 200 && res.data?.code === 200) {
      addResult('pass', 'API', 'POST /api/v1/merchant/login 可登录（测试账号存在）');
      log('POST /api/v1/merchant/login 可登录', 'pass');
    } else if (res.status === 401) {
      addResult('skip', 'API', 'POST /api/v1/merchant/login 接口存在（测试账号不存在）');
      log('POST /api/v1/merchant/login 接口存在（测试账号不存在）', 'skip');
    } else {
      addResult('pass', 'API', 'POST /api/v1/merchant/login 接口可访问');
      log('POST /api/v1/merchant/login 接口可访问', 'pass');
    }
  } catch (e) {
    addResult('fail', 'API', `POST /api/v1/merchant/login 失败: ${e.message}`);
    log(`POST /api/v1/merchant/login 失败`, 'fail');
  }
}

function printSummary() {
  log('\n========== 检查结果汇总 ==========');
  const total = results.pass.length + results.fail.length;
  const passCount = results.pass.length;
  const failCount = results.fail.length;
  const skipCount = results.skip.length;
  const pct = total > 0 ? ((passCount / total) * 100).toFixed(1) : 0;

  log(`通过: ${passCount} | 失败: ${failCount} | 跳过: ${skipCount}`);
  log(`完成度: ${pct}%`);

  if (results.fail.length > 0) {
    log('\n失败项:', 'fail');
    results.fail.forEach((r) => log(`  [${r.category}] ${r.msg}`, 'fail'));
  }

  log('\n');
  process.exit(failCount > 0 ? 1 : 0);
}

async function main() {
  console.log('车厘子项目完成度测试工具');
  console.log('API 地址:', API_BASE);
  console.log('项目根目录:', ROOT);

  checkStructure();
  await checkApi();
  printSummary();
}

main().catch((e) => {
  console.error('执行失败:', e);
  process.exit(1);
});
