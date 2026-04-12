/**
 * 电子质保凭证 · 样式预览用示例数据（非真实订单）
 */

const SAMPLE_ITEMS = [
  {
    damage_part: '前保险杠（右侧）',
    repair_type: '喷漆',
    parts_type: '',
    warranty_months: 12
  },
  {
    damage_part: '右前大灯总成',
    repair_type: '换',
    parts_type: '原厂件',
    warranty_months: 24
  },
  {
    damage_part: '空调冷凝器',
    repair_type: '换',
    parts_type: '品牌件',
    warranty_months: 12
  }
];

const DEMO_ORDER_ID = 'ZJ-DEMO-20260402-001';
const DEMO_VEHICLE = '示例 · 大众 朗逸 1.5L · 浙A·DEMO0';
const DEMO_ANTI_FAKE = '8f3a9c2b1d4e5f6a0a1b2c3d4e5f6a7';
const DEMO_GENERATED_AT = '2026-04-02 15:00:00';
const DEMO_WARRANTY_START = '2026-04-02';

function buildMerchantStylePreviewCard(shopName, template) {
  const tpl = template || { id: 1, name: '经典金', theme: 'gold', theme_label: '金色' };
  return {
    card_phase: 'merchant_style_demo',
    shop_name: shopName && String(shopName).trim() ? String(shopName).trim() : '示例机动车维修服务中心',
    order_id: DEMO_ORDER_ID,
    vehicle_summary: DEMO_VEHICLE,
    warranty_start_rule: '分项质保期自车主确认维修完成之日起计算',
    warranty_start_at_display: DEMO_WARRANTY_START,
    preview_message: '',
    items: SAMPLE_ITEMS.map((x) => ({ ...x })),
    template: { name: tpl.name, theme: tpl.theme, theme_label: tpl.theme_label },
    disclaimer:
      '本卡为样式预览：分项质保、订单号与存证防伪码均为示例。正式凭证以车主确认完工后辙见根据已确认方案固化内容为准；质保履行请联系出具方维修厂。',
    anti_fake_code: DEMO_ANTI_FAKE,
    generated_at_display: DEMO_GENERATED_AT,
    share_hint: null
  };
}

module.exports = {
  SAMPLE_ITEMS,
  DEMO_ORDER_ID,
  DEMO_VEHICLE,
  DEMO_ANTI_FAKE,
  DEMO_GENERATED_AT,
  DEMO_WARRANTY_START,
  buildMerchantStylePreviewCard
};
