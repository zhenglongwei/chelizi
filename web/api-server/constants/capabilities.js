/**
 * 能力开关（Capability）常量
 *
 * 说明：
 * - Phase1：仅支持全局开关（settings 表），缺省为启用（不影响现有功能）
 * - Phase2：再扩展到 user/shop/tenant 级 entitlement（不在本文件实现）
 */
const CAPABILITIES = {
  DAMAGE_AI_ANALYZE: 'damage.ai_analyze',
  DAMAGE_REPORT_HISTORY: 'damage.report_history',
  DAMAGE_REPORT_SHARE: 'damage.report_share',
  DIAGNOSIS_IMAGE_ANALYZE: 'diagnosis.image_analyze',
  DIAGNOSIS_DTC_INTERPRET: 'diagnosis.dtc_interpret',
  DIAGNOSIS_SYMPTOM_ANALYZE: 'diagnosis.symptom_analyze',
  PARTS_AUTH_QUERY_BY_CODE: 'parts.auth_query_by_code',
  PARTS_AUTH_QUERY_BY_IMAGE: 'parts.auth_query_by_image',
  PARTS_FITMENT_CHECK_BY_VIN: 'parts.fitment_check_by_vin',
  PARTS_AUTH_RISK_SCORING: 'parts.auth_risk_scoring',
  PARTS_AUTH_SIGNING_PAYLOAD: 'parts.auth_signing_payload',
  ACCIDENT_EVIDENCE_CHECKLIST: 'accident.evidence_checklist',
  ACCIDENT_CLAIM_GUIDE: 'accident.claim_guide',
  ACCIDENT_PRICE_ESTIMATE: 'accident.price_estimate',
  QUOTE_OCR_IMPORT: 'quote.ocr_import',
  REPAIR_TIMELINE_PUBLIC: 'repair.timeline_public',
  REVIEW_PUBLIC_DISPLAY: 'review.public_display',
};

/**
 * settings 表中的 key 约定：
 * - 统一前缀 cap_
 * - value: '1'/'0' 或 true/false（字符串）
 */
const CAPABILITY_SETTING_KEYS = {
  [CAPABILITIES.DAMAGE_AI_ANALYZE]: 'cap_damage_ai_analyze',
  [CAPABILITIES.DAMAGE_REPORT_HISTORY]: 'cap_damage_report_history',
  [CAPABILITIES.DAMAGE_REPORT_SHARE]: 'cap_damage_report_share',
  [CAPABILITIES.DIAGNOSIS_IMAGE_ANALYZE]: 'cap_diagnosis_image_analyze',
  [CAPABILITIES.DIAGNOSIS_DTC_INTERPRET]: 'cap_diagnosis_dtc_interpret',
  [CAPABILITIES.DIAGNOSIS_SYMPTOM_ANALYZE]: 'cap_diagnosis_symptom_analyze',
  [CAPABILITIES.PARTS_AUTH_QUERY_BY_CODE]: 'cap_parts_auth_query_by_code',
  [CAPABILITIES.PARTS_AUTH_QUERY_BY_IMAGE]: 'cap_parts_auth_query_by_image',
  [CAPABILITIES.PARTS_FITMENT_CHECK_BY_VIN]: 'cap_parts_fitment_check_by_vin',
  [CAPABILITIES.PARTS_AUTH_RISK_SCORING]: 'cap_parts_auth_risk_scoring',
  [CAPABILITIES.PARTS_AUTH_SIGNING_PAYLOAD]: 'cap_parts_auth_signing_payload',
  [CAPABILITIES.ACCIDENT_EVIDENCE_CHECKLIST]: 'cap_accident_evidence_checklist',
  [CAPABILITIES.ACCIDENT_CLAIM_GUIDE]: 'cap_accident_claim_guide',
  [CAPABILITIES.ACCIDENT_PRICE_ESTIMATE]: 'cap_accident_price_estimate',
  [CAPABILITIES.QUOTE_OCR_IMPORT]: 'cap_quote_ocr_import',
  [CAPABILITIES.REPAIR_TIMELINE_PUBLIC]: 'cap_repair_timeline_public',
  [CAPABILITIES.REVIEW_PUBLIC_DISPLAY]: 'cap_review_public_display',
};

/** Phase1 默认：不改现有行为 → 全部 true（仅当 settings 显式关闭才禁用） */
const CAPABILITY_DEFAULTS = Object.freeze(
  Object.values(CAPABILITIES).reduce((acc, k) => {
    acc[k] = true;
    return acc;
  }, {})
);

module.exports = {
  CAPABILITIES,
  CAPABILITY_SETTING_KEYS,
  CAPABILITY_DEFAULTS,
};

