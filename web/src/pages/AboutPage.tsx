import { Layout, Typography, Card, Row, Col } from 'antd';
import { Link } from 'react-router-dom';
import './AboutPage.css';

const { Header, Content, Footer } = Layout;
const { Title, Paragraph } = Typography;

export default function AboutPage() {
  const navigate = useNavigate();
  
  return (
    <Layout className="about-layout">
      <Header className="about-header">
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

      <Content className="about-content">
        <div className="about-container">
          <Title level={1}>关于盈简科技</Title>
          <Paragraph>
            盈简科技是一家专注于为客户提供简单、高效、优质服务的科技公司。
            我们相信，最好的服务应该是简单易用的，最好的收益应该是触手可及的。
          </Paragraph>

          <Title level={2}>我们的理念</Title>
          <Paragraph>
            <strong>让客户简简单单就能获得最好的服务、收益</strong>
          </Paragraph>
          <Paragraph>
            在这个信息爆炸、选择困难的时代，我们致力于用科技的力量简化复杂，
            让每一位客户都能轻松获得最好的服务体验和收益回报。
          </Paragraph>

          <Title level={2}>公司定位</Title>
          <Paragraph>
            盈简科技是一家科技公司，专注于通过技术创新和产品优化，
            为客户提供简单、高效、优质的解决方案。
          </Paragraph>

          <Title level={2}>我们的产品</Title>
          <Row gutter={[24, 24]}>
            <Col xs={24} md={12}>
              <Card 
                title="事故车维修竞价平台" 
                bordered={false}
                hoverable
                onClick={() => navigate('/product/accident-repair')}
                style={{ cursor: 'pointer' }}
              >
                <Paragraph>
                  连接车主与优质服务商，提供透明、高效、有保障的维修服务。
                  通过竞价机制，让车主获得最优报价，让服务商获得精准客源。
                </Paragraph>
                <Button type="link" onClick={(e) => {
                  e.stopPropagation();
                  navigate('/product/accident-repair');
                }}>
                  了解详情 →
                </Button>
              </Card>
            </Col>
            <Col xs={24} md={12}>
              <Card title="更多产品" bordered={false}>
                <Paragraph>
                  我们持续开发更多优质产品，敬请期待...
                </Paragraph>
              </Card>
            </Col>
          </Row>
        </div>
      </Content>

      <Footer className="about-footer">
        <div className="footer-content">
          <span>© 2024 盈简科技. All rights reserved.</span>
        </div>
      </Footer>
    </Layout>
  );
}

