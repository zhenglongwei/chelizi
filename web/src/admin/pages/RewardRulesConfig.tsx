import { useState, useEffect, useRef } from 'react';
import {
  Card,
  Table,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  message,
  Typography,
  Space,
  Tabs,
  Divider,
  Alert,
  Switch,
} from 'antd';
import { PlusOutlined, EditOutlined } from '@ant-design/icons';
import { callCloudFunction } from '../utils/api';
import { getDefaultRewardRulesConfig } from '../utils/rewardRulesConfig';

const { Title, Text } = Typography;

// 复杂度：等级 + 关键词 + 固定奖励（保存时仍写入 float_ratio/cap_amount=0 以兼容库结构）
type ComplexityRow = {
  level: string;
  project_type: string;
  fixed_reward: number;
};

const defaultConfig = getDefaultRewardRulesConfig().rewardRules;

/** 与 `web/api-server/constants/platform-reward-v1.js` 默认一致，供后台表单缺省 */
const defaultPlatformIncentiveV1 = {
  enabled: true,
  disableAiPremiumFloat: true,
  settleUpgradeDiffEnabled: false,
  conversionPoolShare: 0.1,
  postVerifySharesConversionPool: true,
  compliancePreTaxOnly: true,
  maxUserRewardPctOfCommission: 0.8,
  baseInteractionCapPct: 70,
  phi: [0, 0.6, 0.85, 1, 1] as number[],
  psi: [0, 0.75, 1, 1, 1.05] as number[],
  thetaCap: 0.65,
  attributionWindowDays: 7,
  disableOrderTierCap: true,
  neutralizeContentQualityInConversionWeight: true,
  shopScoreIgnoreContentQualityLevel: true,
  shopScoreWeights: [0.28, 0.22, 0.22, 0.18, 0.1] as number[],
  interaction: {
    sE: 5,
    sR: 300,
    rhoCap: 0.5,
    tau: 0.25,
    eta: { E: 0.1, R: 0.0005, L: 0.2, C: 0.5, rho: 2.0 },
    coldStartD: 50,
  },
};

function mergePlatformIncentiveV1(raw: any) {
  const p = { ...defaultPlatformIncentiveV1, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (raw?.interaction && typeof raw.interaction === 'object') {
    p.interaction = { ...defaultPlatformIncentiveV1.interaction, ...raw.interaction };
    if (raw.interaction.eta && typeof raw.interaction.eta === 'object') {
      p.interaction.eta = { ...defaultPlatformIncentiveV1.interaction.eta, ...raw.interaction.eta };
    }
  }
  const phi = Array.isArray(p.phi) && p.phi.length === 5 ? p.phi : defaultPlatformIncentiveV1.phi;
  const psi = Array.isArray(p.psi) && p.psi.length === 5 ? p.psi : defaultPlatformIncentiveV1.psi;
  const sw =
    Array.isArray(p.shopScoreWeights) && p.shopScoreWeights.length === 5
      ? p.shopScoreWeights
      : defaultPlatformIncentiveV1.shopScoreWeights;
  return { ...p, phi, psi, shopScoreWeights: sw };
}

export default function RewardRulesConfig() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [complexityLevels, setComplexityLevels] = useState<ComplexityRow[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [form] = Form.useForm();
  const [baseRewardForm] = Form.useForm();
  const [vehicleForm] = Form.useForm();
  const [orderForm] = Form.useForm();
  const [complianceForm] = Form.useForm();
  const [platformForm] = Form.useForm();
  /** 保存接口未在表单暴露的字段（如 shopScoreWeights），避免整包覆盖时丢失 */
  const lastLoadedPlatformIncentiveRef = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const result = await callCloudFunction('getRewardRulesConfig', {});
      const rewardRules = result.data || defaultConfig;

      // 模块 1：复杂度等级（兼容旧格式：projectType/fixedReward 等）
      const levels = rewardRules.complexityLevels || [];
      const normalized = levels.map((r: any) => ({
        level: r.level || r.id || 'L2',
        project_type: r.project_type ?? r.projectType ?? r.projectTypes ?? '',
        fixed_reward: Number(r.fixed_reward ?? r.fixedReward ?? 0),
      }));
      setComplexityLevels(normalized.length ? normalized : []);

      // 基础固定奖励（方案A：已去掉维修复杂度校准系数）
      baseRewardForm.setFieldsValue({
        baseRewardL1: rewardRules.baseReward?.L1 ?? 10,
        baseRewardL2: rewardRules.baseReward?.L2 ?? 30,
        baseRewardL3: rewardRules.baseReward?.L3 ?? 150,
        baseRewardL4: rewardRules.baseReward?.L4 ?? 450,
        baseRewardInsuranceL1: rewardRules.baseRewardInsurance?.L1 ?? 20,
        baseRewardInsuranceL2: rewardRules.baseRewardInsurance?.L2 ?? 60,
        baseRewardInsuranceL3: rewardRules.baseRewardInsurance?.L3 ?? 300,
        baseRewardInsuranceL4: rewardRules.baseRewardInsurance?.L4 ?? 900,
      });

      // 模块 2：车价分级
      const vc = rewardRules.vehicleCoeff || [];
      vehicleForm.setFieldsValue({
        vehicleTierLowMax: rewardRules.vehicleTierLowMax ?? 100000,
        vehicleTierMediumMax: rewardRules.vehicleTierMediumMax ?? 300000,
        vehicleCoeff1Max: vc[0]?.max ?? 10,
        vehicleCoeff1Coeff: vc[0]?.coeff ?? 1.0,
        vehicleCoeff2Max: vc[1]?.max ?? 20,
        vehicleCoeff2Coeff: vc[1]?.coeff ?? 1.2,
        vehicleCoeff3Max: vc[2]?.max ?? 30,
        vehicleCoeff3Coeff: vc[2]?.coeff ?? 1.5,
        vehicleCoeff4Max: vc[3]?.max ?? 50,
        vehicleCoeff4Coeff: vc[3]?.coeff ?? 2.0,
        vehicleCoeff5Max: vc[4]?.max ?? 9999,
        vehicleCoeff5Coeff: vc[4]?.coeff ?? 3.0,
      });

      // 模块 3：订单分级
      orderForm.setFieldsValue({
        orderTier1Max: rewardRules.orderTier1Max ?? 1000,
        orderTier2Max: rewardRules.orderTier2Max ?? 5000,
        orderTier3Max: rewardRules.orderTier3Max ?? 20000,
      });

      // 模块 4：合规规则
      complianceForm.setFieldsValue({
        complianceRedLine: rewardRules.complianceRedLine ?? 70,
      });

      lastLoadedPlatformIncentiveRef.current =
        rewardRules.platformIncentiveV1 && typeof rewardRules.platformIncentiveV1 === 'object'
          ? rewardRules.platformIncentiveV1
          : null;
      const pi = mergePlatformIncentiveV1(rewardRules.platformIncentiveV1);
      const eta = pi.interaction?.eta || defaultPlatformIncentiveV1.interaction.eta;
      platformForm.setFieldsValue({
        platformEnabled: pi.enabled !== false,
        disableAiPremiumFloat: pi.disableAiPremiumFloat !== false,
        settleUpgradeDiffEnabled: !!pi.settleUpgradeDiffEnabled,
        postVerifySharesConversionPool: pi.postVerifySharesConversionPool !== false,
        compliancePreTaxOnly: pi.compliancePreTaxOnly !== false,
        conversionPoolSharePct: Math.round((pi.conversionPoolShare ?? 0.1) * 1000) / 10,
        maxUserRewardPct: Math.round((pi.maxUserRewardPctOfCommission ?? 0.8) * 1000) / 10,
        baseInteractionCapPct: pi.baseInteractionCapPct ?? 70,
        attributionWindowDays: pi.attributionWindowDays ?? 7,
        thetaCap: pi.thetaCap ?? 0.65,
        neutralizeContentQualityInConversionWeight: pi.neutralizeContentQualityInConversionWeight !== false,
        shopScoreIgnoreContentQualityLevel: pi.shopScoreIgnoreContentQualityLevel !== false,
        intSE: pi.interaction?.sE ?? 5,
        intSR: pi.interaction?.sR ?? 300,
        intRhoCap: pi.interaction?.rhoCap ?? 0.5,
        intTau: pi.interaction?.tau ?? 0.25,
        intColdStartD: pi.interaction?.coldStartD ?? 50,
        intEtaE: eta.E,
        intEtaR: eta.R,
        intEtaL: eta.L,
        intEtaC: eta.C,
        intEtaRho: eta.rho,
        ...[0, 1, 2, 3, 4].reduce(
          (acc, i) => {
            acc[`phi${i}`] = pi.phi[i];
            acc[`psi${i}`] = pi.psi[i];
            return acc;
          },
          {} as Record<string, number>
        ),
      });

    } catch (error: any) {
      console.error('加载配置失败:', error);
      message.error(error?.message || '加载配置失败');
      setComplexityLevels([]);
    } finally {
      setLoading(false);
    }
  };

  /** 不含 commissionRepair，服务端保存时合并保留（见佣金规则配置页） */
  const buildFullConfig = (): Record<string, any> => {
    const [baseValues, vehicleValues, orderValues, complianceValues, platformValues] = [
      baseRewardForm.getFieldsValue(),
      vehicleForm.getFieldsValue(),
      orderForm.getFieldsValue(),
      complianceForm.getFieldsValue(),
      platformForm.getFieldsValue(),
    ];
    const convPct = Number(platformValues?.conversionPoolSharePct ?? 10);
    const maxPct = Number(platformValues?.maxUserRewardPct ?? 80);
    const basePi = mergePlatformIncentiveV1(lastLoadedPlatformIncentiveRef.current);
    const platformIncentiveV1 = {
      ...basePi,
      enabled: platformValues?.platformEnabled !== false,
      disableAiPremiumFloat: platformValues?.disableAiPremiumFloat !== false,
      settleUpgradeDiffEnabled: !!platformValues?.settleUpgradeDiffEnabled,
      postVerifySharesConversionPool: platformValues?.postVerifySharesConversionPool !== false,
      compliancePreTaxOnly: platformValues?.compliancePreTaxOnly !== false,
      conversionPoolShare: Math.min(1, Math.max(0, convPct / 100)),
      maxUserRewardPctOfCommission: Math.min(1, Math.max(0, maxPct / 100)),
      baseInteractionCapPct: Number(platformValues?.baseInteractionCapPct ?? 70),
      attributionWindowDays: Number(platformValues?.attributionWindowDays ?? 7),
      thetaCap: Math.min(1, Math.max(0, Number(platformValues?.thetaCap ?? 0.65))),
      disableOrderTierCap: true,
      neutralizeContentQualityInConversionWeight: platformValues?.neutralizeContentQualityInConversionWeight !== false,
      shopScoreIgnoreContentQualityLevel: platformValues?.shopScoreIgnoreContentQualityLevel !== false,
      phi: [0, 1, 2, 3, 4].map((i) => {
        const x = Number(platformValues?.[`phi${i}`]);
        return Number.isFinite(x) ? x : basePi.phi[i];
      }),
      psi: [0, 1, 2, 3, 4].map((i) => {
        const x = Number(platformValues?.[`psi${i}`]);
        return Number.isFinite(x) ? x : basePi.psi[i];
      }),
      interaction: {
        ...basePi.interaction,
        sE: Number(platformValues?.intSE ?? 5),
        sR: Number(platformValues?.intSR ?? 300),
        rhoCap: Number(platformValues?.intRhoCap ?? 0.5),
        tau: Number(platformValues?.intTau ?? 0.25),
        coldStartD: Number(platformValues?.intColdStartD ?? 50),
        eta: {
          ...(basePi.interaction?.eta || defaultPlatformIncentiveV1.interaction.eta),
          E: Number(platformValues?.intEtaE ?? 0.1),
          R: Number(platformValues?.intEtaR ?? 0.0005),
          L: Number(platformValues?.intEtaL ?? 0.2),
          C: Number(platformValues?.intEtaC ?? 0.5),
          rho: Number(platformValues?.intEtaRho ?? 2.0),
        },
      },
    };
    const zeroL = { L1: 0, L2: 0, L3: 0, L4: 0 };
    return {
      complexityLevels: complexityLevels.map((r) => ({
        level: r.level,
        project_type: r.project_type,
        fixed_reward: r.fixed_reward,
        float_ratio: 0,
        cap_amount: 0,
      })),
      baseReward: {
        L1: baseValues?.baseRewardL1 ?? 10,
        L2: baseValues?.baseRewardL2 ?? 30,
        L3: baseValues?.baseRewardL3 ?? 150,
        L4: baseValues?.baseRewardL4 ?? 450,
      },
      baseRewardInsurance: {
        L1: baseValues?.baseRewardInsuranceL1 ?? 20,
        L2: baseValues?.baseRewardInsuranceL2 ?? 60,
        L3: baseValues?.baseRewardInsuranceL3 ?? 300,
        L4: baseValues?.baseRewardInsuranceL4 ?? 900,
      },
      vehicleTierLowMax: vehicleValues?.vehicleTierLowMax ?? 100000,
      vehicleTierMediumMax: vehicleValues?.vehicleTierMediumMax ?? 300000,
      vehicleTierLowCapUp: 0,
      vehicleCoeff: [
        { max: vehicleValues?.vehicleCoeff1Max ?? 10, coeff: vehicleValues?.vehicleCoeff1Coeff ?? 1.0 },
        { max: vehicleValues?.vehicleCoeff2Max ?? 20, coeff: vehicleValues?.vehicleCoeff2Coeff ?? 1.2 },
        { max: vehicleValues?.vehicleCoeff3Max ?? 30, coeff: vehicleValues?.vehicleCoeff3Coeff ?? 1.5 },
        { max: vehicleValues?.vehicleCoeff4Max ?? 50, coeff: vehicleValues?.vehicleCoeff4Coeff ?? 2.0 },
        { max: vehicleValues?.vehicleCoeff5Max ?? 9999, coeff: vehicleValues?.vehicleCoeff5Coeff ?? 3.0 },
      ],
      lowEndL4Amplify: 1,
      floatCalibration: {
        low: { ...zeroL },
        medium: { ...zeroL },
        high: { ...zeroL },
      },
      orderTier1Max: orderValues?.orderTier1Max ?? 1000,
      orderTier2Max: orderValues?.orderTier2Max ?? 5000,
      orderTier3Max: orderValues?.orderTier3Max ?? 20000,
      orderTier1Cap: 0,
      orderTier2Cap: 0,
      orderTier3Cap: 0,
      orderTier4Cap: 0,
      complianceRedLine: complianceValues?.complianceRedLine ?? 70,
      upgradeMaxPer3Months: 0,
      upgradeReviewHours: 0,
      platformIncentiveV1,
    };
  };

  const saveRewardRulesConfig = async (config: Record<string, any>) => {
    try {
      await callCloudFunction('saveRewardRulesConfig', { config });
      message.success('保存成功');
    } catch (e: any) {
      message.error(e?.message || '保存失败');
      throw e;
    }
  };

  const handleSaveComplexity = async (values: any) => {
    const item: ComplexityRow = {
      level: values.level,
      project_type: values.project_type?.trim() || '',
      fixed_reward: Number(values.fixed_reward),
    };
    const newLevels = [...complexityLevels];
    if (editingIndex !== null) {
      newLevels[editingIndex] = item;
    } else {
      newLevels.push(item);
    }
    setComplexityLevels(newLevels);
    setModalVisible(false);
    const fullConfig = buildFullConfig();
    fullConfig.complexityLevels = newLevels.map((r) => ({
      level: r.level,
      project_type: r.project_type,
      fixed_reward: r.fixed_reward,
      float_ratio: 0,
      cap_amount: 0,
    }));
    await saveRewardRulesConfig(fullConfig);
  };

  const handleEditComplexity = (record: ComplexityRow, index: number) => {
    setEditingIndex(index);
    form.setFieldsValue({
      level: record.level,
      project_type: record.project_type,
      fixed_reward: record.fixed_reward,
    });
    setModalVisible(true);
  };

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      await Promise.all([
        baseRewardForm.validateFields().catch(() => null),
        vehicleForm.validateFields().catch(() => null),
        orderForm.validateFields().catch(() => null),
        complianceForm.validateFields().catch(() => null),
        platformForm.validateFields().catch(() => null),
      ]);
      const config = buildFullConfig();
      await saveRewardRulesConfig(config);
      message.success('全部配置保存成功');
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const complexityColumns = [
    { title: '等级', dataIndex: 'level', key: 'level', width: 60 },
    { title: '维修项目关键词', dataIndex: 'project_type', key: 'project_type', ellipsis: true, render: (v: string) => v || '-' },
    { title: '固定奖励(元)', dataIndex: 'fixed_reward', key: 'fixed_reward', width: 100 },
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_: any, record: ComplexityRow, index: number) => (
        <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEditComplexity(record, index)}>
          编辑
        </Button>
      ),
    },
  ];

  return (
    <div className="reward-rules-config" style={{ padding: '0 24px' }}>
      <Title level={2}>奖励金规则配置</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
        模块 1～4：基础轨（复杂度关键词、车价系数、订单金额分级阈值、合规红线）；模块 5：<strong>互动轨 / 转化轨</strong>等 <code>platformIncentiveV1</code>。维修/标品佣金请在侧栏「佣金规则配置」维护。
      </Text>

      <Tabs
        defaultActiveKey="1"
        items={[
          {
            key: '1',
            label: '模块1 复杂度等级',
            children: (
              <Card title="维修项目复杂度等级核心配置" loading={loading}>
                <Title level={5}>基础固定奖励（按等级，方案A：已去掉维修复杂度校准系数）</Title>
                <Form form={baseRewardForm} layout="inline" style={{ marginBottom: 16 }}>
                  <Space wrap size="middle">
                    <Form.Item name="baseRewardL1" label="L1 普通">
                      <InputNumber min={0} style={{ width: 80 }} addonAfter="元" />
                    </Form.Item>
                    <Form.Item name="baseRewardL2" label="L2 普通">
                      <InputNumber min={0} style={{ width: 80 }} addonAfter="元" />
                    </Form.Item>
                    <Form.Item name="baseRewardL3" label="L3 普通">
                      <InputNumber min={0} style={{ width: 80 }} addonAfter="元" />
                    </Form.Item>
                    <Form.Item name="baseRewardL4" label="L4 普通">
                      <InputNumber min={0} style={{ width: 80 }} addonAfter="元" />
                    </Form.Item>
                    <Form.Item name="baseRewardInsuranceL1" label="L1 保险事故">
                      <InputNumber min={0} style={{ width: 80 }} addonAfter="元" />
                    </Form.Item>
                    <Form.Item name="baseRewardInsuranceL2" label="L2 保险事故">
                      <InputNumber min={0} style={{ width: 80 }} addonAfter="元" />
                    </Form.Item>
                    <Form.Item name="baseRewardInsuranceL3" label="L3 保险事故">
                      <InputNumber min={0} style={{ width: 80 }} addonAfter="元" />
                    </Form.Item>
                    <Form.Item name="baseRewardInsuranceL4" label="L4 保险事故">
                      <InputNumber min={0} style={{ width: 80 }} addonAfter="元" />
                    </Form.Item>
                  </Space>
                </Form>
                <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
                  公式：基础奖励 = 上方「按等级」基础固定奖励 × 车价校准系数，且不超过实收佣金 × 合规红线%。下方表格用于<strong>关键词匹配复杂度等级</strong>；「固定奖励」列仅作对照，计算以顶部 L1～L4 为准。
                </Text>
                <p style={{ marginBottom: 16, color: '#666' }}>
                  每行：等级、维修项目关键词（支持 | 或 , 分隔）、固定奖励（可选与顶部同档对齐）。
                </p>
                <Table
                  columns={complexityColumns}
                  dataSource={complexityLevels}
                  rowKey={(_, i) => `${i}`}
                  pagination={false}
                  size="small"
                />
                <Button
                  type="dashed"
                  icon={<PlusOutlined />}
                  onClick={() => {
                    setEditingIndex(null);
                    form.resetFields();
                    form.setFieldsValue({ level: 'L1', project_type: '', fixed_reward: 10 });
                    setModalVisible(true);
                  }}
                  style={{ marginTop: 16 }}
                >
                  新增项目类型
                </Button>
              </Card>
            ),
          },
          {
            key: '2',
            label: '模块2 车价分级',
            children: (
              <Card title="车价分级校准配置" loading={loading}>
                <Form form={vehicleForm} layout="vertical">
                  <Title level={5}>第一部分：车型分级基础配置</Title>
                  <Form.Item name="vehicleTierLowMax" label="低端车型裸车价上限（元）" tooltip="10万以内为低端">
                    <InputNumber min={0} style={{ width: 200 }} addonAfter="元" />
                  </Form.Item>
                  <Form.Item name="vehicleTierMediumMax" label="中端车型裸车价上限（元）" tooltip="10万～30万为中端">
                    <InputNumber min={0} style={{ width: 200 }} addonAfter="元" />
                  </Form.Item>
                  <Divider />
                  <Title level={5}>车价校准系数 5 档（用于基础奖励 = 固定奖励 × 系数）</Title>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
                    按裸车价（或大模型推断的 vehicle_price_max）查表，取区间上限对应的系数。单位：万元。
                  </Text>
                  <Table
                    size="small"
                    pagination={false}
                    dataSource={[
                      { key: '1', label: '≤10万', maxName: 'vehicleCoeff1Max', coeffName: 'vehicleCoeff1Coeff', maxDefault: 10, coeffDefault: 1.0 },
                      { key: '2', label: '≤20万', maxName: 'vehicleCoeff2Max', coeffName: 'vehicleCoeff2Coeff', maxDefault: 20, coeffDefault: 1.2 },
                      { key: '3', label: '≤30万', maxName: 'vehicleCoeff3Max', coeffName: 'vehicleCoeff3Coeff', maxDefault: 30, coeffDefault: 1.5 },
                      { key: '4', label: '≤50万', maxName: 'vehicleCoeff4Max', coeffName: 'vehicleCoeff4Coeff', maxDefault: 50, coeffDefault: 2.0 },
                      { key: '5', label: '>50万', maxName: 'vehicleCoeff5Max', coeffName: 'vehicleCoeff5Coeff', maxDefault: 9999, coeffDefault: 3.0 },
                    ]}
                    columns={[
                      { title: '价格区间', dataIndex: 'label', key: 'label', width: 80 },
                      {
                        title: '区间上限（万元）',
                        key: 'max',
                        width: 140,
                        render: (_: any, r: any) => (
                          <Form.Item name={r.maxName} noStyle>
                            <InputNumber min={0} max={99999} style={{ width: 100 }} addonAfter="万" />
                          </Form.Item>
                        ),
                      },
                      {
                        title: '系数',
                        key: 'coeff',
                        width: 120,
                        render: (_: any, r: any) => (
                          <Form.Item name={r.coeffName} noStyle>
                            <InputNumber min={0.5} max={5} step={0.1} style={{ width: 80 }} />
                          </Form.Item>
                        ),
                      },
                    ]}
                  />
                </Form>
              </Card>
            ),
          },
          {
            key: '3',
            label: '模块3 订单分级',
            children: (
              <Card title="订单金额分级配置" loading={loading}>
                <Form form={orderForm} layout="vertical">
                  <Form.Item name="orderTier1Max" label="一级订单金额上限（元）" tooltip="≤此值为一级">
                    <InputNumber min={0} style={{ width: 200 }} addonAfter="元" />
                  </Form.Item>
                  <Form.Item name="orderTier2Max" label="二级订单金额上限（元）">
                    <InputNumber min={0} style={{ width: 200 }} addonAfter="元" />
                  </Form.Item>
                  <Form.Item name="orderTier3Max" label="三级订单金额上限（元）" tooltip="超过为四级">
                    <InputNumber min={0} style={{ width: 200 }} addonAfter="元" />
                  </Form.Item>
                  <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                    说明：分级仅用于展示/统计等；基础轨奖励不再按订单分级封顶。首评/追评现金以定期结算与三轨池子为准；「追评升级差额补发」由模块5开关控制。
                  </Text>
                </Form>
              </Card>
            ),
          },
          {
            key: '4',
            label: '模块4 合规规则',
            children: (
              <Card title="合规与补充规则配置" loading={loading}>
                <Form form={complianceForm} layout="vertical">
                  <Form.Item
                    name="complianceRedLine"
                    label="奖励金合规硬红线比例（%）"
                    tooltip="单订单奖励金最高不超过平台实收佣金的此比例"
                  >
                    <InputNumber min={0} max={100} style={{ width: 200 }} addonAfter="%" />
                  </Form.Item>
                  <Text type="secondary">个税：单次 ≤800 元个税为 0，超过 800 元由平台承担。</Text>
                </Form>
              </Card>
            ),
          },
          {
            key: '5',
            label: '模块5 互动与转化',
            children: (
              <Card title="平台化三轨：互动轨 / 转化轨（platformIncentiveV1）" loading={loading}>
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message="与模块4 红线的关系"
                  description="「转化池占比」「用户侧硬帽」等在此配置；模块4 的「奖励金合规硬红线」仍对应 complianceRedLine（可与 baseInteractionCapPct 对齐调参）。详见《评价与点赞奖励-定期结算方案》附录 A。"
                />
                <Form form={platformForm} layout="vertical">
                  <Title level={5}>总开关与合规</Title>
                  <Space wrap size="large">
                    <Form.Item name="platformEnabled" label="启用平台化激励包" valuePropName="checked">
                      <Switch />
                    </Form.Item>
                    <Form.Item name="compliancePreTaxOnly" label="合规比较一律税前应付" valuePropName="checked">
                      <Switch />
                    </Form.Item>
                    <Form.Item name="disableAiPremiumFloat" label="关闭 AI 档首发现金浮动" valuePropName="checked">
                      <Switch />
                    </Form.Item>
                  </Space>
                  <Divider />
                  <Title level={5}>转化轨与池子</Title>
                  <Space wrap>
                    <Form.Item
                      name="conversionPoolSharePct"
                      label="转化池 + 事后验证共帽（占订单实收佣金 %）"
                      tooltip="对应 conversionPoolShare，如 10 表示 10%"
                    >
                      <InputNumber min={0} max={100} step={0.5} style={{ width: 160 }} addonAfter="%" />
                    </Form.Item>
                    <Form.Item name="postVerifySharesConversionPool" label="事后验证与转化共池" valuePropName="checked">
                      <Switch />
                    </Form.Item>
                    <Form.Item
                      name="maxUserRewardPct"
                      label="单笔订单用户侧激励硬帽（占实收佣金 %）"
                      tooltip="maxUserRewardPctOfCommission"
                    >
                      <InputNumber min={0} max={100} step={1} style={{ width: 160 }} addonAfter="%" />
                    </Form.Item>
                    <Form.Item
                      name="baseInteractionCapPct"
                      label="基础+互动子池占实收佣金比例（%）"
                      tooltip="与合规红线常对齐；baseInteractionCapPct"
                    >
                      <InputNumber min={0} max={100} step={1} style={{ width: 160 }} addonAfter="%" />
                    </Form.Item>
                    <Form.Item name="thetaCap" label="转化名义份额上限 Θ（0～1）" tooltip="thetaCap">
                      <InputNumber min={0} max={1} step={0.01} style={{ width: 140 }} />
                    </Form.Item>
                    <Form.Item name="attributionWindowDays" label="归因窗口（天）">
                      <InputNumber min={1} max={90} style={{ width: 120 }} addonAfter="天" />
                    </Form.Item>
                  </Space>
                  <Divider />
                  <Title level={5}>结算策略</Title>
                  <Form.Item name="settleUpgradeDiffEnabled" label="月度结算处理 upgrade_diff（追评升级差额）" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                  <Divider />
                  <Title level={5}>权重中性化（与 AI/内容档解耦）</Title>
                  <Space wrap size="large">
                    <Form.Item
                      name="neutralizeContentQualityInConversionWeight"
                      label="转化权重不再乘 content_quality_level"
                      valuePropName="checked"
                    >
                      <Switch />
                    </Form.Item>
                    <Form.Item
                      name="shopScoreIgnoreContentQualityLevel"
                      label="店铺分不因 AI 内容档抬到 premium 权重"
                      valuePropName="checked"
                    >
                      <Switch />
                    </Form.Item>
                  </Space>
                  <Divider />
                  <Title level={5}>买家等级 φ(L)、作者等级 ψ(L)（L0～L4）</Title>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                    索引 0 对应 L0，依次至 L4。
                  </Text>
                  <Space wrap style={{ marginBottom: 8 }}>
                    {[0, 1, 2, 3, 4].map((i) => (
                      <Form.Item key={`phi${i}`} name={`phi${i}`} label={`φ L${i}`}>
                        <InputNumber min={0} max={2} step={0.01} style={{ width: 88 }} />
                      </Form.Item>
                    ))}
                  </Space>
                  <Space wrap>
                    {[0, 1, 2, 3, 4].map((i) => (
                      <Form.Item key={`psi${i}`} name={`psi${i}`} label={`ψ L${i}`}>
                        <InputNumber min={0} max={2} step={0.01} style={{ width: 88 }} />
                      </Form.Item>
                    ))}
                  </Space>
                  <Divider />
                  <Title level={5}>互动轨参数（Qm）</Title>
                  <Space wrap>
                    <Form.Item name="intSE" label="sE（曝光半衰/规模）">
                      <InputNumber min={1} style={{ width: 100 }} />
                    </Form.Item>
                    <Form.Item name="intSR" label="sR（回复半衰）">
                      <InputNumber min={1} style={{ width: 100 }} />
                    </Form.Item>
                    <Form.Item name="intRhoCap" label="ρ 上限 rhoCap">
                      <InputNumber min={0} max={1} step={0.05} style={{ width: 100 }} />
                    </Form.Item>
                    <Form.Item name="intTau" label="τ（时间折扣）">
                      <InputNumber min={0} max={1} step={0.05} style={{ width: 100 }} />
                    </Form.Item>
                    <Form.Item name="intColdStartD" label="冷启动天数 coldStartD">
                      <InputNumber min={0} max={200} style={{ width: 120 }} />
                    </Form.Item>
                  </Space>
                  <Title level={5} style={{ marginTop: 8 }}>
                    η 权重（E/R/L/C/ρ）
                  </Title>
                  <Space wrap>
                    <Form.Item name="intEtaE" label="ηE">
                      <InputNumber min={0} step={0.01} style={{ width: 90 }} />
                    </Form.Item>
                    <Form.Item name="intEtaR" label="ηR">
                      <InputNumber min={0} step={0.0001} style={{ width: 100 }} />
                    </Form.Item>
                    <Form.Item name="intEtaL" label="ηL">
                      <InputNumber min={0} step={0.01} style={{ width: 90 }} />
                    </Form.Item>
                    <Form.Item name="intEtaC" label="ηC">
                      <InputNumber min={0} step={0.01} style={{ width: 90 }} />
                    </Form.Item>
                    <Form.Item name="intEtaRho" label="ηρ">
                      <InputNumber min={0} step={0.1} style={{ width: 90 }} />
                    </Form.Item>
                  </Space>
                  <Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
                    店铺内容指数权重 w*（shopScoreWeights）等未在此页暴露的字段，保存时将沿用库内原值。
                  </Text>
                </Form>
              </Card>
            ),
          },
        ]}
      />

      <div style={{ marginTop: 24 }}>
        <Button type="primary" size="large" loading={saving} onClick={handleSaveAll}>
          保存全部配置
        </Button>
      </div>

      <Modal
        title={editingIndex !== null ? '编辑项目类型' : '新增项目类型'}
        open={modalVisible}
        onOk={() => form.submit()}
        onCancel={() => setModalVisible(false)}
        width={500}
      >
        <Form form={form} layout="vertical" onFinish={handleSaveComplexity}>
          <Form.Item name="level" label="等级" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="L1">L1 极低</Select.Option>
              <Select.Option value="L2">L2 低</Select.Option>
              <Select.Option value="L3">L3 中</Select.Option>
              <Select.Option value="L4">L4 高</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="project_type" label="维修项目关键词" rules={[{ required: true, message: '请输入关键词' }]}>
            <Input placeholder="如：钣金|喷漆|翼子板|车门，支持 | 或 , 分隔" />
          </Form.Item>
          <Form.Item name="fixed_reward" label="固定奖励（元）" rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
