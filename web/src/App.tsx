import { Routes, Route, Navigate } from 'react-router-dom';
import HomePage from './pages/HomePage';
import AboutPage from './pages/AboutPage';
import ContactPage from './pages/ContactPage';
import ProductDetail from './pages/ProductDetail';
import AdminLayout from './admin/layouts/AdminLayout';
import AdminLogin from './admin/pages/Login';
import Dashboard from './admin/pages/Dashboard';
import MerchantManagement from './admin/pages/MerchantManagement';
import OrderManagement from './admin/pages/OrderManagement';
import RuleConfig from './admin/pages/RuleConfig';
import SettlementManagement from './admin/pages/SettlementManagement';
import DisputeManagement from './admin/pages/DisputeManagement';
import DataStatistics from './admin/pages/DataStatistics';
import SystemConfig from './admin/pages/SystemConfig';
import RewardRulesConfig from './admin/pages/RewardRulesConfig';
import ReviewAudit from './admin/pages/ReviewAudit';
import AppealReviewManagement from './admin/pages/AppealReviewManagement';
import ComplexityUpgrade from './admin/pages/ComplexityUpgrade';
import AntiFraudManagement from './admin/pages/AntiFraudManagement';
import OrderCancelRequests from './admin/pages/OrderCancelRequests';
import { useAuth } from './admin/hooks/useAuth';

function App() {
  return (
    <Routes>
      {/* 公司官网路由 */}
      <Route path="/" element={<HomePage />} />
      <Route path="/about" element={<AboutPage />} />
      <Route path="/contact" element={<ContactPage />} />
      <Route path="/product/:productId" element={<ProductDetail />} />
      
      {/* 后台管理系统路由 */}
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route
        path="/admin/*"
        element={
          <ProtectedRoute>
            <AdminLayout />
          </ProtectedRoute>
        }
      >
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="merchants" element={<MerchantManagement />} />
        <Route path="orders" element={<OrderManagement />} />
        <Route path="order-cancel-requests" element={<OrderCancelRequests />} />
        <Route path="rules" element={<RuleConfig />} />
        <Route path="settlement" element={<SettlementManagement />} />
        <Route path="disputes" element={<DisputeManagement />} />
        <Route path="statistics" element={<DataStatistics />} />
        <Route path="config" element={<SystemConfig />} />
        <Route path="reward-rules" element={<RewardRulesConfig />} />
        <Route path="review-audit" element={<ReviewAudit />} />
        <Route path="appeal-reviews" element={<AppealReviewManagement />} />
        <Route path="complexity-upgrade" element={<ComplexityUpgrade />} />
        <Route path="antifraud" element={<AntiFraudManagement />} />
      </Route>
    </Routes>
  );
}

// 受保护的路由组件
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return <div>加载中...</div>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/admin/login" replace />;
  }

  return <>{children}</>;
}

export default App;

