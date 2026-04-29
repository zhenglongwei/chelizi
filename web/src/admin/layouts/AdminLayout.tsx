import { useEffect, useMemo, useState } from 'react';
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
  SafetyOutlined,
  PercentageOutlined,
  ContainerOutlined,
  PictureOutlined,
} from '@ant-design/icons';
import { useAuth } from '../hooks/useAuth';
import './AdminLayout.css';

const { Header, Sider, Content } = Layout;

const menuItems = [
  {
    key: 'group:data',
    icon: <BarChartOutlined />,
    label: '数据',
    children: [
      { key: '/admin/dashboard', icon: <DashboardOutlined />, label: '数据概览' },
      { key: '/admin/statistics', icon: <BarChartOutlined />, label: '数据统计' },
    ],
  },
  {
    key: 'group:merchant',
    icon: <ShopOutlined />,
    label: '商家&商品',
    children: [
      { key: '/admin/merchants', icon: <ShopOutlined />, label: '服务商管理' },
      { key: '/admin/shop-products', icon: <AuditOutlined />, label: '商品审核' },
      { key: '/admin/shop-income-corp', icon: <DollarOutlined />, label: '货款对公提现' },
    ],
  },
  {
    key: 'group:order',
    icon: <FileTextOutlined />,
    label: '订单&结算',
    children: [
      { key: '/admin/orders', icon: <FileTextOutlined />, label: '订单管理' },
      { key: '/admin/settlement', icon: <DollarOutlined />, label: '结算管理' },
    ],
  },
  {
    key: 'group:audit',
    icon: <AuditOutlined />,
    label: '审核&申诉',
    children: [
      { key: '/admin/material-audit-tasks', icon: <ContainerOutlined />, label: '完工材料人工审核' },
      { key: '/admin/damage-analysis-manual-review', icon: <PictureOutlined />, label: '定损人工审核' },
      { key: '/admin/review-evidence-anomaly-tasks', icon: <SafetyOutlined />, label: '评价—过程证据异常复核' },
      { key: '/admin/appeal-reviews', icon: <AuditOutlined />, label: '申诉复核' },
      { key: '/admin/disputes', icon: <WarningOutlined />, label: '纠纷处理（占位）' },
    ],
  },
  {
    key: 'group:risk',
    icon: <SafetyOutlined />,
    label: '风控',
    children: [{ key: '/admin/antifraud', icon: <SafetyOutlined />, label: '防刷管理' }],
  },
  {
    key: 'group:config',
    icon: <SettingOutlined />,
    label: '配置',
    children: [
      { key: '/admin/config', icon: <SettingOutlined />, label: '系统配置' },
      { key: '/admin/reward-rules', icon: <GiftOutlined />, label: '奖励金规则配置' },
      { key: '/admin/commission-rules', icon: <PercentageOutlined />, label: '佣金规则配置' },
    ],
  },
];

function deriveOpenKeysFromPath(pathname: string) {
  const p = pathname || '';
  if (p.startsWith('/admin/dashboard') || p.startsWith('/admin/statistics')) return ['group:data'];
  if (p.startsWith('/admin/merchants') || p.startsWith('/admin/shop-products') || p.startsWith('/admin/shop-income-corp'))
    return ['group:merchant'];
  if (p.startsWith('/admin/orders') || p.startsWith('/admin/settlement')) return ['group:order'];
  if (
    p.startsWith('/admin/material-audit-tasks') ||
    p.startsWith('/admin/damage-analysis-manual-review') ||
    p.startsWith('/admin/review-evidence-anomaly-tasks') ||
    p.startsWith('/admin/appeal-reviews') ||
    p.startsWith('/admin/disputes')
  )
    return ['group:audit'];
  if (p.startsWith('/admin/antifraud')) return ['group:risk'];
  if (p.startsWith('/admin/config') || p.startsWith('/admin/reward-rules') || p.startsWith('/admin/commission-rules'))
    return ['group:config'];
  return [];
}

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();

  const handleMenuClick = ({ key }: { key: string }) => {
    navigate(key);
  };

  const defaultOpen = useMemo(() => deriveOpenKeysFromPath(location.pathname), [location.pathname]);
  const [openKeys, setOpenKeys] = useState<string[]>(defaultOpen);

  useEffect(() => {
    setOpenKeys(defaultOpen);
  }, [defaultOpen]);

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
          openKeys={openKeys}
          onOpenChange={(keys) => setOpenKeys(keys as string[])}
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

