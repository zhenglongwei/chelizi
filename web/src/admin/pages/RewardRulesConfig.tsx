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
import { parseSystemConfig } from '../utils/systemConfig';
import { getDefaultRewardRulesConfig } from '../utils/rewardRulesConfig';

const { Title, Text } = Typography;

// 复杂度等级默认数据
const DEFAULT_COMPLEXITY_LEVELS = [
  { id: 'L1', name: '极低复杂度', projectTypes: '标准化换件、补胎、基础车辆检测等', fixedReward: 10, floatRatio: 1, capAmount: 30 },
  { id: 'L2', name: '低复杂度', projectTypes: '常规小保养、钣金喷漆、易损件更换等', fixedReward: 20, floatRatio: 2, capAmount: 150 },
  { id: 'L3', name: '中复杂度', projectTypes: '常规故障维修、底盘整备、发动机局部维修等', fixedReward: 50, floatRatio: 3, capAmount: 800 },
  { id: 'L4', name: '高复杂度', projectTypes: '疑难故障排查、发动机/变速箱大修、事故车整车修复等', fixedReward: 100, floatRatio: 4, capAmount: 2000 },
];

export default function RewardRulesConfig() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [complexityLevels, setComplexityLevels] = useState<any[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [form] = Form.useForm();
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
      const result = await callCloudFunction('queryData', { collection: 'system_config' });
      const configList = result.data || [];
      const defaultConfig = getDefaultRewardRulesConfig();
      const config = parseSystemConfig(configList, defaultConfig);
      let rewardRules = config.rewardRules || defaultConfig.rewardRules || {};
      if (typeof rewardRules === 'string') {
        try {
          rewardRules = JSON.parse(rewardRules);
        } catch {
          rewardRules = defaultConfig.rewardRules || {};
        }
      }

      // 模块 1：复杂度等级
      const levels = rewardRules.complexityLevels || DEFAULT_COMPLEXITY_LEVELS;
      setComplexityLevels(Array.isArray(levels) ? levels : DEFAULT_COMPLEXITY_LEVELS);

      // 模块 2：车价分级
      vehicleForm.setFieldsValue({
        vehicleTierLowMax: rewardRules.vehicleTierLowMax ?? 100000,
        vehicleTierMediumMax: rewardRules.vehicleTierMediumMax ?? 300000,
        vehicleTierLowCapUp: rewardRules.vehicleTierLowCapUp ?? 20,
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
    } catch (error) {
      console.error('加载配置失败:', error);
      message.error('加载配置失败');
      setComplexityLevels(DEFAULT_COMPLEXITY_LEVELS);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveComplexity = async (values: any) => {
    const newLevels = [...complexityLevels];
    const item = {
      id: values.id,
      name: values.name,
      projectTypes: values.projectTypes,
      fixedReward: Number(values.fixedReward),
      floatRatio: Number(values.floatRatio),
      capAmount: Number(values.capAmount),
    };
    if (editingIndex !== null) {
      newLevels[editingIndex] = item;
    } else {
      newLevels.push(item);
    }
    setComplexityLevels(newLevels);
    setModalVisible(false);
    await saveRewardRulesConfig({ complexityLevels: newLevels });
  };

  const handleEditComplexity = (record: any, index: number) => {
    setEditingIndex(index);
    form.setFieldsValue({
      id: record.id,
      name: record.name,
      projectTypes: record.projectTypes,
      fixedReward: record.fixedReward,
      floatRatio: record.floatRatio,
      capAmount: record.capAmount,
    });
    setModalVisible(true);
  };

  const saveRewardRulesConfig = async (partial: Record<string, any>) => {
    try {
      const result = await callCloudFunction('queryData', { collection: 'system_config' });
      const configList = result.data || [];
      const defaultConfig = getDefaultRewardRulesConfig();
      const config = parseSystemConfig(configList, defaultConfig);
      let existing = config.rewardRules || defaultConfig.rewardRules || {};
      if (typeof existing === 'string') {
        try {
          existing = JSON.parse(existing);
        } catch {
          existing = {};
        }
      }
      const rewardRules = { ...existing, ...partial };
      await callCloudFunction('updateData', {
        collection: 'system_config',
        where: { key: 'rewardRules' },
        data: { value: JSON.stringify(rewardRules) },
      });
      message.success('保存成功');
    } catch (e: any) {
      message.error(e.message || '保存失败');
    }
  };

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      const [vehicleValues, orderValues, complianceValues, commissionValues] = await Promise.all([
        vehicleForm.validateFields().catch(() => null),
        orderForm.validateFields().catch(() => null),
        complianceForm.validateFields().catch(() => null),
        commissionForm.validateFields().catch(() => null),
      ]);

      const rewardRules: Record<string, any> = {
        complexityLevels,
        vehicleTierLowMax: vehicleValues?.vehicleTierLowMax ?? 100000,
        vehicleTierMediumMax: vehicleValues?.vehicleTierMediumMax ?? 300000,
        vehicleTierLowCapUp: vehicleValues?.vehicleTierLowCapUp ?? 20,
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

      const result = await callCloudFunction('queryData', { collection: 'system_config' });
      const configList = Array.isArray(result.data) ? result.data : [];
      const hasKey = configList.some((c: any) => c?.key === 'rewardRules');
      if (hasKey) {
        await callCloudFunction('updateData', {
          collection: 'system_config',
          where: { key: 'rewardRules' },
          data: { value: JSON.stringify(rewardRules) },
        });
      } else {
        await callCloudFunction('addData', {
          collection: 'system_config',
          data: { key: 'rewardRules', value: JSON.stringify(rewardRules) },
        });
      }
      message.success('全部配置保存成功');
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const complexityColumns = [
    { title: '等级', dataIndex: 'id', key: 'id', width: 80 },
    { title: '名称', dataIndex: 'name', key: 'name', width: 120 },
    { title: '维修项目类型', dataIndex: 'projectTypes', key: 'projectTypes', ellipsis: true },
    { title: '固定奖励(元)', dataIndex: 'fixedReward', key: 'fixedReward', width: 100 },
    { title: '浮动比例(%)', dataIndex: 'floatRatio', key: 'floatRatio', width: 100 },
    { title: '单项目封顶(元)', dataIndex: 'capAmount', key: 'capAmount', width: 120 },
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_: any, record: any, index: number) => (
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
        按《评价奖励金体系-设计方案》配置三级校准体系，运营后台可直接编辑，无需代码调整。
      </Text>

      <Tabs
        defaultActiveKey="1"
        items={[
          {
            key: '1',
            label: '模块1 复杂度等级',
            children: (
              <Card title="维修项目复杂度等级核心配置" loading={loading}>
                <p style={{ marginBottom: 16, color: '#666' }}>
                  给每一类维修项目单独设一个「奖励金最高发放天花板」。最多 4 个等级，对应固定奖励、浮动比例、单项目封顶。
                </p>
                <Table
                  columns={complexityColumns}
                  dataSource={complexityLevels}
                  rowKey="id"
                  pagination={false}
                  size="small"
                />
                <Button
                  type="dashed"
                  icon={<PlusOutlined />}
                  onClick={() => {
                    setEditingIndex(null);
                    form.resetFields();
                    form.setFieldsValue({ id: 'L1', fixedReward: 10, floatRatio: 1, capAmount: 30 });
                    setModalVisible(true);
                  }}
                  style={{ marginTop: 16 }}
                >
                  新增等级（最多4个）
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
                  <Form.Item name="vehicleTierLowCapUp" label="低端车型封顶上浮比例（%）" tooltip="低端单项目/单订单封顶可上浮">
                    <InputNumber min={0} max={100} style={{ width: 200 }} addonAfter="%" />
                  </Form.Item>
                  <Divider />
                  <Title level={5}>第二部分：浮动比例校准（车型 × 复杂度）</Title>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
                    低端：在基准浮动比例上增加；高端：在基准浮动比例上减少；中端为 0。
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
                  <Form.Item name="lowEndL4Amplify" label="低端车型 L4 项目奖励放大系数（倍）" tooltip="最高不超过此倍数">
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
                    发放节点：一级/二级评价通过后 100% 发放；三级基础 50% + 1 个月追评 50%；四级基础 50% + 1 个月 30% + 3 个月 20%。
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
        title={editingIndex !== null ? '编辑复杂度等级' : '新增复杂度等级'}
        open={modalVisible}
        onOk={() => form.submit()}
        onCancel={() => setModalVisible(false)}
        width={500}
      >
        <Form form={form} layout="vertical" onFinish={handleSaveComplexity}>
          <Form.Item name="id" label="等级标识" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="L1">L1 极低</Select.Option>
              <Select.Option value="L2">L2 低</Select.Option>
              <Select.Option value="L3">L3 中</Select.Option>
              <Select.Option value="L4">L4 高</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="name" label="等级名称" rules={[{ required: true }]}>
            <Input placeholder="如：极低复杂度" />
          </Form.Item>
          <Form.Item name="projectTypes" label="维修项目类型" rules={[{ required: true }]}>
            <Input.TextArea rows={2} placeholder="如：标准化换件、补胎、基础车辆检测等" />
          </Form.Item>
          <Form.Item name="fixedReward" label="基准固定奖励（元）" rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="floatRatio" label="基准浮动比例（%）" rules={[{ required: true }]}>
            <InputNumber min={0} max={100} step={0.1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="capAmount" label="单项目奖励封顶（元）" rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
