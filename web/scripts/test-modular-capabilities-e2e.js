#!/usr/bin/env node
/**
 * 模块化能力端到端验收（M6/M7）
 *
 * 用法：
 *   API_BASE=https://simplewin.cn node web/scripts/test-modular-capabilities-e2e.js
 *
 * 可选环境变量：
 *   OPEN_API_KEY=xxx                      # 验证 openapi 路由时使用
 *   QUOTE_OCR_IMAGE_URL=https://...jpg    # 报价 OCR 测试图片
 *   REPAIR_TIMELINE_ORDER_ID=ORD_xxx      # 维修进度查询订单
 */

const http = require('http');
const https = require('https');

const API_BASE = String(process.env.API_BASE || 'https://simplewin.cn').replace(/\/$/, '');
const OPEN_API_KEY = String(process.env.OPEN_API_KEY || '').trim();
const QUOTE_OCR_IMAGE_URL = String(process.env.QUOTE_OCR_IMAGE_URL || '').trim();
const REPAIR_TIMELINE_ORDER_ID = String(process.env.REPAIR_TIMELINE_ORDER_ID || '').trim();
const stats = { pass: 0, fail: 0, skip: 0 };

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
          let data = null;
          try {
            data = buf ? JSON.parse(buf) : {};
          } catch (_) {}
          resolve({ status: res.statusCode, data, raw: buf || '' });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function pass(msg) {
  stats.pass += 1;
  console.log(`✓ ${msg}`);
}

function fail(msg) {
  stats.fail += 1;
  console.log(`✗ ${msg}`);
}

function skip(msg) {
  stats.skip += 1;
  console.log(`○ ${msg}`);
}

function htmlContains(res, keyword) {
  return typeof res.raw === 'string' && res.raw.includes(keyword);
}

async function testPublicH5() {
  const tools = await request('GET', '/h5/tools');
  if (tools.status === 200 && htmlContains(tools, '辙见工具中心')) pass('H5 工具中心可访问');
  else fail(`H5 工具中心异常 status=${tools.status}`);

  const diag = await request('GET', '/h5/diagnosis?src=e2e');
  if (diag.status === 200 && htmlContains(diag, 'AI诊断助手')) pass('H5 诊断页可访问');
  else fail(`H5 诊断页异常 status=${diag.status}`);
}

async function testPublicDiagnosisApis() {
  const symptom = await request('POST', '/api/v1/public/diagnosis/symptom-analyze', {
    body: { symptom_text: '发动机抖动并且故障灯亮', source_channel: 'e2e_script' },
  });
  if (symptom.status === 200 && symptom.data && symptom.data.code === 200) pass('公共症状诊断接口可用');
  else fail(`公共症状诊断异常 status=${symptom.status} code=${symptom.data && symptom.data.code}`);

  const dtc = await request('POST', '/api/v1/public/diagnosis/dtc-interpret', {
    body: { dtc_code: 'P0300', source_channel: 'e2e_script' },
  });
  if (dtc.status === 200 && dtc.data && dtc.data.code === 200) pass('公共故障码诊断接口可用');
  else fail(`公共故障码诊断异常 status=${dtc.status} code=${dtc.data && dtc.data.code}`);
}

async function testP1OpenApis() {
  if (!OPEN_API_KEY) {
    skip('未提供 OPEN_API_KEY，跳过 P1 OpenAPI 验证');
    return;
  }

  if (QUOTE_OCR_IMAGE_URL) {
    const quote = await request('POST', '/api/v1/open/quote/ocr-import/by-image', {
      headers: { 'X-API-Key': OPEN_API_KEY },
      body: { image_url: QUOTE_OCR_IMAGE_URL },
    });
    if (quote.status === 200 && quote.data && quote.data.code === 200) pass('P1 报价OCR OpenAPI 可用');
    else fail(`P1 报价OCR OpenAPI 异常 status=${quote.status} code=${quote.data && quote.data.code}`);
  } else {
    skip('未提供 QUOTE_OCR_IMAGE_URL，跳过报价 OCR OpenAPI 验证');
  }

  if (REPAIR_TIMELINE_ORDER_ID) {
    const timeline = await request('POST', '/api/v1/open/repair/timeline/public', {
      headers: { 'X-API-Key': OPEN_API_KEY },
      body: { order_id: REPAIR_TIMELINE_ORDER_ID },
    });
    if (timeline.status === 200 && timeline.data && timeline.data.code === 200) pass('P1 维修进度公示 OpenAPI 可用');
    else fail(`P1 维修进度公示 OpenAPI 异常 status=${timeline.status} code=${timeline.data && timeline.data.code}`);
  } else {
    skip('未提供 REPAIR_TIMELINE_ORDER_ID，跳过维修进度 OpenAPI 验证');
  }
}

async function main() {
  console.log('\n=== 模块化能力 E2E 验收 ===');
  console.log('API_BASE:', API_BASE);
  await testPublicH5();
  await testPublicDiagnosisApis();
  await testP1OpenApis();
  console.log(`\n汇总：通过 ${stats.pass}，失败 ${stats.fail}，跳过 ${stats.skip}`);
  if (stats.fail > 0) {
    console.log('结论：未通过（存在失败项）');
    process.exit(2);
  }
  console.log('结论：通过');
  console.log('=== 验收结束 ===\n');
}

main().catch((err) => {
  console.error('执行失败:', err && err.message ? err.message : err);
  process.exit(1);
});
