import { useState, useEffect } from 'react';
import {
  Card,
  Button,
  Form,
  InputNumber,
  Select,
  message,
  Typography,
  Space,
  Divider,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { callCloudFunction } from '../utils/api';
import { getDefaultRewardRulesConfig, COMMISSION_REPAIR_CATEGORY_OPTIONS } from '../utils/rewardRulesConfig';

const { Title, Text } = Typography;

const defaultConfig = getDefaultRewardRulesConfig().rewardRules;

function buildCommissionRepair(commissionValues: Record<string, unknown>) {
  const spDef = Number(commissionValues?.commissionSelfPayDefault ?? 6);
  const insDef = Number(commissionValues?.commissionInsuranceDefault ?? 12);
  const rows = (commissionValues?.commissionCategoryRows as Array<Record<string, unknown>>) || [];
  const spCat: Record<string, number> = {};
  const insCat: Record<string, number> = {};
  for (const row of rows) {
    const cat = String(row?.category || '').trim();
    if (!cat) continue;
    if (row?.self_pay != null && row?.self_pay !== '' && !Number.isNaN(Number(row.self_pay))) {
      spCat[cat] = Number(row.self_pay);
    }
    if (row?.insurance != null && row?.insurance !== '' && !Number.isNaN(Number(row.insurance))) {
      insCat[cat] = Number(row.insurance);
    }
  }
  return {
    self_pay: { default: Number.isNaN(spDef) ? 6 : spDef, byCategory: spCat },
    insurance: { default: Number.isNaN(insDef) ? 12 : insDef, byCategory: insCat },
  };
}

export default function CommissionRulesConfig() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [commissionForm] = Form.useForm();
  const [productForm] = Form.useForm();

  const loadConfig = async () => {
    setLoading(true);
    try {
      const result = await callCloudFunction('getRewardRulesConfig', {});
      const rewardRules = result.data || defaultConfig;

      const cr = rewardRules.commissionRepair || defaultConfig.commissionRepair;
      const spBy = cr?.self_pay?.byCategory || {};
      const insBy = cr?.insurance?.byCategory || {};
      const catKeys = [...new Set([...Object.keys(spBy), ...Object.keys(insBy)])];
      const commissionCategoryRows = catKeys.map((k) => ({
        category: k,
        self_pay: spBy[k] ?? undefined,
        insurance: insBy[k] ?? undefined,
      }));
      commissionForm.setFieldsValue({
        commissionSelfPayDefault: cr?.self_pay?.default ?? 6,
        commissionInsuranceDefault: cr?.insurance?.default ?? 12,
        commissionCategoryRows,
      });

      const cfgRes = await callCloudFunction('queryData', { collection: 'system_config' });
      const list = cfgRes.data || [];
      const row = list.find((c: { key: string }) => c.key === 'product_order_platform_fee_rate');
      const raw = row?.value != null ? String(row.value) : '0';
      const r = parseFloat(raw);
      const pct = Number.isFinite(r) ? Math.round(r * 10000) / 100 : 0;
      productForm.setFieldsValue({ productPlatformFeePercent: pct });
    } catch (error: unknown) {
      console.error(error);
      message.error((error as Error)?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await commissionForm.validateFields();
      await productForm.validateFields();
      const commissionValues = commissionForm.getFieldsValue();
      const productValues = productForm.getFieldsValue();
      const commissionRepair = buildCommissionRepair(commissionValues);
      const pct = Number(productValues?.productPlatformFeePercent ?? 0);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        message.error('标品平台抽成比例须在 0～100% 之间');
        setSaving(false);
        return;
      }
      const product_order_platform_fee_rate = pct / 100;
      await callCloudFunction('saveCommissionRules', {
        commissionRepair,
        product_order_platform_fee_rate,
      });
      message.success('保存成功');
    } catch (e: unknown) {
      if ((e as { errorFields?: unknown })?.errorFields) return;
      message.error((e as Error)?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="commission-rules-config" style={{ padding: '0 24px' }}>
      <Title level={2}>佣金规则配置</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
        维修订单固定佣金比例、标品订单平台抽成比例统一在此维护；与奖励金计算相关的其它参数仍在「奖励金规则配置」。
      </Text>

      <Card title="标品订单平台抽成" loading={loading} style={{ marginBottom: 24 }}>
        <Form form={productForm} layout="vertical">
          <Form.Item
            name="productPlatformFeePercent"
            label="平台抽成（占订单实付金额）"
            rules={[{ required: true, message: '请输入' }]}
            tooltip="写入 settings.product_order_platform_fee_rate（0～1），此处按百分比填写"
          >
            <InputNumber min={0} max={100} style={{ width: 200 }} addonAfter="%" />
          </Form.Item>
        </Form>
      </Card>

      <Card title="维修订单固定佣金（付款方 + 可选类目）" loading={loading}>
        <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
          佣金比例按报价行关键词解析类目；未命中类目时用对应付款方 default。与搜索/店铺类目及服务端解析键一致。
        </Text>
        <Form form={commissionForm} layout="vertical" initialValues={{ commissionCategoryRows: [] }}>
          <Title level={5}>默认比例（%）</Title>
          <Space wrap size="large">
            <Form.Item
              name="commissionSelfPayDefault"
              label="车主自费"
              rules={[{ required: true, message: '请输入' }]}
              tooltip="is_insurance_accident=0"
            >
              <InputNumber min={0} max={100} style={{ width: 140 }} addonAfter="%" />
            </Form.Item>
            <Form.Item
              name="commissionInsuranceDefault"
              label="保险事故车"
              rules={[{ required: true, message: '请输入' }]}
              tooltip="is_insurance_accident=1"
            >
              <InputNumber min={0} max={100} style={{ width: 140 }} addonAfter="%" />
            </Form.Item>
          </Space>
          <Divider />
          <Title level={5}>按类目覆盖（可选）</Title>
          <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
            同一类目可分别配置自费、保险费率。
          </Text>
          <Form.List name="commissionCategoryRows">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...rest }) => (
                  <Space key={key} style={{ display: 'flex', marginBottom: 8 }} align="baseline" wrap>
                    <Form.Item
                      {...rest}
                      name={[name, 'category']}
                      rules={[{ required: true, message: '选类目' }]}
                    >
                      <Select
                        placeholder="类目"
                        style={{ width: 140 }}
                        options={COMMISSION_REPAIR_CATEGORY_OPTIONS.map((c) => ({ label: c, value: c }))}
                      />
                    </Form.Item>
                    <Form.Item {...rest} name={[name, 'self_pay']} label="自费%">
                      <InputNumber min={0} max={100} style={{ width: 110 }} addonAfter="%" />
                    </Form.Item>
                    <Form.Item {...rest} name={[name, 'insurance']} label="保险%">
                      <InputNumber min={0} max={100} style={{ width: 110 }} addonAfter="%" />
                    </Form.Item>
                    <Button type="link" danger onClick={() => remove(name)}>
                      删除
                    </Button>
                  </Space>
                ))}
                <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
                  添加类目行
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Card>

      <div style={{ marginTop: 24 }}>
        <Button type="primary" size="large" loading={saving} onClick={handleSave}>
          保存佣金规则
        </Button>
      </div>
    </div>
  );
}
