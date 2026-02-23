import axios from 'axios';

// API 基础 URL：与 .env 中 VITE_API_BASE_URL 一致
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://simplewin.cn/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// 请求拦截器
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('admin_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// 响应拦截器：统一解包 data，保持与现有业务逻辑兼容
api.interceptors.response.use(
  (response) => {
    const body = response.data;
    if (body && body.code !== undefined && body.code !== 200) {
      return Promise.reject(new Error(body.message || '请求失败'));
    }
    // 返回完整 body，callCloudFunction 中再取 data
    return body;
  },
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('admin_token');
      localStorage.removeItem('admin_user');
      window.location.href = '/admin/login';
    }
    return Promise.reject(error);
  }
);

/**
 * 云函数兼容层：将原云函数调用映射为 HTTP API
 * 管理端与小程序共用同一 api-server（阿里云）
 */
export async function callCloudFunction(functionName: string, data: any) {
  try {
    let result: any;

    switch (functionName) {
      case 'getMerchants': {
        const res = await api.get('/v1/admin/merchants', { params: data });
        return { success: true, data: res?.data ?? res };
      }
      case 'auditMerchant':
        await api.post(`/v1/admin/merchants/${data.merchantId}/audit`, data);
        return { success: true, message: '审核成功' };
      case 'qualificationAudit':
        await api.post(`/v1/admin/merchants/${data.merchantId}/qualification-audit`, {
          auditStatus: data.auditStatus,
          rejectReason: data.auditNote || data.rejectReason
        });
        return { success: true, message: '资质审核成功' };
      case 'getAllOrders': {
        const res = await api.get('/v1/admin/orders', { params: data });
        return { success: true, data: res?.data ?? res };
      }
      case 'getOrderDetail': {
        const res = await api.get(`/v1/admin/orders/${data.orderNo}`);
        return { success: true, data: res?.data ?? res };
      }
      case 'auditQuote':
        await api.post(`/v1/admin/orders/${data.orderNo}/audit-quote`, data);
        return { success: true, message: '审核成功' };
      case 'getStatistics': {
        const res = await api.get('/v1/admin/statistics', { params: data });
        return { success: true, data: res?.data ?? res };
      }
      case 'getSettlements': {
        const res = await api.get('/v1/admin/settlements', { params: data });
        return { success: true, data: res?.data ?? res };
      }
      case 'getComplaints': {
        const res = await api.get('/v1/admin/complaints');
        return { success: true, data: (res?.data ?? res) || [] };
      }
      case 'updateData':
        if (data.collection === 'complaints') {
          await api.put(`/v1/admin/complaints/${data.where._id}`, data.data);
        } else if (data.collection === 'system_config') {
          const key = data.where?.key;
          const value = data.data?.value;
          if (key !== undefined) {
            await api.put('/v1/admin/config', { key, value });
          }
        }
        return { success: true };
      case 'queryData':
        if (data.collection === 'system_config') {
          const res = await api.get('/v1/admin/config');
          const list = Array.isArray(res) ? res : (res?.data ?? res?.list ?? []);
          return { success: true, data: list };
        }
        return { success: true, data: [] };
      case 'addData':
        if (data.collection === 'system_config' && data.data) {
          await api.put('/v1/admin/config', {
            key: data.data.key,
            value: data.data.value,
          });
        }
        return { success: true };
      case 'getCancelRequests': {
        const res = await api.get('/v1/admin/order-cancel-requests');
        const list = res?.data?.list ?? res?.list ?? [];
        return { success: true, data: { list } };
      }
      case 'resolveCancelRequest':
        await api.post(`/v1/admin/order-cancel-requests/${data.requestId}/resolve`, { approve: data.approve });
        return { success: true, message: data.approve ? '已同意撤单' : '已拒绝' };
      default:
        console.warn(`未映射的云函数: ${functionName}`);
        return { success: false, message: `接口 ${functionName} 暂未实现` };
    }
  } catch (error: any) {
    console.error(`调用 ${functionName} 失败:`, error);
    throw error;
  }
}

/**
 * @deprecated 使用 callCloudFunction 或直接 api.get/post
 */
export async function queryDatabase(collection: string, query: any) {
  if (collection === 'system_config') {
    const result = await api.get('/v1/admin/config');
    return Array.isArray(result) ? result : (result?.list || []);
  }
  return [];
}

export default api;
