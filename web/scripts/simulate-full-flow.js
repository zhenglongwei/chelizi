#!/usr/bin/env node
/**
 * 定损 → 竞价 → 选厂 → 接单 → 维修 → 确认 → 评价 → 返佣 全流程模拟
 *
 * 用法：
 *   cd web
 *   node scripts/simulate-full-flow.js
 *
 * 环境变量：
 *   API_BASE   API 地址，默认 http://localhost:3000
 *   USER_ID    测试用户 ID，默认 USER001
 *   MERCHANT_PHONE  服务商手机号，默认 18658823459
 *   MERCHANT_PASSWORD  服务商密码，默认 123456（仅 test-token 用）
 *
 * 前置条件：
 *   - API 服务已启动（npm run dev 或 node api-server/server.js）
 *   - 数据库已执行 schema.sql（含 users、shops、merchant_users seed）
 *   - merchant_users 中 18658823459 已存在且 status=1
 */

const http = require('http');
const https = require('https');

const API_BASE = process.env.API_BASE || 'https://simplewin.cn:3000';
const USER_ID = process.env.USER_ID || 'USER001';
const MERCHANT_PHONE = process.env.MERCHANT_PHONE || '18658823459';
const MERCHANT_PASSWORD = process.env.MERCHANT_PASSWORD || '123456';

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        }
      },
      (res) => {
        let buf = '';
        res.on('data', (ch) => (buf += ch));
        res.on('end', () => {
          try {
            const json = JSON.parse(buf || '{}');
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json);
            } else {
              reject(new Error(json.message || buf || `HTTP ${res.statusCode}`));
            }
          } catch {
            reject(new Error(buf || `HTTP ${res.statusCode}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  console.log('车厘子 - 定损到返佣全流程模拟');
  console.log('API:', API_BASE);
  console.log('用户:', USER_ID, '| 服务商:', MERCHANT_PHONE);
  console.log('');

  try {
    const res = await request('POST', '/api/v1/dev/simulate-full-flow', {
      user_id: USER_ID,
      merchant_phone: MERCHANT_PHONE,
      merchant_password: MERCHANT_PASSWORD
    });

    if (res.code !== 200) {
      throw new Error(res.message || '请求失败');
    }

    const d = res.data || {};
    console.log('✅ 全流程模拟完成\n');
    console.log('步骤摘要：');
    (d.steps || []).forEach((s, i) => {
      const msg = s.skip ? `  ⚠ ${s.step}: ${s.skip}` : `  ${i + 1}. ${s.step}`;
      console.log(msg);
      if (!s.skip && Object.keys(s).filter((k) => k !== 'step').length > 1) {
        Object.entries(s)
          .filter(([k]) => k !== 'step')
          .forEach(([k, v]) => console.log(`     ${k}: ${v}`));
      }
    });
    console.log('');
    console.log('生成数据：');
    console.log('  report_id:', d.report_id);
    console.log('  bidding_id:', d.bidding_id);
    console.log('  order_id:', d.order_id);
    console.log('  review_id:', d.review_id);
    console.log('  返佣金额:', d.rebate_amount, '元 (8%)');
  } catch (err) {
    console.error('❌ 模拟失败:', err.message);
    process.exit(1);
  }
}

main();
