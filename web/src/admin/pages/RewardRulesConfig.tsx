import { useState, useEffect } from 'react';
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
} from 'antd';
import { PlusOutlined, EditOutlined } from '@ant-design/icons';
import { callCloudFunction } from '../utils/api';
import { getDefaultRewardRulesConfig } from '../utils/rewardRulesConfig';

const { Title, Text } = Typography;

// 复杂度等级：level + project_type（关键词，支持 | 或 , 分隔）+ fixed_reward/float_ratio/cap_amount
type ComplexityRow = {
  level: string;
  project_type: string;
  fixed_reward: number;
  float_ratio: number;
  cap_amount: number;
};

const defaultConfig = getDefaultRewardRulesConfig().rewardRules;

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
  const [commissionForm] = Form.useForm();

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
        float_ratio: Number(r.float_ratio ?? r.floatRatio ?? 0),
        cap_amount: Number(r.cap_amount ?? r.capAmount ?? 0),
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
        vehicleTierLowCapUp: rewardRules.vehicleTierLowCapUp ?? 20,
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
        lowEndL4Amplify: rewardRules.lowEndL4Amplify ?? 2.5,
        floatCalibrationLowL1: rewardRules.floatCalibration?.low?.L1 ?? 0.5,
        floatCalibrationLowL2: rewardRules.floatCalibration?.low?.L2 ?? 0.5,
        floatCalibrationLowL3: rewardRules.floatCalibration?.low?.L3 ?? 0.8,
        floatCalibrationLowL4: rewardRules.floatCalibration?.low?.L4 ?? 1,
        floatCalibrationHighL1: rewardRules.floatCalibration?.high?.L1 ?? -0.5,
        floatCalibrationHighL2: rewardRules.floatCalibration?.high?.L2 ?? -0.5,
        floatCalibrationHighL3: rewardRules.floatCalibration?.high?.L3 ?? -0.8,
        floatCalibrationHighL4: rewardRules.floatCalibration?.high?.L4 ?? -1,
      });

      // 模块 3：订单分级
      orderForm.setFieldsValue({
        orderTier1Max: rewardRules.orderTier1Max ?? 1000,
        orderTier2Max: rewardRules.orderTier2Max ?? 5000,
        orderTier3Max: rewardRules.orderTier3Max ?? 20000,
        orderTier1Cap: rewardRules.orderTier1Cap ?? 30,
        orderTier2Cap: rewardRules.orderTier2Cap ?? 150,
        orderTier3Cap: rewardRules.orderTier3Cap ?? 800,
        orderTier4Cap: rewardRules.orderTier4Cap ?? 2000,
      });

      // 模块 4：合规规则
      complianceForm.setFieldsValue({
        complianceRedLine: rewardRules.complianceRedLine ?? 70,
        upgradeMaxPer3Months: rewardRules.upgradeMaxPer3Months ?? 2,
        upgradeReviewHours: rewardRules.upgradeReviewHours ?? 24,
      });

      // 模块 5：佣金配置
      commissionForm.setFieldsValue({
        commissionTier1Max: rewardRules.commissionTier1Max ?? 5000,
        commissionTier2Max: rewardRules.commissionTier2Max ?? 20000,
        commissionTier1Rate: rewardRules.commissionTier1Rate ?? 8,
        commissionTier2Rate: rewardRules.commissionTier2Rate ?? 10,
        commissionTier3Rate: rewardRules.commissionTier3Rate ?? 12,
        commissionDownMinRatio: rewardRules.commissionDownMinRatio ?? 50,
        commissionUpMaxRatio: rewardRules.commissionUpMaxRatio ?? 120,
        commissionDownPercent: rewardRules.commissionDownPercent ?? 1,
        commissionUpPercent: rewardRules.commissionUpPercent ?? 2,
      });
    } catch (error: any) {
      console.error('加载配置失败:', error);
      message.error(error?.message || '加载配置失败');
      setComplexityLevels([]);
    } finally {
      setLoading(false);
    }
  };

  const buildFullConfig = (): Record<string, any> => {
    const [baseValues, vehicleValues, orderValues, complianceValues, commissionValues] = [
      baseRewardForm.getFieldsValue(),
      vehicleForm.getFieldsValue(),
      orderForm.getFieldsValue(),
      complianceForm.getFieldsValue(),
      commissionForm.getFieldsValue(),
    ];
    return {
      complexityLevels,
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
      vehicleTierLowCapUp: vehicleValues?.vehicleTierLowCapUp ?? 20,
      vehicleCoeff: [
        { max: vehicleValues?.vehicleCoeff1Max ?? 10, coeff: vehicleValues?.vehicleCoeff1Coeff ?? 1.0 },
        { max: vehicleValues?.vehicleCoeff2Max ?? 20, coeff: vehicleValues?.vehicleCoeff2Coeff ?? 1.2 },
        { max: vehicleValues?.vehicleCoeff3Max ?? 30, coeff: vehicleValues?.vehicleCoeff3Coeff ?? 1.5 },
        { max: vehicleValues?.vehicleCoeff4Max ?? 50, coeff: vehicleValues?.vehicleCoeff4Coeff ?? 2.0 },
        { max: vehicleValues?.vehicleCoeff5Max ?? 9999, coeff: vehicleValues?.vehicleCoeff5Coeff ?? 3.0 },
      ],
      lowEndL4Amplify: vehicleValues?.lowEndL4Amplify ?? 2.5,
      floatCalibration: {
        low: {
          L1: vehicleValues?.floatCalibrationLowL1 ?? 0.5,
          L2: vehicleValues?.floatCalibrationLowL2 ?? 0.5,
          L3: vehicleValues?.floatCalibrationLowL3 ?? 0.8,
          L4: vehicleValues?.floatCalibrationLowL4 ?? 1,
        },
        medium: { L1: 0, L2: 0, L3: 0, L4: 0 },
        high: {
          L1: vehicleValues?.floatCalibrationHighL1 ?? -0.5,
          L2: vehicleValues?.floatCalibrationHighL2 ?? -0.5,
          L3: vehicleValues?.floatCalibrationHighL3 ?? -0.8,
          L4: vehicleValues?.floatCalibrationHighL4 ?? -1,
        },
      },
      orderTier1Max: orderValues?.orderTier1Max ?? 1000,
      orderTier2Max: orderValues?.orderTier2Max ?? 5000,
      orderTier3Max: orderValues?.orderTier3Max ?? 20000,
      orderTier1Cap: orderValues?.orderTier1Cap ?? 30,
      orderTier2Cap: orderValues?.orderTier2Cap ?? 150,
      orderTier3Cap: orderValues?.orderTier3Cap ?? 800,
      orderTier4Cap: orderValues?.orderTier4Cap ?? 2000,
      complianceRedLine: complianceValues?.complianceRedLine ?? 70,
      upgradeMaxPer3Months: complianceValues?.upgradeMaxPer3Months ?? 2,
      upgradeReviewHours: complianceValues?.upgradeReviewHours ?? 24,
      commissionTier1Max: commissionValues?.commissionTier1Max ?? 5000,
      commissionTier2Max: commissionValues?.commissionTier2Max ?? 20000,
      commissionTier1Rate: commissionValues?.commissionTier1Rate ?? 8,
      commissionTier2Rate: commissionValues?.commissionTier2Rate ?? 10,
      commissionTier3Rate: commissionValues?.commissionTier3Rate ?? 12,
      commissionDownMinRatio: commissionValues?.commissionDownMinRatio ?? 50,
      commissionUpMaxRatio: commissionValues?.commissionUpMaxRatio ?? 120,
      commissionDownPercent: commissionValues?.commissionDownPercent ?? 1,
      commissionUpPercent: commissionValues?.commissionUpPercent ?? 2,
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
      float_ratio: Number(values.float_ratio),
      cap_amount: Number(values.cap_amount),
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
    fullConfig.complexityLevels = newLevels;
    await saveRewardRulesConfig(fullConfig);
  };

  const handleEditComplexity = (record: ComplexityRow, index: number) => {
    setEditingIndex(index);
    form.setFieldsValue({
      level: record.level,
      project_type: record.project_type,
      fixed_reward: record.fixed_reward,
      float_ratio: record.float_ratio,
      cap_amount: record.cap_amount,
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
        commissionForm.validateFields().catch(() => null),
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

  const       complexityColumns = [
    { title: '等级', dataIndex: 'level', key: 'level', width: 60 },
    { title: '维修项目关键词', dataIndex: 'project_type', key: 'project_type', ellipsis: true, render: (v: string) => v || '-' },
    { title: '固定奖励(元)', dataIndex: 'fixed_reward', key: 'fixed_reward', width: 100 },
    { title: '浮动比例(%)', dataIndex: 'float_ratio', key: 'float_ratio', width: 100 },
    { title: '单项目封顶(元)', dataIndex: 'cap_amount', key: 'cap_amount', width: 120 },
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
        按《全指标底层逻辑梳理》第四章配置奖励金规则，运营后台可直接编辑，无需代码调整。
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
                  公式：基础奖励 = 复杂度基础固定奖励 × 车价校准系数。下方表格的固定奖励仅用于项目匹配与封顶，实际计算以本表为准。
                </Text>
                <p style={{ marginBottom: 16, color: '#666' }}>
                  每行配置：等级(L1-L4)、维修项目关键词（支持 | 或 , 分隔，如「钣金|喷漆|翼子板」）、固定奖励、浮动比例、单项目封顶。
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
                    form.setFieldsValue({ level: 'L1', project_type: '', fixed_reward: 10, float_ratio: 0, cap_amount: 50 });
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
                  <Form.Item name="vehicleTierLowCapUp" label="低端车型封顶上浮比例（%）" tooltip="低端单项目/单订单封顶可上浮，如 20 表示 1.2 倍">
                    <InputNumber min={0} max={100} style={{ width: 200 }} addonAfter="%" />
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
                  <Divider />
                  <Title level={5}>第二部分：浮动比例校准（车型 × 复杂度）</Title>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
                    低端：在基准浮动比例上增加；高端：在基准浮动比例上减少；中端为 0。注：以下 floatCalibration、lowEndL4Amplify 为预留配置，当前未参与奖励金计算。
                  </Text>
                  <Space wrap>
                    <Form.Item name="floatCalibrationLowL1" label="低端 L1 校准(%)">
                      <InputNumber min={-10} max={10} step={0.1} style={{ width: 100 }} addonAfter="%" />
                    </Form.Item>
                    <Form.Item name="floatCalibrationLowL2" label="低端 L2 校准(%)">
                      <InputNumber min={-10} max={10} step={0.1} style={{ width: 100 }} addonAfter="%" />
                    </Form.Item>
                    <Form.Item name="floatCalibrationLowL3" label="低端 L3 校准(%)">
                      <InputNumber min={-10} max={10} step={0.1} style={{ width: 100 }} addonAfter="%" />
                    </Form.Item>
                    <Form.Item name="floatCalibrationLowL4" label="低端 L4 校准(%)">
                      <InputNumber min={-10} max={10} step={0.1} style={{ width: 100 }} addonAfter="%" />
                    </Form.Item>
                  </Space>
                  <Space wrap>
                    <Form.Item name="floatCalibrationHighL1" label="高端 L1 校准(%)">
                      <InputNumber min={-10} max={10} step={0.1} style={{ width: 100 }} addonAfter="%" />
                    </Form.Item>
                    <Form.Item name="floatCalibrationHighL2" label="高端 L2 校准(%)">
                      <InputNumber min={-10} max={10} step={0.1} style={{ width: 100 }} addonAfter="%" />
                    </Form.Item>
                    <Form.Item name="floatCalibrationHighL3" label="高端 L3 校准(%)">
                      <InputNumber min={-10} max={10} step={0.1} style={{ width: 100 }} addonAfter="%" />
                    </Form.Item>
                    <Form.Item name="floatCalibrationHighL4" label="高端 L4 校准(%)">
                      <InputNumber min={-10} max={10} step={0.1} style={{ width: 100 }} addonAfter="%" />
                    </Form.Item>
                  </Space>
                  <Form.Item name="lowEndL4Amplify" label="低端车型 L4 项目奖励放大系数（倍）" tooltip="预留配置，当前未参与计算">
                    <InputNumber min={1} max={3} step={0.1} style={{ width: 120 }} />
                  </Form.Item>
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
                  <Divider />
                  <Title level={5}>单订单总奖励封顶（元）</Title>
                  <Space wrap>
                    <Form.Item name="orderTier1Cap" label="一级订单封顶">
                      <InputNumber min={0} style={{ width: 120 }} addonAfter="元" />
                    </Form.Item>
                    <Form.Item name="orderTier2Cap" label="二级订单封顶">
                      <InputNumber min={0} style={{ width: 120 }} addonAfter="元" />
                    </Form.Item>
                    <Form.Item name="orderTier3Cap" label="三级订单封顶">
                      <InputNumber min={0} style={{ width: 120 }} addonAfter="元" />
                    </Form.Item>
                    <Form.Item name="orderTier4Cap" label="四级订单封顶">
                      <InputNumber min={0} style={{ width: 120 }} addonAfter="元" />
                    </Form.Item>
                  </Space>
                  <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                    发放节点：主评价全额发放，不再分阶段；追评整体评估后若等级升级则差额补发。
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
                  <Form.Item name="upgradeMaxPer3Months" label="破格升级：同一用户 3 个月内最多申请次数">
                    <InputNumber min={0} max={10} style={{ width: 120 }} />
                  </Form.Item>
                  <Form.Item name="upgradeReviewHours" label="破格升级：复核需在多少小时内完成">
                    <InputNumber min={1} max={72} style={{ width: 120 }} addonAfter="小时" />
                  </Form.Item>
                  <Text type="secondary">个税：单次 ≤800 元个税为 0，超过 800 元由平台承担。</Text>
                </Form>
              </Card>
            ),
          },
          {
            key: '5',
            label: '模块5 佣金配置',
            children: (
              <Card title="服务商佣金配置（按订单金额分级 + 合规率浮动）" loading={loading}>
                <Form form={commissionForm} layout="vertical">
                  <Title level={5}>订单金额分级对应的佣金比例</Title>
                  <Form.Item name="commissionTier1Max" label="第一档金额上限（元）" tooltip="5000元以内">
                    <InputNumber min={0} style={{ width: 200 }} addonAfter="元" />
                  </Form.Item>
                  <Form.Item name="commissionTier1Rate" label="第一档佣金比例（%）">
                    <InputNumber min={0} max={100} style={{ width: 120 }} addonAfter="%" />
                  </Form.Item>
                  <Form.Item name="commissionTier2Max" label="第二档金额上限（元）" tooltip="5000～20000">
                    <InputNumber min={0} style={{ width: 200 }} addonAfter="元" />
                  </Form.Item>
                  <Form.Item name="commissionTier2Rate" label="第二档佣金比例（%）">
                    <InputNumber min={0} max={100} style={{ width: 120 }} addonAfter="%" />
                  </Form.Item>
                  <Form.Item name="commissionTier3Rate" label="第三档佣金比例（%）" tooltip="20000元以上">
                    <InputNumber min={0} max={100} style={{ width: 120 }} addonAfter="%" />
                  </Form.Item>
                  <Divider />
                  <Title level={5}>合规率/投诉率浮动规则</Title>
                  <Form.Item name="commissionDownPercent" label="下调比例（%）" tooltip="合规率≥95%、投诉率≤1%时下调">
                    <InputNumber min={0} max={10} style={{ width: 120 }} addonAfter="%" />
                  </Form.Item>
                  <Form.Item name="commissionDownMinRatio" label="下调后最低不低于基准的（%）">
                    <InputNumber min={0} max={100} style={{ width: 120 }} addonAfter="%" />
                  </Form.Item>
                  <Form.Item name="commissionUpPercent" label="上调比例（%）" tooltip="合规率<80%或违规时上调">
                    <InputNumber min={0} max={10} style={{ width: 120 }} addonAfter="%" />
                  </Form.Item>
                  <Form.Item name="commissionUpMaxRatio" label="上调后最高不超过基准的（%）">
                    <InputNumber min={100} max={200} style={{ width: 120 }} addonAfter="%" />
                  </Form.Item>
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
          <Form.Item name="float_ratio" label="浮动比例（%）" rules={[{ required: true }]}>
            <InputNumber min={0} max={100} step={0.1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="cap_amount" label="单项目封顶（元）" rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
