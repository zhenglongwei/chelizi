import axios from 'axios';

/**
 * 管理端 API 根路径。
 * - 未配置 VITE_API_BASE_URL 时：用「当前页面 origin + /api」。
 * - 配置了但构建时误带 `http://localhost:...` 时：若当前页面是公网域名，自动改回「当前 origin + /api」，避免线上仍请求本机 3000（你截图里即此情况）→ CORS/Network Error。
 * - 本机开发（localhost 打开页面）时：仍使用 .env 中的本地 API 地址。
 */
function resolveApiBaseUrl(): string {
  const env = import.meta.env.VITE_API_BASE_URL as string | undefined;
  let candidate: string;
  if (env && String(env).trim() !== '') {
    const s = String(env).trim();
    if (s.startsWith('/')) {
      if (typeof window !== 'undefined' && window.location?.origin) {
        const path = s.replace(/\/$/, '') || '/api';
        return `${window.location.origin}${path}`;
      }
      candidate = s;
    } else {
      candidate = s.replace(/\/$/, '');
    }
  } else if (typeof window !== 'undefined' && window.location?.origin) {
    candidate = `${window.location.origin}/api`;
  } else {
    return 'https://simplewin.cn/api';
  }

  if (typeof window !== 'undefined' && window.location?.hostname) {
    const h = window.location.hostname;
    const pageIsLocal = h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    if (!pageIsLocal) {
      try {
        const u = new URL(candidate);
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
          return `${window.location.origin}/api`;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return candidate;
}

const API_BASE_URL = resolveApiBaseUrl();

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
    // 5xx/4xx 时后端 body 多为 { code, message }，用 message 作为 Error 文案便于界面与控制台排查
    const data = error.response?.data as { message?: string; code?: number } | undefined;
    const serverMsg =
      data && typeof data.message === 'string' && data.message.trim()
        ? data.message.trim()
        : '';
    if (serverMsg) {
      return Promise.reject(new Error(serverMsg));
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
      case 'closeCancelDisposal': {
        await api.post(`/v1/admin/orders/${data.orderNo}/cancel-disposal/close`, {
          note: data.note,
          result: data.result,
        });
        return { success: true, message: '已结案' };
      }
      case 'getRewardRulesConfig': {
        const res = await api.get('/v1/admin/reward-rules/config');
        return { success: true, data: res?.data ?? res };
      }
      case 'saveRewardRulesConfig':
        await api.post('/v1/admin/reward-rules/config', data.config);
        return { success: true, message: '保存成功' };
      case 'saveCommissionRules':
        await api.put('/v1/admin/commission-rules', data);
        return { success: true, message: '保存成功' };
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
