import { useState } from 'react';
import { Layout, Typography, Input, Button, Card, Alert, Space } from 'antd';
import { Link } from 'react-router-dom';
import axios from 'axios';
import './HomePage.css';

const { Header, Content, Footer } = Layout;
const { Title, Paragraph, Text } = Typography;

type FairPriceResponse = {
  ok: boolean;
  code?: string;
  message?: string;
  sampleCount?: number;
  avgAmount?: number;
  minAmount?: number;
  maxAmount?: number;
  periodDays?: number;
  disclaimer?: string;
};

function apiBase(): string {
  const raw = import.meta.env.VITE_API_BASE_URL || '';
  return raw.replace(/\/$/, '');
}

export default function FairPricePage() {
  const [model, setModel] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FairPriceResponse | null>(null);

  const onSearch = async () => {
    setLoading(true);
    setResult(null);
    try {
      const base = apiBase();
      const url = base
        ? `${base}/api/v1/public/historical-fair-price`
        : '/api/v1/public/historical-fair-price';
      const { data } = await axios.get(url, {
        params: { model: model.trim() },
        timeout: 15000
      });
      const payload = data?.data ?? data;
      setResult(payload as FairPriceResponse);
    } catch (e: unknown) {
      const msg = axios.isAxiosError(e) ? e.message : '请求失败';
      setResult({
        ok: false,
        code: 'NETWORK',
        message: `${msg}。请配置 VITE_API_BASE_URL 指向 API 服务，或稍后重试。`,
        sampleCount: 0
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout className="home-layout">
      <Header className="home-header">
        <div className="header-content">
          <div className="logo">盈简科技</div>
          <nav className="nav-menu">
            <Link to="/">首页</Link>
            <Link to="/fair-price">历史成交参考价</Link>
            <Link to="/admin/login">管理后台</Link>
          </nav>
        </div>
      </Header>

      <Content className="home-content">
        <section className="hero-section" style={{ minHeight: 'auto', paddingTop: 48, paddingBottom: 48 }}>
          <Title level={2}>同车型历史成交参考价</Title>
          <Paragraph type="secondary">
            基于平台近一年已完成订单的<strong>匿名聚合</strong>，仅作参考；样本不足时不展示区间。小程序竞价已含价格因素，本功能为官网补充查询。
          </Paragraph>

          <Space.Compact style={{ maxWidth: 480, width: '100%', marginTop: 16 }}>
            <Input
              placeholder="输入品牌或车型关键词，如 雅阁、宝马3系"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onPressEnter={onSearch}
              allowClear
            />
            <Button type="primary" loading={loading} onClick={onSearch}>
              查询
            </Button>
          </Space.Compact>

          {result && (
            <Card style={{ marginTop: 24, maxWidth: 560, textAlign: 'left' }}>
              {!result.ok && (
                <Alert type="warning" message={result.message || '暂无数据'} showIcon />
              )}
              {result.ok && (
                <>
                  <Paragraph>
                    <Text strong>样本量</Text>：近 {result.periodDays} 天共 {result.sampleCount} 单（达到门槛后展示）
                  </Paragraph>
                  <Paragraph>
                    <Text strong>成交均价</Text>：{result.avgAmount} 元
                  </Paragraph>
                  <Paragraph>
                    <Text strong>区间</Text>：{result.minAmount} ～ {result.maxAmount} 元
                  </Paragraph>
                  <Alert type="info" message={result.disclaimer} style={{ marginTop: 12 }} />
                </>
              )}
            </Card>
          )}
        </section>
      </Content>

      <Footer className="home-footer">
        <div className="footer-content">
          <Text>© 2024 盈简科技. All rights reserved.</Text>
        </div>
      </Footer>
    </Layout>
  );
}
