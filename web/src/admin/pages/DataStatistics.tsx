import { useState, useEffect } from 'react';
import { Card, Row, Col, Statistic, Typography, DatePicker, Button, Space, message } from 'antd';
import ReactECharts from 'echarts-for-react';
import {
  ShoppingOutlined,
  DollarOutlined,
  UserOutlined,
  CheckCircleOutlined,
  GiftOutlined,
} from '@ant-design/icons';
import { callCloudFunction } from '../utils/api';
import dayjs from 'dayjs';

const { Title } = Typography;
const { RangePicker } = DatePicker;

export default function DataStatistics() {
  const [loading, setLoading] = useState(false);
  const [statistics, setStatistics] = useState<any>(null);
  const [dateRange, setDateRange] = useState<any>(null);

  useEffect(() => {
    loadStatistics();
  }, []);

  const loadStatistics = async () => {
    setLoading(true);
    try {
      const params: any = {};
      if (dateRange && dateRange.length === 2) {
        params.startDate = dateRange[0].format('YYYY-MM-DD');
        params.endDate = dateRange[1].format('YYYY-MM-DD');
      }

      const result = await callCloudFunction('getStatistics', params);
      if (result.success) {
        setStatistics(result.data);
      } else {
        message.error(result.message || '加载统计数据失败');
      }
    } catch (error: any) {
      console.error('加载统计数据失败:', error);
      message.error('加载统计数据失败: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDateChange = (dates: any) => {
    setDateRange(dates);
  };

  const handleSearch = () => {
    loadStatistics();
  };

  if (!statistics) {
    return <div>加载中...</div>;
  }

  // 订单趋势图表
  const monthlyOrderKeys = Object.keys(statistics.monthlyOrders || {}).sort();
  const orderTrendOption = {
    title: { text: '订单趋势分析' },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: monthlyOrderKeys.map(key => {
        const [year, month] = key.split('-');
        return `${year}年${parseInt(month)}月`;
      }),
    },
    yAxis: { type: 'value' },
    series: [
      {
        name: '订单量',
        type: 'line',
        data: monthlyOrderKeys.map(key => statistics.monthlyOrders[key] || 0),
        smooth: true,
      },
    ],
  };

  // 成交率图表
  const monthlyCompletedKeys = Object.keys(statistics.monthlyCompleted || {}).sort();
  const conversionRateOption = {
    title: { text: '成交率分析' },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: monthlyCompletedKeys.map(key => {
        const [year, month] = key.split('-');
        return `${year}年${parseInt(month)}月`;
      }),
    },
    yAxis: { type: 'value', max: 100 },
    series: [
      {
        name: '成交率',
        type: 'bar',
        data: monthlyCompletedKeys.map(key => {
          const total = statistics.monthlyOrders[key] || 0;
          const completed = statistics.monthlyCompleted[key] || 0;
          return total > 0 ? ((completed / total) * 100).toFixed(2) : 0;
        }),
      },
    ],
  };

  // 服务商分布
  const regionData = Object.keys(statistics.regionDistribution || {}).map(key => ({
    value: statistics.regionDistribution[key],
    name: key
  }));

  const merchantDistributionOption = {
    title: { text: '服务商地域分布' },
    tooltip: { trigger: 'item' },
    series: [
      {
        type: 'pie',
        data: regionData.length > 0 ? regionData : [{ value: 0, name: '暂无数据' }],
      },
    ],
  };

  // 奖励金按订单分级分布
  const rewardTierData = Object.keys(statistics.rewardDistributionByTier || {}).map(key => ({
    value: statistics.rewardDistributionByTier[key],
    name: key
  }));
  const rewardTierOption = {
    title: { text: '奖励金按订单分级分布' },
    tooltip: { trigger: 'item' },
    series: [
      {
        type: 'pie',
        data: rewardTierData.length > 0 ? rewardTierData : [{ value: 0, name: '暂无数据' }],
      },
    ],
  };

  // 奖励金按评价阶段分布
  const rewardStageData = Object.keys(statistics.rewardDistributionByStage || {}).map(key => ({
    value: statistics.rewardDistributionByStage[key],
    name: key
  }));
  const rewardStageOption = {
    title: { text: '奖励金按评价阶段分布' },
    tooltip: { trigger: 'item' },
    series: [
      {
        type: 'pie',
        data: rewardStageData.length > 0 ? rewardStageData : [{ value: 0, name: '暂无数据' }],
      },
    ],
  };

  return (
    <div className="data-statistics">
      <Title level={2}>数据统计与分析</Title>

      <Card style={{ marginBottom: 16 }}>
        <Space>
          <RangePicker
            value={dateRange}
            onChange={handleDateChange}
            format="YYYY-MM-DD"
          />
          <Button type="primary" onClick={handleSearch} loading={loading}>
            查询
          </Button>
        </Space>
      </Card>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="总订单量"
              value={statistics.totalOrders || 0}
              prefix={<ShoppingOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="总成交额"
              value={statistics.totalOrderAmount ?? statistics.totalAmount ?? 0}
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
              value={statistics.totalMerchants ?? statistics.merchantCount ?? 0}
              prefix={<UserOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="平均成交率"
              value={statistics.conversionRate || 0}
              prefix={<CheckCircleOutlined />}
              precision={2}
              suffix="%"
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="奖励金支出"
              value={statistics.rewardTotal ?? 0}
              prefix={<GiftOutlined />}
              precision={2}
              suffix="元"
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card>
            <ReactECharts option={orderTrendOption} style={{ height: 300 }} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card>
            <ReactECharts option={conversionRateOption} style={{ height: 300 }} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card>
            <ReactECharts option={merchantDistributionOption} style={{ height: 300 }} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card>
            <ReactECharts option={rewardTierOption} style={{ height: 300 }} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card>
            <ReactECharts option={rewardStageOption} style={{ height: 300 }} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
