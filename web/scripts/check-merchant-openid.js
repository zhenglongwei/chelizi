#!/usr/bin/env node
/**
 * 检查服务商 openid 绑定状态
 * 用法: node web/scripts/check-merchant-openid.js
 * 需配置 .env 中的 DB_* 或通过环境变量
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'zhejian',
  });
  const [rows] = await pool.execute(
    `SELECT mu.merchant_id, mu.shop_id, mu.phone, mu.openid, s.name as shop_name
     FROM merchant_users mu
     LEFT JOIN shops s ON s.shop_id = mu.shop_id
     WHERE mu.status = 1
     ORDER BY mu.merchant_id`
  );
  console.log('服务商 openid 绑定状态:\n');
  let bound = 0;
  let unbound = 0;
  for (const r of rows) {
    const hasOpenid = !!(r.openid && String(r.openid).trim());
    if (hasOpenid) bound++;
    else unbound++;
    const status = hasOpenid ? '✓ 已绑定' : '✗ 未绑定';
    console.log(`  ${r.phone} | ${r.shop_name || r.shop_id} | ${status}`);
  }
  console.log(`\n合计: ${bound} 已绑定, ${unbound} 未绑定`);
  if (unbound > 0) {
    console.log('\n未绑定说明: 服务商需登录小程序，进入工作台(pages/merchant/home)触发 bindOpenid');
  }
  pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
