#!/usr/bin/env node
/**
 * 查询竞价分发详情（邀请名单、过滤逻辑、梯队划分）
 * 用法：node web/scripts/fetch-bidding-distribution.js <bidding_id>
 * 环境变量：API_BASE、ADMIN_USERNAME、ADMIN_PASSWORD
 */

const https = require('https');
const http = require('http');

const API_BASE = (process.env.API_BASE || 'https://simplewin.cn').replace(/\/$/, '');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const BIDDING_ID = process.argv[2];

if (!BIDDING_ID) {
  console.log('用法: node web/scripts/fetch-bidding-distribution.js <bidding_id>');
  process.exit(1);
}

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
        timeout: 15000,
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

async function main() {
  const loginRes = await request('POST', '/api/v1/admin/login', {
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  if (loginRes.status !== 200 || !loginRes.data?.data?.token) {
    console.error('管理员登录失败');
    process.exit(1);
  }
  const token = loginRes.data.data.token;

  const res = await request('GET', `/api/v1/admin/biddings/${BIDDING_ID}/distribution`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status !== 200 || res.data?.code !== 200) {
    console.error('获取失败:', res.data?.message || res.status);
    if ((res.data?.message || '').includes('不存在')) {
      console.error('提示: 请使用真实的竞价 ID，如 E2E 测试输出的 bidding_id（如 BID1730xxxxxx）');
    }
    process.exit(1);
  }

  const d = res.data.data;
  console.log('\n========== 竞价分发详情 ==========\n');
  console.log('竞价ID:', d.bidding_id);
  console.log('用户ID:', d.user_id);
  console.log('距离范围:', d.range_km, 'km');
  console.log('用户坐标:', d.user_lat, d.user_lng);
  console.log('复杂度等级:', d.complexity_level);
  console.log('第一梯队窗口截止:', d.tier1_window_ends_at || '无');
  console.log('\n--- 分发配置 ---');
  console.log(JSON.stringify(d.config, null, 2));
  console.log('\n--- 过滤逻辑 ---');
  console.log(d.filter_logic);
  console.log('\n--- 梯队划分逻辑 ---');
  console.log(d.tier_logic);
  console.log('\n--- 邀请名单 (' + d.total_invited + ' 家) ---');
  for (const s of d.invited) {
    console.log(`  [${s.tierName}] ${s.name} (${s.shop_id}) 匹配分=${s.match_score} 合规=${s.compliance_rate ?? 'N/A'} 已报价=${s.quoted} ${s.quote_amount ? '金额=' + s.quote_amount : ''}`);
  }
  if (d.filtered_not_invited?.length > 0) {
    console.log('\n--- 通过过滤但未邀请 (' + d.filtered_not_invited.length + ' 家，名额不足) ---');
    for (const s of d.filtered_not_invited) {
      console.log(`  [${s.tierName}] ${s.name} (${s.shop_id}) 匹配分=${s.match_score} 新店=${s.is_new_shop} - ${s.reason}`);
    }
  }
  if (d.diagnostic) {
    console.log('\n--- 诊断（过滤为 0 时） ---');
    console.log('  用户有坐标:', d.diagnostic.user_has_location);
    console.log('  范围内已审核店铺数:', d.diagnostic.shops_in_range_with_qualification ?? 'N/A');
    console.log('  提示:', d.diagnostic.hint);
  }
  console.log('\n====================================\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
