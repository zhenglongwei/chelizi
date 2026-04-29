#!/usr/bin/env node
/**
 * OpenAPI 最小示例：调用事故报告增强能力（P1）
 *
 * 用法：
 *   OPEN_API_KEY=xxx BASE_URL=https://simplewin.cn node web/scripts/demo-openapi-accident-assistant.js
 *
 * 前置：
 * - DB 已执行 migration-20260426-api-keys-and-audit.sql 与 migration-20260427-api-key-capabilities.sql
 * - api_key_capabilities 为该 api_key_id 开通了：
 *   - accident.evidence_checklist
 *   - accident.claim_guide
 *   - accident.price_estimate
 */

const { ZhejianOpenApiClient } = require('../sdk/zhejian-openapi');

async function main() {
  const baseUrl = String(process.env.BASE_URL || '').trim() || 'http://localhost:3000';
  const apiKey = String(process.env.OPEN_API_KEY || process.env.OPENAPI_KEY || '').trim();
  if (!apiKey) {
    console.error('Missing OPEN_API_KEY env');
    process.exit(2);
  }

  const client = new ZhejianOpenApiClient({ baseUrl, apiKey });
  const caps = await client.getOpenCapabilities();
  console.log('[caps]', caps);

  const analysis_result = {
    total_estimate: [1800, 2600],
    damages: [{ part: '前保险杠', type: '裂纹' }],
    repair_suggestions: [{ item: '前保险杠', price_range: [1800, 2600] }],
  };

  const evidence = await client.accidentEvidenceChecklist({ analysis_result, user_description: '前脸轻微碰撞，掉漆' });
  console.log('[evidence_checklist]', evidence);

  const guide = await client.accidentClaimGuide({ is_insurance: true, has_police_report: false, has_other_party: true });
  console.log('[claim_guide]', guide);

  const price = await client.accidentPriceEstimate({ analysis_result, city_tier: 'tier1', parts_type: 'aftermarket' });
  console.log('[price_estimate]', price);
}

main().catch((e) => {
  console.error('demo failed:', e && e.message);
  process.exit(1);
});

