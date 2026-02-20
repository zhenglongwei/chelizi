/**
 * API 请求封装
 * 所有请求必须通过本模块
 * 与 web 后台共用同一 api-server（阿里云）
 */

const config = require('../config.js');
const BASE_URL = config.BASE_URL;

function getToken() {
  return wx.getStorageSync('token') || '';
}

function getUserId() {
  const user = wx.getStorageSync('user');
  return (user && user.user_id) || '';
}

function setToken(token) {
  if (token) {
    wx.setStorageSync('token', token);
  } else {
    wx.removeStorageSync('token');
  }
}

function getMerchantToken() {
  return wx.getStorageSync('merchant_token') || '';
}

function setMerchantToken(token) {
  if (token) {
    wx.setStorageSync('merchant_token', token);
  } else {
    wx.removeStorageSync('merchant_token');
  }
}

function getMerchantUser() {
  const raw = wx.getStorageSync('merchant_user');
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function setMerchantUser(user) {
  if (user) {
    wx.setStorageSync('merchant_user', user);
  } else {
    wx.removeStorageSync('merchant_user');
  }
}

function request(options) {
  const { url, method = 'GET', data, header = {} } = options;
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...header
  };
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  return requestWithHeaders({ url, method, data, headers });
}

function merchantRequest(options) {
  const { url, method = 'GET', data, header = {} } = options;
  const token = getMerchantToken();
  const headers = { 'Content-Type': 'application/json', ...header };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return requestWithHeaders({ url, method, data, headers });
}

function requestWithHeaders(options) {
  const { url, method = 'GET', data, headers = {} } = options;
  return new Promise((resolve, reject) => {
    wx.request({
      url: (url || '').startsWith('http') ? url : BASE_URL + url,
      method,
      data,
      header: { 'Content-Type': 'application/json', ...headers },
      success: (res) => {
        const body = res.data || {};
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (body.code !== undefined && body.code !== 200) {
            reject(new Error(body.message || '请求失败'));
          } else {
            resolve(body.data !== undefined ? body.data : body);
          }
        } else {
          reject(new Error(body.message || '请求失败'));
        }
      },
      fail: (err) => reject(err)
    });
  });
}

const api = {
  get: (url, data) => request({ url, method: 'GET', data }),
  post: (url, data) => request({ url, method: 'POST', data }),
  put: (url, data) => request({ url, method: 'PUT', data }),
  delete: (url) => request({ url, method: 'DELETE' })
};

module.exports = {
  BASE_URL,
  getToken,
  setToken,
  getUserId,
  getMerchantToken,
  setMerchantToken,
  getMerchantUser,
  setMerchantUser,
  request,
  api,
  getShopsNearby: (params) => api.get('/api/v1/shops/nearby', params),
  getShopsSearch: (params) => api.get('/api/v1/shops/search', params),
  getShopDetail: (id) => api.get('/api/v1/shops/' + id),
  getShopReviews: (id, params) => api.get('/api/v1/shops/' + id + '/reviews', params),
  createAppointment: (data) => api.post('/api/v1/appointments', data),
  uploadImage: (filePath) => {
    const token = getToken();
    return new Promise((resolve, reject) => {
      wx.uploadFile({
        url: BASE_URL + (BASE_URL.endsWith('/') ? '' : '/') + 'api/v1/upload/image',
        filePath,
        name: 'image',
        header: token ? { Authorization: 'Bearer ' + token } : {},
        success: (res) => {
          let body = {};
          try {
            body = JSON.parse(res.data || '{}');
          } catch (_) {}
          if (res.statusCode >= 200 && res.statusCode < 300 && body.code === 200 && body.data && body.data.url) {
            resolve(body.data.url);
          } else {
            reject(new Error(body.message || '上传失败'));
          }
        },
        fail: (err) => reject(err)
      });
    });
  },
  /** 服务商端图片上传（使用 merchant_token） */
  merchantUploadImage: (filePath) => {
    const token = getMerchantToken();
    return new Promise((resolve, reject) => {
      wx.uploadFile({
        url: BASE_URL + (BASE_URL.endsWith('/') ? '' : '/') + 'api/v1/merchant/upload/image',
        filePath,
        name: 'image',
        header: token ? { Authorization: 'Bearer ' + token } : {},
        success: (res) => {
          let body = {};
          try {
            body = JSON.parse(res.data || '{}');
          } catch (_) {}
          if (res.statusCode >= 200 && res.statusCode < 300 && body.code === 200 && body.data && body.data.url) {
            resolve(body.data.url);
          } else {
            reject(new Error(body.message || '上传失败'));
          }
        },
        fail: (err) => reject(err)
      });
    });
  },
  analyzeDamage: (data) => api.post('/api/v1/damage/analyze', data),
  getDamageReports: (params) => api.get('/api/v1/damage/reports', params),
  getDamageReport: (id) => api.get('/api/v1/damage/report/' + id),
  createBidding: (data) => api.post('/api/v1/bidding/create', data),
  authLogin: (code) => api.post('/api/v1/auth/login', { code }),
  updateUserProfile: (data) => api.put('/api/v1/user/profile', data),
  getUserProfile: () => api.get('/api/v1/user/profile'),
  getUserBiddings: (params) => api.get('/api/v1/user/biddings', params),
  getBiddingDetail: (id) => api.get('/api/v1/bidding/' + id),
  getBiddingQuotes: (id, params) => api.get('/api/v1/bidding/' + id + '/quotes', params),
  selectBiddingShop: (id, data) => api.post('/api/v1/bidding/' + id + '/select', data),
  endBidding: (id) => api.post('/api/v1/bidding/' + id + '/end'),
  /** 开发测试：为竞价生成模拟报价（仅开发环境 api-server 提供） */
  seedDevQuotes: (biddingId) => api.post('/api/v1/dev/seed-quotes', { bidding_id: biddingId }),
  getUserOrders: (params) => api.get('/api/v1/user/orders', params),
  getUserOrder: (id) => api.get('/api/v1/user/orders/' + id),
  getRewardPreview: (id) => api.get('/api/v1/user/orders/' + id + '/reward-preview'),
  cancelOrder: (id) => api.post('/api/v1/user/orders/' + id + '/cancel'),
  confirmOrder: (id) => api.post('/api/v1/user/orders/' + id + '/confirm'),
  getOrderForReview: (id) => api.get('/api/v1/user/orders/' + id + '/for-review'),
  getOrderFirstReview: (id) => api.get('/api/v1/user/orders/' + id + '/first-review'),
  submitReview: (data) => api.post('/api/v1/reviews', data),
  analyzeReview: (data) => api.post('/api/v1/reviews/analyze', data),
  getReviewDetail: (id) => api.get('/api/v1/reviews/' + id),
  submitFollowup: (id, data) => api.post('/api/v1/reviews/' + id + '/followup', data),
  submitReturnReview: (data) => api.post('/api/v1/reviews/return', data),
  getUserBalance: (params) => api.get('/api/v1/user/balance', params),
  withdraw: (data) => api.post('/api/v1/user/withdraw', data),
  getUserMessages: (params) => api.get('/api/v1/user/messages', params),
  markMessagesRead: (data) => api.post('/api/v1/user/messages/read', data),
  getUnreadCount: () => api.get('/api/v1/user/messages/unread-count'),
  merchantLogin: (data) => api.post('/api/v1/merchant/login', data),
  merchantRegister: (data) => api.post('/api/v1/merchant/register', data),
  ocrBusinessLicense: (imgUrl) => api.post('/api/v1/merchant/ocr-license', { img_url: imgUrl }),
  // 服务商端接口（需 merchant_token）
  getMerchantDashboard: () => merchantRequest({ url: '/api/v1/merchant/dashboard', method: 'GET' }),
  getMerchantBiddings: (params) => merchantRequest({ url: '/api/v1/merchant/biddings', method: 'GET', data: params }),
  getMerchantBidding: (id) => merchantRequest({ url: '/api/v1/merchant/bidding/' + id, method: 'GET' }),
  submitQuote: (data) => merchantRequest({ url: '/api/v1/merchant/quote', method: 'POST', data }),
  getMerchantOrders: (params) => merchantRequest({ url: '/api/v1/merchant/orders', method: 'GET', data: params }),
  getMerchantOrder: (id) => merchantRequest({ url: '/api/v1/merchant/orders/' + id, method: 'GET' }),
  acceptOrder: (id) => merchantRequest({ url: '/api/v1/merchant/orders/' + id + '/accept', method: 'POST' }),
  updateOrderStatus: (id, status) => merchantRequest({ url: '/api/v1/merchant/orders/' + id + '/status', method: 'PUT', data: { status } }),
  getMerchantShop: () => merchantRequest({ url: '/api/v1/merchant/shop', method: 'GET' }),
  updateMerchantShop: (data) => merchantRequest({ url: '/api/v1/merchant/shop', method: 'PUT', data }),
  withdrawMerchantQualification: () => merchantRequest({ url: '/api/v1/merchant/shop/withdraw-qualification', method: 'POST' }),
  /** 职业证书 AI 识别 */
  merchantAnalyzeTechnicianCert: (imgUrl) => merchantRequest({ url: '/api/v1/merchant/technician-cert/analyze', method: 'POST', data: { img_url: imgUrl } }),
  /** 维修资质证明 AI 识别（营业执照未识别到时使用） */
  merchantAnalyzeQualificationCert: (imgUrl) => merchantRequest({ url: '/api/v1/merchant/qualification-cert/analyze', method: 'POST', data: { img_url: imgUrl } })
};
