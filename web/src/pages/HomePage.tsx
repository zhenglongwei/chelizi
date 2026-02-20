import { Layout, Button, Card, Row, Col, Typography, Space } from 'antd';
import { Link, useNavigate } from 'react-router-dom';
import { RocketOutlined, BulbOutlined, TeamOutlined, AppstoreOutlined } from '@ant-design/icons';
import './HomePage.css';

const { Header, Content, Footer } = Layout;
const { Title, Paragraph, Text } = Typography;

export default function HomePage() {
  const navigate = useNavigate();

  const products = [
    {
      id: 'accident-repair',
      name: '事故车维修竞价平台',
      description: '连接车主与优质服务商，提供透明、高效、有保障的维修服务',
      icon: '🚗'
    }
    // 可以添加更多产品
  ];

  return (
    <Layout className="home-layout">
      <Header className="home-header">
        <div className="header-content">
          <div className="logo">盈简科技</div>
          <nav className="nav-menu">
            <Link to="/">首页</Link>
            <Link to="/about">关于我们</Link>
            <Link to="/contact">联系我们</Link>
            <Link to="/admin/login">管理后台</Link>
          </nav>
        </div>
      </Header>

      <Content className="home-content">
        {/* Hero Section */}
        <section className="hero-section">
          <div className="hero-content">
            <Title level={1} className="hero-title">
              盈简科技
            </Title>
            <Paragraph className="hero-subtitle">
              让客户简简单单就能获得最好的服务、收益
            </Paragraph>
            <Paragraph className="hero-description">
              我们是一家专注于为客户提供简单、高效、优质服务的科技公司
            </Paragraph>
            <Space size="large">
              <Button type="primary" size="large" onClick={() => navigate('/about')}>
                了解更多
              </Button>
              <Button size="large" onClick={() => navigate('/contact')}>
                联系我们
              </Button>
            </Space>
          </div>
        </section>

        {/* Company Values Section */}
        <section className="values-section">
          <Title level={2} className="section-title">我们的理念</Title>
          <Row gutter={[32, 32]}>
            <Col xs={24} sm={12} lg={6}>
              <Card className="value-card">
                <RocketOutlined className="value-icon" />
                <Title level={4}>简单高效</Title>
                <Paragraph>用科技简化流程，让复杂的事情变得简单</Paragraph>
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card className="value-card">
                <BulbOutlined className="value-icon" />
                <Title level={4}>创新驱动</Title>
                <Paragraph>持续创新，用技术为客户创造价值</Paragraph>
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card className="value-card">
                <TeamOutlined className="value-icon" />
                <Title level={4}>客户至上</Title>
                <Paragraph>以客户需求为中心，提供最优质的服务</Paragraph>
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card className="value-card">
                <AppstoreOutlined className="value-icon" />
                <Title level={4}>持续优化</Title>
                <Paragraph>不断改进产品和服务，追求卓越</Paragraph>
              </Card>
            </Col>
          </Row>
        </section>

        {/* Products Section */}
        <section className="products-section">
          <Title level={2} className="section-title">我们的产品</Title>
          <Row gutter={[32, 32]}>
            {products.map((product) => (
              <Col xs={24} sm={12} lg={8} key={product.id}>
                <Card 
                  className="product-card"
                  hoverable
                  onClick={() => navigate(`/product/${product.id}`)}
                >
                  <div className="product-icon">{product.icon}</div>
                  <Title level={3}>{product.name}</Title>
                  <Paragraph>{product.description}</Paragraph>
                  <Button type="link" className="product-link">
                    了解详情 →
                  </Button>
                </Card>
              </Col>
            ))}
          </Row>
        </section>

        {/* Company Intro Section */}
        <section className="intro-section">
          <Row gutter={[48, 48]} align="middle">
            <Col xs={24} lg={12}>
              <Title level={2}>关于盈简科技</Title>
              <Paragraph>
                盈简科技是一家专注于为客户提供简单、高效、优质服务的科技公司。
                我们相信，最好的服务应该是简单易用的，最好的收益应该是触手可及的。
              </Paragraph>
              <Paragraph>
                通过技术创新和产品优化，我们致力于让每一位客户都能轻松获得最好的服务体验和收益回报。
                无论是个人用户还是企业客户，我们都能提供专业、可靠的解决方案。
              </Paragraph>
              <Button type="primary" size="large" onClick={() => navigate('/about')}>
                了解更多
              </Button>
            </Col>
            <Col xs={24} lg={12}>
              <div className="intro-image">
                <div className="placeholder-image">
                  <Text>公司形象图</Text>
                </div>
              </div>
            </Col>
          </Row>
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

