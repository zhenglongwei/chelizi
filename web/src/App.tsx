import { Routes, Route, Navigate } from 'react-router-dom';
import HomePage from './pages/HomePage';
import FairPricePage from './pages/FairPricePage';
import AboutPage from './pages/AboutPage';
import ContactPage from './pages/ContactPage';
import ProductDetail from './pages/ProductDetail';
import AdminLayout from './admin/layouts/AdminLayout';
import AdminLogin from './admin/pages/Login';
import Dashboard from './admin/pages/Dashboard';
import MerchantManagement from './admin/pages/MerchantManagement';
import OrderManagement from './admin/pages/OrderManagement';
import SettlementManagement from './admin/pages/SettlementManagement';
import DisputeManagement from './admin/pages/DisputeManagement';
import DataStatistics from './admin/pages/DataStatistics';
import SystemConfig from './admin/pages/SystemConfig';
import RewardRulesConfig from './admin/pages/RewardRulesConfig';
import CommissionRulesConfig from './admin/pages/CommissionRulesConfig';
import AppealReviewManagement from './admin/pages/AppealReviewManagement';
import AntiFraudManagement from './admin/pages/AntiFraudManagement';
import MaterialAuditTasks from './admin/pages/MaterialAuditTasks';
import ReviewEvidenceAnomalyTasks from './admin/pages/ReviewEvidenceAnomalyTasks';
import ShopProductAudit from './admin/pages/ShopProductAudit';
import CorpIncomeWithdraw from './admin/pages/CorpIncomeWithdraw';
import DamageAnalysisManualReview from './admin/pages/DamageAnalysisManualReview';
import { useAuth } from './admin/hooks/useAuth';

function App() {
  return (
    <Routes>
      {/* 公司官网路由 */}
      <Route path="/" element={<HomePage />} />
      <Route path="/fair-price" element={<FairPricePage />} />
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
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="merchants" element={<MerchantManagement />} />
        <Route path="orders" element={<OrderManagement />} />
        <Route path="material-audit-tasks" element={<MaterialAuditTasks />} />
        <Route path="review-evidence-anomaly-tasks" element={<ReviewEvidenceAnomalyTasks />} />
        <Route path="settlement" element={<SettlementManagement />} />
        <Route path="disputes" element={<DisputeManagement />} />
        <Route path="statistics" element={<DataStatistics />} />
        <Route path="config" element={<SystemConfig />} />
        <Route path="reward-rules" element={<RewardRulesConfig />} />
        <Route path="commission-rules" element={<CommissionRulesConfig />} />
        <Route path="appeal-reviews" element={<AppealReviewManagement />} />
        <Route path="antifraud" element={<AntiFraudManagement />} />
        <Route path="shop-products" element={<ShopProductAudit />} />
        <Route path="shop-income-corp" element={<CorpIncomeWithdraw />} />
        <Route path="damage-analysis-manual-review" element={<DamageAnalysisManualReview />} />
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

