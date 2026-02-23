import { Layout, Menu, Avatar, Dropdown, Space } from 'antd';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  DashboardOutlined,
  ShopOutlined,
  FileTextOutlined,
  SettingOutlined,
  DollarOutlined,
  WarningOutlined,
  BarChartOutlined,
  UserOutlined,
  LogoutOutlined,
  GiftOutlined,
  AuditOutlined,
  RiseOutlined,
  SafetyOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import { useAuth } from '../hooks/useAuth';
import './AdminLayout.css';

const { Header, Sider, Content } = Layout;

const menuItems = [
  {
    key: '/admin/dashboard',
    icon: <DashboardOutlined />,
    label: '数据概览',
  },
  {
    key: '/admin/merchants',
    icon: <ShopOutlined />,
    label: '服务商管理',
  },
  {
    key: '/admin/orders',
    icon: <FileTextOutlined />,
    label: '订单管理',
  },
  {
    key: '/admin/order-cancel-requests',
    icon: <RollbackOutlined />,
    label: '撤单申请',
  },
  {
    key: '/admin/rules',
    icon: <SettingOutlined />,
    label: '推荐规则配置',
  },
  {
    key: '/admin/settlement',
    icon: <DollarOutlined />,
    label: '结算管理',
  },
  {
    key: '/admin/disputes',
    icon: <WarningOutlined />,
    label: '纠纷处理',
  },
  {
    key: '/admin/statistics',
    icon: <BarChartOutlined />,
    label: '数据统计',
  },
  {
    key: '/admin/config',
    icon: <SettingOutlined />,
    label: '系统配置',
  },
  {
    key: '/admin/reward-rules',
    icon: <GiftOutlined />,
    label: '奖励金规则配置',
  },
  {
    key: '/admin/review-audit',
    icon: <AuditOutlined />,
    label: '评价审核',
  },
  {
    key: '/admin/antifraud',
    icon: <SafetyOutlined />,
    label: '防刷管理',
  },
  {
    key: '/admin/complexity-upgrade',
    icon: <RiseOutlined />,
    label: '破格升级',
  },
];

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();

  const handleMenuClick = ({ key }: { key: string }) => {
    navigate(key);
  };

  const handleLogout = () => {
    logout();
    navigate('/admin/login');
  };

  const userMenuItems = [
    {
      key: 'profile',
      icon: <UserOutlined />,
      label: '个人中心',
    },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '退出登录',
      onClick: handleLogout,
    },
  ];

  return (
    <Layout className="admin-layout">
      <Sider width={200} className="admin-sider">
        <div className="admin-logo">管理后台</div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={handleMenuClick}
          style={{ height: '100%', borderRight: 0 }}
        />
      </Sider>
      <Layout>
        <Header className="admin-header">
          <div className="header-right">
            <Space>
              <span>欢迎，{user?.username}</span>
              <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
                <Avatar icon={<UserOutlined />} />
              </Dropdown>
            </Space>
          </div>
        </Header>
        <Content className="admin-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}

