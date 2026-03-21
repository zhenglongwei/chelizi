#!/usr/bin/env node
/**
 * 订阅消息配置与前端逻辑校验
 * 不依赖 API、数据库、微信环境
 *
 * 用法：node web/scripts/test-subscribe-config.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const results = { pass: 0, fail: 0 };

function ok(name) {
  results.pass++;
  console.log(`  ✓ ${name}`);
}

function fail(name, msg) {
  results.fail++;
  console.log(`  ✗ ${name}: ${msg}`);
}

// 1. config.js 必须有 SUBSCRIBE_TEMPLATE_IDS
function checkConfig() {
  console.log('\n=== 1. config.js 配置 ===');
  const configPath = path.join(ROOT, 'config.js');
  if (!fs.existsSync(configPath)) {
    fail('config.js 存在', '文件不存在');
    return;
  }
  ok('config.js 存在');

  const config = require(configPath);
  const ids = config.SUBSCRIBE_TEMPLATE_IDS;
  if (!ids || typeof ids !== 'object') {
    fail('SUBSCRIBE_TEMPLATE_IDS', '未配置或格式错误');
    return;
  }
  ok('SUBSCRIBE_TEMPLATE_IDS 已配置');

  const required = ['user_order_update', 'merchant_bidding_new', 'merchant_order_new', 'merchant_qualification_audit', 'merchant_material_audit'];
  for (const k of required) {
    if (ids[k] && typeof ids[k] === 'string' && ids[k].length > 0) {
      ok(`  ${k}`);

    } else {
      fail(`  ${k}`, '未配置或为空');
    }
  }
}

// 2. utils/subscribe.js 导出正确
function checkSubscribeUtil() {
  console.log('\n=== 2. utils/subscribe.js ===');
  const subPath = path.join(ROOT, 'utils', 'subscribe.js');
  if (!fs.existsSync(subPath)) {
    fail('subscribe.js 存在', '文件不存在');
    return;
  }
  ok('subscribe.js 存在');

  const content = fs.readFileSync(subPath, 'utf8');
  const hasRequestUser = content.includes('requestUserSubscribe');
  const hasRequestMerchant = content.includes('requestMerchantSubscribe');
  const hasRequestSubscribe = content.includes('requestSubscribe');
  const hasWxRequest = content.includes('wx.requestSubscribeMessage');

  if (hasRequestUser) ok('requestUserSubscribe');
  else fail('requestUserSubscribe', '未导出');
  if (hasRequestMerchant) ok('requestMerchantSubscribe');
  else fail('requestMerchantSubscribe', '未导出');
  if (hasRequestSubscribe) ok('requestSubscribe');
  else fail('requestSubscribe', '未导出');
  if (hasWxRequest) ok('wx.requestSubscribeMessage 调用');
  else fail('wx.requestSubscribeMessage', '未调用');
}

// 3. 各页面正确引用并调用
function checkPageCalls() {
  console.log('\n=== 3. 前端授权调用 ===');

  const checks = [
    { file: 'pages/bidding/detail/index.js', fn: 'requestUserSubscribe', scene: 'order_update' },
    { file: 'pages/merchant/bidding/list/index.js', fn: 'requestMerchantSubscribe', scene: 'bidding_new' },
    { file: 'pages/merchant/order/list/index.js', fn: 'requestMerchantSubscribe', scene: 'order_new' },
    { file: 'pages/merchant/shop/profile/index.js', fn: 'requestMerchantSubscribe', scene: 'qualification_audit' },
    { file: 'pages/merchant/order/detail/index.js', fn: 'requestMerchantSubscribe', scene: 'material_audit' },
  ];

  for (const c of checks) {
    const p = path.join(ROOT, c.file);
    if (!fs.existsSync(p)) {
      fail(c.file, '文件不存在');
      continue;
    }
    const content = fs.readFileSync(p, 'utf8');
    const hasImport = content.includes(`require(`) && content.includes('subscribe');
    const hasCall = content.includes(`${c.fn}(`);

    if (hasImport && hasCall) ok(`${c.file} (${c.scene})`);
    else if (!hasImport) fail(c.file, '未引用 subscribe');
    else fail(c.file, `未调用 ${c.fn}`);
  }
}

// 4. merchant/home 调用 bindOpenid
function checkBindOpenid() {
  console.log('\n=== 4. 服务商 openid 绑定 ===');

  const homePath = path.join(ROOT, 'pages', 'merchant', 'home.js');
  if (!fs.existsSync(homePath)) {
    fail('merchant/home.js', '文件不存在');
    return;
  }
  const content = fs.readFileSync(homePath, 'utf8');
  const hasBindOpenid = content.includes('bindOpenid');
  const hasMerchantBindOpenid = content.includes('merchantBindOpenid');
  const hasWxLogin = content.includes('wx.login');

  if (hasBindOpenid && hasMerchantBindOpenid && hasWxLogin) {
    ok('merchant/home 调用 bindOpenid + wx.login + merchantBindOpenid');
  } else {
    fail('merchant/home', `bindOpenid=${!!hasBindOpenid} merchantBindOpenid=${!!hasMerchantBindOpenid} wx.login=${!!hasWxLogin}`);
  }
}

// 5. subscribe-message-service 模板配置
function checkServiceTemplates() {
  console.log('\n=== 5. 服务端模板配置 ===');

  const svcPath = path.join(ROOT, 'web', 'api-server', 'services', 'subscribe-message-service.js');
  if (!fs.existsSync(svcPath)) {
    fail('subscribe-message-service.js', '文件不存在');
    return;
  }
  const content = fs.readFileSync(svcPath, 'utf8');

  const templateKeys = ['user_order_update', 'user_bidding_quote', 'merchant_bidding_new', 'merchant_order_new', 'merchant_qualification_audit', 'merchant_material_audit'];
  for (const k of templateKeys) {
    if (content.includes(k)) ok(`TEMPLATE_CONFIG.${k}`);
    else fail(`TEMPLATE_CONFIG.${k}`, '未配置');
  }

  if (content.includes('sendToUser') && content.includes('sendToMerchant')) ok('sendToUser / sendToMerchant 导出');
  else fail('sendToUser/sendToMerchant', '未导出');
}

function main() {
  console.log('订阅消息配置与前端逻辑校验');
  console.log('项目根目录:', ROOT);

  checkConfig();
  checkSubscribeUtil();
  checkPageCalls();
  checkBindOpenid();
  checkServiceTemplates();

  console.log('\n=== 汇总 ===');
  console.log(`通过: ${results.pass} | 失败: ${results.fail}`);
  process.exit(results.fail > 0 ? 1 : 0);
}

main();
