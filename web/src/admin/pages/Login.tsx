import { Form, Input, Button, Card, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import './Login.css';

export default function AdminLogin() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [form] = Form.useForm();

  const handleSubmit = async (values: { username: string; password: string }) => {
    const result = await login(values.username, values.password);
    if (result.success) {
      message.success('登录成功');
      navigate('/admin/dashboard');
    } else {
      message.error(result.message || '登录失败');
    }
  };

  return (
    <div className="login-container">
      <Card className="login-card" title="管理后台登录">
        <Form form={form} onFinish={handleSubmit} layout="vertical">
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input placeholder="请输入用户名" size="large" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password placeholder="请输入密码" size="large" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block size="large">
              登录
            </Button>
          </Form.Item>
        </Form>
        <div className="login-tip">
          <p>默认账号：admin / admin123</p>
        </div>
      </Card>
    </div>
  );
}

