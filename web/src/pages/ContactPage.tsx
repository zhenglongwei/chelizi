import { Layout, Typography, Form, Input, Button, Card, Row, Col } from 'antd';
import { Link } from 'react-router-dom';
import { PhoneOutlined, MailOutlined, EnvironmentOutlined } from '@ant-design/icons';
import './ContactPage.css';

const { Header, Content, Footer } = Layout;
const { Title, Paragraph } = Typography;
const { TextArea } = Input;

export default function ContactPage() {
  const [form] = Form.useForm();

  const handleSubmit = (values: any) => {
    console.log('提交表单:', values);
    // TODO: 实现表单提交逻辑
  };

  return (
    <Layout className="contact-layout">
      <Header className="contact-header">
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

      <Content className="contact-content">
        <div className="contact-container">
          <Title level={1}>联系我们</Title>
          <Paragraph>如有任何问题或建议，欢迎与我们联系</Paragraph>

          <Row gutter={[32, 32]}>
            <Col xs={24} lg={12}>
              <Card title="联系方式" bordered={false}>
                <div className="contact-info">
                  <div className="contact-item">
                    <PhoneOutlined className="contact-icon" />
                    <div>
                      <Title level={5}>电话</Title>
                      <Paragraph>400-XXX-XXXX</Paragraph>
                    </div>
                  </div>
                  <div className="contact-item">
                    <MailOutlined className="contact-icon" />
                    <div>
                      <Title level={5}>邮箱</Title>
                      <Paragraph>contact@example.com</Paragraph>
                    </div>
                  </div>
                  <div className="contact-item">
                    <EnvironmentOutlined className="contact-icon" />
                    <div>
                      <Title level={5}>地址</Title>
                      <Paragraph>XX省XX市XX区XX路XX号</Paragraph>
                    </div>
                  </div>
                </div>
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card title="留言反馈" bordered={false}>
                <Form form={form} onFinish={handleSubmit} layout="vertical">
                  <Form.Item
                    name="name"
                    label="姓名"
                    rules={[{ required: true, message: '请输入姓名' }]}
                  >
                    <Input placeholder="请输入您的姓名" />
                  </Form.Item>
                  <Form.Item
                    name="phone"
                    label="电话"
                    rules={[{ required: true, message: '请输入电话' }]}
                  >
                    <Input placeholder="请输入您的电话" />
                  </Form.Item>
                  <Form.Item
                    name="email"
                    label="邮箱"
                    rules={[{ type: 'email', message: '请输入有效的邮箱地址' }]}
                  >
                    <Input placeholder="请输入您的邮箱" />
                  </Form.Item>
                  <Form.Item
                    name="message"
                    label="留言内容"
                    rules={[{ required: true, message: '请输入留言内容' }]}
                  >
                    <TextArea rows={4} placeholder="请输入您的留言内容" />
                  </Form.Item>
                  <Form.Item>
                    <Button type="primary" htmlType="submit" block>
                      提交
                    </Button>
                  </Form.Item>
                </Form>
              </Card>
            </Col>
          </Row>
        </div>
      </Content>

      <Footer className="contact-footer">
        <div className="footer-content">
          <span>© 2024 盈简科技. All rights reserved.</span>
        </div>
      </Footer>
    </Layout>
  );
}

