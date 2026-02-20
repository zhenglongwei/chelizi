import { useState, useEffect } from 'react';
import {
  Card,
  Form,
  InputNumber,
  Button,
  Table,
  Modal,
  Select,
  Input,
  message,
  Typography,
  Tabs,
  Row,
  Col,
  Statistic,
  DatePicker,
  Space,
} from 'antd';
import { PlusOutlined, DeleteOutlined, SafetyOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import api from '../utils/api';

const { Title } = Typography;

export default function AntiFraudManagement() {
  const [config, setConfig] = useState<any>({});
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [blacklist, setBlacklist] = useState<any[]>([]);
  const [blacklistLoading, setBlacklistLoading] = useState(false);
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [violationModalVisible, setViolationModalVisible] = useState(false);
  const [violations, setViolations] = useState<any[]>([]);
  const [violationsTotal, setViolationsTotal] = useState(0);
  const [violationsLoading, setViolationsLoading] = useState(false);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [auditLogsTotal, setAuditLogsTotal] = useState(0);
  const [auditLogsLoading, setAuditLogsLoading] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsDateRange, setStatsDateRange] = useState<any>([dayjs().subtract(29, 'day'), dayjs()]);
  const [form] = Form.useForm();
  const [addForm] = Form.useForm();
  const [violationForm] = Form.useForm();

  useEffect(() => {
    loadConfig();
    loadBlacklist();
  }, []);

  const loadConfig = async () => {
    setConfigLoading(true);
    try {
      const res = await api.get('/v1/admin/antifraud/config');
      const data = res?.data ?? res;
      setConfig(data);
      form.setFieldsValue(data);
    } catch (e: any) {
      message.error(e.message || '加载配置失败');
    } finally {
      setConfigLoading(false);
    }
  };

  const loadBlacklist = async () => {
    setBlacklistLoading(true);
    try {
      const res = await api.get('/v1/admin/antifraud/blacklist');
      const data = res?.data ?? res;
      setBlacklist(Array.isArray(data) ? data : []);
    } catch (e: any) {
      message.error(e.message || '加载黑名单失败');
      setBlacklist([]);
    } finally {
      setBlacklistLoading(false);
    }
  };

  const saveConfig = async () => {
    try {
      const values = await form.validateFields();
      setConfigSaving(true);
      await api.put('/v1/admin/antifraud/config', values);
      message.success('保存成功');
      loadConfig();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e?.message || '保存失败');
    } finally {
      setConfigSaving(false);
    }
  };

  const handleAddBlacklist = async () => {
    try {
      const values = await addForm.validateFields();
      await api.post('/v1/admin/antifraud/blacklist', values);
      message.success('添加成功');
      setAddModalVisible(false);
      addForm.resetFields();
      loadBlacklist();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e?.message || '添加失败');
    }
  };

  const handleDeleteBlacklist = async (id: number) => {
    try {
      await api.delete(`/v1/admin/antifraud/blacklist/${id}`);
      message.success('删除成功');
      loadBlacklist();
    } catch (e: any) {
      message.error(e?.message || '删除失败');
    }
  };

  const loadViolations = async (page = 1, pageSize = 20) => {
    setViolationsLoading(true);
    try {
      const res = await api.get('/v1/admin/antifraud/violations', { params: { page, pageSize } });
      const data = res?.data ?? res;
      setViolations(data.list || []);
      setViolationsTotal(data.total || 0);
    } catch (e: any) {
      message.error(e.message || '加载失败');
      setViolations([]);
    } finally {
      setViolationsLoading(false);
    }
  };

  const loadAuditLogs = async (page = 1, pageSize = 50) => {
    setAuditLogsLoading(true);
    try {
      const res = await api.get('/v1/admin/antifraud/audit-logs', { params: { page, pageSize } });
      const data = res?.data ?? res;
      setAuditLogs(data.list || []);
      setAuditLogsTotal(data.total || 0);
    } catch (e: any) {
      message.error(e.message || '加载失败');
      setAuditLogs([]);
    } finally {
      setAuditLogsLoading(false);
    }
  };

  const loadStats = async () => {
    setStatsLoading(true);
    try {
      const [start, end] = statsDateRange || [dayjs().subtract(29, 'day'), dayjs()];
      const res = await api.get('/v1/admin/antifraud/statistics', {
        params: { startDate: start?.format('YYYY-MM-DD'), endDate: end?.format('YYYY-MM-DD') },
      });
      const data = res?.data ?? res;
      setStats(data);
    } catch (e: any) {
      message.error(e.message || '加载失败');
    } finally {
      setStatsLoading(false);
    }
  };

  const handleAddViolation = async () => {
    try {
      const values = await violationForm.validateFields();
      await api.post('/v1/admin/antifraud/violations', values);
      message.success('处理完成');
      setViolationModalVisible(false);
      violationForm.resetFields();
      loadViolations();
      loadBlacklist();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e?.message || '处理失败');
    }
  };

  const blacklistColumns = [
    { title: '类型', dataIndex: 'type', key: 'type', width: 100 },
    { title: '值', dataIndex: 'value', key: 'value', ellipsis: true },
    { title: '原因', dataIndex: 'reason', key: 'reason', ellipsis: true },
    { title: '添加时间', dataIndex: 'createTime', key: 'createTime', width: 170 },
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_: any, r: any) => (
        <Button type="link" danger size="small" icon={<DeleteOutlined />} onClick={() => handleDeleteBlacklist(r.id)}>
          删除
        </Button>
      ),
    },
  ];

  return (
    <div className="antifraud-management" style={{ padding: '0 24px' }}>
      <Title level={2}>
        <SafetyOutlined /> 防刷管理
      </Title>
      <Tabs
        defaultActiveKey="config"
        onChange={(key) => {
          if (key === 'violations') loadViolations();
          if (key === 'audit') loadAuditLogs();
          if (key === 'stats') loadStats();
        }}
        items={[
          {
            key: 'config',
            label: '防刷规则配置',
            children: (
          <Card loading={configLoading}>
            <Form form={form} layout="vertical" style={{ maxWidth: 500 }}>
              <Form.Item name="orderSameShopDays" label="同用户同商户订单统计天数" rules={[{ required: true }]}>
                <InputNumber min={1} max={90} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="orderSameShopMax" label="同用户同商户周期内最大订单数" rules={[{ required: true }]}>
                <InputNumber min={1} max={10} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="newUserDays" label="新用户判定天数" rules={[{ required: true }]}>
                <InputNumber min={1} max={30} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="newUserOrderMax" label="新用户周期内最大订单数" rules={[{ required: true }]}>
                <InputNumber min={1} max={20} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="l1MonthlyCap" label="L1 订单每月奖励金封顶（元）" rules={[{ required: true }]}>
                <InputNumber min={0} max={500} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="l1l2FreezeDays" label="L1-L2 奖励金冻结天数（0=即发）">
                <InputNumber min={0} max={30} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="l1l2SampleRate" label="L1-L2 抽检比例（%）">
                <InputNumber min={0} max={100} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item>
                <Button type="primary" loading={configSaving} onClick={saveConfig}>
                  保存配置
                </Button>
              </Form.Item>
            </Form>
          </Card>
            ),
          },
          {
            key: 'blacklist',
            label: '黑名单管理',
            children: (
          <Card
            loading={blacklistLoading}
            extra={
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddModalVisible(true)}>
                添加黑名单
              </Button>
            }
          >
            <Table
              columns={blacklistColumns}
              dataSource={blacklist}
              rowKey="id"
              pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
            />
          </Card>
            ),
          },
          {
            key: 'violations',
            label: '违规处理',
            children: (
              <Card
                loading={violationsLoading}
                extra={
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => { setViolationModalVisible(true); violationForm.resetFields(); }}>
                    登记违规
                  </Button>
                }
              >
                <Table
                  columns={[
                    { title: '记录ID', dataIndex: 'recordId', key: 'recordId', width: 120 },
                    { title: '对象', dataIndex: 'targetType', key: 'targetType', width: 60, render: (t: string) => t === 'user' ? '用户' : '商户' },
                    { title: 'ID', dataIndex: 'targetId', key: 'targetId', width: 100 },
                    { title: '等级', dataIndex: 'level', key: 'level', width: 60 },
                    { title: '类型', dataIndex: 'violationType', key: 'violationType', ellipsis: true },
                    { title: '描述', dataIndex: 'description', key: 'description', ellipsis: true },
                    { title: '时间', dataIndex: 'createTime', key: 'createTime', width: 170 },
                  ]}
                  dataSource={violations}
                  rowKey="recordId"
                  pagination={{ total: violationsTotal, showSizeChanger: true, onChange: (p, s) => loadViolations(p, s) }}
                />
              </Card>
            ),
          },
          {
            key: 'audit',
            label: '审计日志',
            children: (
              <Card loading={auditLogsLoading}>
                <Button style={{ marginBottom: 16 }} onClick={() => loadAuditLogs()}>刷新</Button>
                <Table
                  columns={[
                    { title: '类型', dataIndex: 'logType', key: 'logType', width: 100 },
                    { title: '操作', dataIndex: 'action', key: 'action', width: 80 },
                    { title: '目标', dataIndex: 'targetTable', key: 'targetTable', width: 100 },
                    { title: '操作人', dataIndex: 'operatorId', key: 'operatorId', width: 100 },
                    { title: 'IP', dataIndex: 'ip', key: 'ip', width: 120 },
                    { title: '时间', dataIndex: 'createTime', key: 'createTime', width: 170 },
                  ]}
                  dataSource={auditLogs}
                  rowKey="id"
                  pagination={{ total: auditLogsTotal, showSizeChanger: true, onChange: (p, s) => loadAuditLogs(p, s) }}
                />
              </Card>
            ),
          },
          {
            key: 'stats',
            label: '防刷报表',
            children: (
              <Card loading={statsLoading}>
                <Space style={{ marginBottom: 16 }}>
                  <DatePicker.RangePicker value={statsDateRange} onChange={setStatsDateRange} />
                  <Button type="primary" onClick={loadStats}>查询</Button>
                </Space>
                {stats && (
                  <Row gutter={16}>
                    <Col span={6}>
                      <Statistic title="订单数" value={stats.orderCount} />
                    </Col>
                    <Col span={6}>
                      <Statistic title="评价数" value={stats.reviewCount} />
                    </Col>
                    <Col span={6}>
                      <Statistic title="违规记录" value={stats.violationCount} />
                    </Col>
                    <Col span={6}>
                      <Statistic title="黑名单数" value={stats.blacklistCount} />
                    </Col>
                    <Col span={12} style={{ marginTop: 16 }}>
                      <Statistic title="奖励金支出(元)" value={stats.rewardTotal?.toFixed(2)} />
                    </Col>
                  </Row>
                )}
              </Card>
            ),
          },
        ]}
      />

      <Modal
        title="登记违规"
        open={violationModalVisible}
        onOk={handleAddViolation}
        onCancel={() => setViolationModalVisible(false)}
        width={500}
      >
        <Form form={violationForm} layout="vertical">
          <Form.Item name="targetType" label="对象类型" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="user">用户</Select.Option>
              <Select.Option value="shop">商户</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="targetId" label="用户ID/店铺ID" rules={[{ required: true }]}>
            <Input placeholder="输入 user_id 或 shop_id" />
          </Form.Item>
          <Form.Item name="level" label="违规等级" rules={[{ required: true }]}>
            <Select>
              <Select.Option value={1}>一级（轻微）</Select.Option>
              <Select.Option value={2}>二级（一般）</Select.Option>
              <Select.Option value={3}>三级（严重）</Select.Option>
              <Select.Option value={4}>四级（特别严重）</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="violationType" label="违规类型">
            <Input placeholder="如：虚假好评、刷单套利" />
          </Form.Item>
          <Form.Item name="orderId" label="关联订单ID">
            <Input />
          </Form.Item>
          <Form.Item name="reviewId" label="关联评价ID">
            <Input />
          </Form.Item>
          <Form.Item name="description" label="违规描述">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="添加黑名单"
        open={addModalVisible}
        onOk={handleAddBlacklist}
        onCancel={() => {
          setAddModalVisible(false);
          addForm.resetFields();
        }}
      >
        <Form form={addForm} layout="vertical">
          <Form.Item name="type" label="类型" rules={[{ required: true }]}>
            <Select placeholder="选择类型">
              <Select.Option value="user_id">用户ID</Select.Option>
              <Select.Option value="phone">手机号</Select.Option>
              <Select.Option value="ip">IP</Select.Option>
              <Select.Option value="device_id">设备ID</Select.Option>
              <Select.Option value="id_card">身份证号</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="value" label="值" rules={[{ required: true }]}>
            <Input placeholder="输入对应类型的值" />
          </Form.Item>
          <Form.Item name="reason" label="原因">
            <Input.TextArea rows={2} placeholder="拉黑原因（可选）" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
