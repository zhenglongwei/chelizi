import { useState, useEffect } from 'react';
import { Card, Row, Col, Statistic, Table, Typography, Spin, message, Button } from 'antd';
import {
  DollarOutlined,
  ShoppingOutlined,
  UserOutlined,
  CheckCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { callCloudFunction } from '../utils/api';
import './Dashboard.css';

const { Title } = Typography;

const STATUS_MAP: Record<number, string> = {
  0: '待接单',
  1: '维修中',
  2: '待确认',
  3: '已完成',
  4: '已取消',
};

export default function Dashboard() {
  const [loading, setLoading] = useState(true);
  const [statistics, setStatistics] = useState<any>(null);
  const [latestOrders, setLatestOrders] = useState<any[]>([]);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [statsRes, ordersRes] = await Promise.all([
        callCloudFunction('getStatistics', {}),
        callCloudFunction('getAllOrders', { page: 1, pageSize: 10 }),
      ]);
      if (statsRes.success) setStatistics(statsRes.data);
      if (ordersRes.success) setLatestOrders(ordersRes.data?.list || []);
    } catch (error: any) {
      message.error('加载数据失败: ' + (error.message || '未知错误'));
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    { title: '订单号', dataIndex: 'orderNo', key: 'orderNo', render: (v: string) => <span style={{ fontFamily: 'monospace' }}>{v}</span> },
    { title: '车主', dataIndex: 'ownerName', key: 'ownerName', render: (v: string) => v || '-' },
    { title: '服务商', dataIndex: 'merchantName', key: 'merchantName', render: (v: string) => v || '-' },
    { title: '金额', dataIndex: 'orderAmount', key: 'orderAmount', render: (val: number) => `¥${val || 0}` },
    { title: '状态', dataIndex: 'status', key: 'status', render: (s: number) => STATUS_MAP[s] ?? String(s) },
  ];

  const monthlyOrderKeys = Object.keys(statistics?.monthlyOrders || {}).sort();
  const orderTrendOption = {
    title: { text: '订单趋势' },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: monthlyOrderKeys.length > 0
        ? monthlyOrderKeys.map((key) => {
            const [year, month] = key.split('-');
            return `${year}年${parseInt(month)}月`;
          })
        : ['暂无数据'],
    },
    yAxis: { type: 'value' },
    series: [
      {
        name: '订单量',
        data: monthlyOrderKeys.length > 0 ? monthlyOrderKeys.map((key) => statistics?.monthlyOrders?.[key] || 0) : [0],
        type: 'line',
        smooth: true,
      },
    ],
  };

  if (loading && !statistics) {
    return (
      <div className="dashboard-container" style={{ textAlign: 'center', padding: 80 }}>
        <Spin size="large" tip="加载中..." />
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={2} style={{ margin: 0 }}>数据概览</Title>
        <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>
          刷新
        </Button>
      </div>
      
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="今日订单"
              value={statistics?.todayOrders ?? 0}
              prefix={<ShoppingOutlined />}
              valueStyle={{ color: '#3f8600' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="今日成交额"
              value={statistics?.todayAmount ?? 0}
              prefix={<DollarOutlined />}
              precision={2}
              suffix="元"
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="服务商数量"
              value={statistics?.totalMerchants ?? 0}
              prefix={<UserOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="完成率"
              value={statistics?.completionRate ?? 0}
              prefix={<CheckCircleOutlined />}
              precision={2}
              suffix="%"
              valueStyle={{ color: '#3f8600' }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Card title="订单趋势">
            <ReactECharts option={orderTrendOption} style={{ height: 300 }} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="最新订单">
            <Table
              dataSource={latestOrders}
              columns={columns}
              rowKey="orderNo"
              pagination={false}
              size="small"
              loading={loading}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}

