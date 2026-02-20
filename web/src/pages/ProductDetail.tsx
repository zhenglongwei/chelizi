import { useParams, useNavigate } from 'react-router-dom';
import { Layout, Button, Card, Typography, Space } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { QRCodeSVG } from 'qrcode.react';
import './ProductDetail.css';

const { Header, Content, Footer } = Layout;
const { Title, Paragraph } = Typography;

// 产品信息配置
const products: Record<string, any> = {
  'accident-repair': {
    name: '事故车维修竞价平台',
    description: '连接车主与优质服务商，提供透明、高效、有保障的维修服务',
    features: [
      {
        title: '高返点优惠',
        icon: '💰',
        desc: '非原厂件维修享受10%消费返现，让您省钱更省心'
      },
      {
        title: '品质保障',
        icon: '🛡️',
        desc: '严格审核服务商资质，确保维修质量与配件真实性'
      },
      {
        title: '快速响应',
        icon: '⚡',
        desc: '多服务商竞价，快速获取报价，24小时内完成选择'
      },
      {
        title: '全程透明',
        icon: '👁️',
        desc: '维修进度实时查看，配件溯源可查，验收标准明确'
      }
    ],
    process: [
      { step: 1, title: '上传事故信息', desc: '拍照上传事故照片，填写基本信息' },
      { step: 2, title: '获取多份报价', desc: '平台匹配服务商，获取多份标准化报价' },
      { step: 3, title: '选择服务商', desc: '对比报价与服务，选择最适合的服务商' },
      { step: 4, title: '完成维修验收', desc: '维修完成验收，享受返现优惠' }
    ],
    // 小程序二维码：可以是小程序码图片URL，或者使用小程序路径生成
    // 方式1：使用小程序码图片URL（推荐）
    qrCodeUrl: 'https://your-miniprogram-qrcode-image-url.com',
    // 方式2：使用小程序路径（需要后端生成小程序码）
    // qrCodeUrl: 'pages/index/index',
    wechatAccount: 'your-wechat-account', // 公众号名称，需要替换为实际的公众号
    miniprogramName: '事故车维修竞价平台' // 小程序名称
  }
  // 可以添加更多产品
  // 'other-product': {
  //   name: '其他产品',
  //   ...
  // }
};

export default function ProductDetail() {
  const { productId } = useParams<{ productId: string }>();
  const navigate = useNavigate();
  const product = products[productId || ''];

  if (!product) {
    return (
      <Layout className="product-detail-layout">
        <Content className="product-detail-content">
          <div className="not-found">
            <Title level={2}>产品不存在</Title>
            <Button onClick={() => navigate('/')}>返回首页</Button>
          </div>
        </Content>
      </Layout>
    );
  }

  return (
    <Layout className="product-detail-layout">
      <Header className="product-detail-header">
        <div className="header-content">
          <div className="logo">盈简科技</div>
          <nav className="nav-menu">
            <a href="/">首页</a>
            <a href="/about">关于我们</a>
            <a href="/contact">联系我们</a>
            <a href="/admin/login">管理后台</a>
          </nav>
        </div>
      </Header>

      <Content className="product-detail-content">
        <div className="product-container">
          <Button 
            type="link" 
            icon={<ArrowLeftOutlined />} 
            onClick={() => navigate('/')}
            className="back-button"
          >
            返回首页
          </Button>

          <div className="product-hero">
            <Title level={1}>{product.name}</Title>
            <Paragraph className="product-subtitle">{product.description}</Paragraph>
          </div>

          <div className="product-sections">
            {/* 产品特色 */}
            <section className="product-section">
              <Title level={2}>产品特色</Title>
              <div className="features-grid">
                {product.features.map((feature: any, index: number) => (
                  <Card key={index} className="feature-card">
                    <div className="feature-icon">{feature.icon}</div>
                    <Title level={4}>{feature.title}</Title>
                    <Paragraph>{feature.desc}</Paragraph>
                  </Card>
                ))}
              </div>
            </section>

            {/* 使用流程 */}
            <section className="product-section">
              <Title level={2}>使用流程</Title>
              <div className="process-steps">
                {product.process.map((item: any) => (
                  <div key={item.step} className="process-step">
                    <div className="step-number">{item.step}</div>
                    <div className="step-content">
                      <Title level={4}>{item.title}</Title>
                      <Paragraph>{item.desc}</Paragraph>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* 立即使用 */}
            <section className="product-section qr-section">
              <Card className="qr-card">
                <Title level={2}>立即使用</Title>
                <div className="qr-content">
                  <div className="qr-code-wrapper">
                    <QRCodeSVG
                      value={product.qrCodeUrl}
                      size={200}
                      level="M"
                    />
                    <Paragraph className="qr-tip">扫码使用小程序</Paragraph>
                  </div>
                  <div className="qr-info">
                    <Paragraph>
                      或搜索微信公众号：<strong>{product.wechatAccount}</strong>
                    </Paragraph>
                    <Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 8 }}>
                      扫描上方二维码，立即使用{product.miniprogramName || '小程序'}
                    </Paragraph>
                    <Space direction="vertical" style={{ width: '100%' }}>
                      <Button 
                        type="primary" 
                        size="large" 
                        className="use-button"
                        block
                        onClick={() => {
                          // 可以添加跳转到小程序的逻辑
                          // 如果是小程序路径，可以调用微信API
                          if (product.qrCodeUrl.startsWith('http')) {
                            window.open(product.qrCodeUrl, '_blank');
                          }
                        }}
                      >
                        立即体验
                      </Button>
                      <Button 
                        type="default" 
                        size="large" 
                        block
                        onClick={() => navigate('/')}
                      >
                        返回首页
                      </Button>
                    </Space>
                  </div>
                </div>
              </Card>
            </section>
          </div>
        </div>
      </Content>

      <Footer className="product-detail-footer">
        <div className="footer-content">
          <span>© 2024 盈简科技. All rights reserved.</span>
        </div>
      </Footer>
    </Layout>
  );
}

