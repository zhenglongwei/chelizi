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
  return requestWithHeaders({ url, method, data, headers }).catch((err) => {
    if (err && err.statusCode === 401) {
      handleUserUnauthorized();
    }
    return Promise.reject(err);
  });
}

let _user401Redirecting = false;

/** 车主端 token 失效：清本地态并跳转登录（与 merchantRequest 行为一致） */
function handleUserUnauthorized() {
  if (_user401Redirecting) return;
  _user401Redirecting = true;
  setToken('');
  try {
    wx.removeStorageSync('user');
  } catch (_) {}
  wx.showToast({ title: '登录已失效，请重新登录', icon: 'none', duration: 2000 });
  setTimeout(() => {
    try {
      const pages = getCurrentPages();
      const top = pages[pages.length - 1];
      const path = top && top.route ? `/${top.route}` : '/pages/user/index/index';
      wx.redirectTo({
        url: '/pages/auth/login/index?redirect=' + encodeURIComponent(path),
        complete: () => {
          _user401Redirecting = false;
        },
      });
    } catch (_) {
      _user401Redirecting = false;
      wx.redirectTo({ url: '/pages/auth/login/index' });
    }
  }, 400);
}

let _merchant401Redirecting = false;

function handleMerchantUnauthorized() {
  if (_merchant401Redirecting) return;
  _merchant401Redirecting = true;
  setMerchantToken('');
  setMerchantUser(null);
  wx.showToast({ title: '登录已失效，请重新登录', icon: 'none', duration: 2000 });
  setTimeout(() => {
    try {
      const pages = getCurrentPages();
      const top = pages[pages.length - 1];
      const path = top && top.route ? `/${top.route}` : '/pages/merchant/home';
      wx.redirectTo({
        url: '/pages/merchant/login?redirect=' + encodeURIComponent(path),
        complete: () => {
          _merchant401Redirecting = false;
        },
      });
    } catch (_) {
      _merchant401Redirecting = false;
      wx.redirectTo({ url: '/pages/merchant/login' });
    }
  }, 400);
}

function merchantRequest(options) {
  const { url, method = 'GET', data, header = {} } = options;
  const token = getMerchantToken();
  const headers = { 'Content-Type': 'application/json', ...header };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return requestWithHeaders({ url, method, data, headers }).catch((err) => {
    if (err && err.statusCode === 401) {
      handleMerchantUnauthorized();
    }
    throw err;
  });
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
          const err = new Error(body.message || '请求失败');
          err.statusCode = res.statusCode;
          reject(err);
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
  getShopsRank: (params) => api.get('/api/v1/shops/rank', params),
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
  /** 服务商端图片上传（使用 merchant_token）。PNG 转 JPG 后上传，超过 5MB 自动压缩 */
  merchantUploadImage: async (filePath) => {
    const MAX_SIZE = 5 * 1024 * 1024;
    const getSize = (path) => new Promise((resolve, reject) => {
      wx.getFileInfo({ filePath: path, success: (r) => resolve(r.size), fail: reject });
    });
    const getImageType = (path) => new Promise((resolve) => {
      wx.getImageInfo({ src: path, success: (r) => resolve(r.type || ''), fail: () => resolve('') });
    });
    const compress = (src, quality, maxWidth) => new Promise((resolve, reject) => {
      const opts = { src, quality, success: (r) => resolve(r.tempFilePath), fail: reject };
      if (maxWidth) opts.compressedWidth = maxWidth;
      wx.compressImage(opts);
    });

    let toUpload = filePath;
    const imgType = await getImageType(filePath);
    if (imgType === 'png' || imgType === 'gif' || imgType === 'tiff') {
      try {
        toUpload = await compress(filePath, 90, 1920);
      } catch (e) {
        throw new Error('PNG 等格式暂不支持，请使用 JPG 格式图片上传');
      }
    }

    let size = await getSize(toUpload);
    if (size > MAX_SIZE) {
      const qualities = [50, 40, 30];
      for (const q of qualities) {
        try {
          toUpload = await compress(toUpload, q, 1920);
          size = await getSize(toUpload);
          if (size <= MAX_SIZE) break;
        } catch (_) {}
      }
      if (size > MAX_SIZE) {
        throw new Error('图片过大（超过 5MB），无法压缩到合适大小，请选择更小的图片');
      }
    }

    const token = getMerchantToken();
    return new Promise((resolve, reject) => {
      wx.uploadFile({
        url: BASE_URL + (BASE_URL.endsWith('/') ? '' : '/') + 'api/v1/merchant/upload/image',
        filePath: toUpload,
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
            const msg = body.message || (res.statusCode === 401 ? '请先登录服务商端' : res.statusCode === 503 ? '图片上传功能暂不可用' : '上传失败');
            reject(new Error(msg));
          }
        },
        fail: (err) => reject(new Error(err.errMsg || err.message || '网络异常，请检查网络后重试'))
      });
    });
  },
  analyzeDamage: (data) => api.post('/api/v1/damage/analyze', data),
  getDamageDailyQuota: () => api.get('/api/v1/damage/daily-quota'),
  getDamageReports: (params) => api.get('/api/v1/damage/reports', params),
  getDamageReport: (id) => api.get('/api/v1/damage/report/' + id),
  createBidding: (data) => api.post('/api/v1/bidding/create', data),
  authLogin: (code) => api.post('/api/v1/auth/login', { code }),
  authPhoneByCode: (code) => api.post('/api/v1/auth/phone', { code }),
  authPhoneBySms: (phone, smsCode) => api.post('/api/v1/auth/phone/verify-sms', { phone, sms_code: smsCode }),
  updateUserProfile: (data) => api.put('/api/v1/user/profile', data),
  getUserProfile: () => api.get('/api/v1/user/profile'),
  getUserTrustLevel: () => api.get('/api/v1/user/trust-level'),
  getUserLevelDetail: () => api.get('/api/v1/user/level-detail'),
  getUserVehicles: () => api.get('/api/v1/user/vehicles'),
  addUserVehicle: (data) => api.post('/api/v1/user/vehicles', data),
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
  cancelOrder: (id, reason) => api.post('/api/v1/user/orders/' + id + '/cancel', { reason: reason || '' }),
  escalateCancelRequest: (orderId, requestId) => api.post('/api/v1/user/orders/' + orderId + '/cancel-request/' + requestId + '/escalate'),
  confirmOrder: (id) => api.post('/api/v1/user/orders/' + id + '/confirm'),
  approveRepairPlan: (id, approved) => api.post('/api/v1/user/orders/' + id + '/repair-plan/approve', { approved }),
  getOrderForReview: (id) => api.get('/api/v1/user/orders/' + id + '/for-review'),
  getOrderFirstReview: (id) => api.get('/api/v1/user/orders/' + id + '/first-review'),
  submitReview: (data) => api.post('/api/v1/reviews', data),
  analyzeReview: (data) => api.post('/api/v1/reviews/analyze', data),
  getReviewDetail: (id) => api.get('/api/v1/reviews/' + id),
  /** 评价聚合流（全平台评价，sort: quality|time|distance） */
  getReviewFeed: (params) => api.get('/api/v1/reviews/feed', params),
  /** 记录评价聚合页浏览（新鲜度） */
  recordReviewViewed: (reviewId) => api.post('/api/v1/reviews/' + reviewId + '/viewed'),
  /** 上报有效阅读会话（点赞追加奖金） */
  reportReviewReading: (reviewId, data) => api.post('/api/v1/reviews/' + reviewId + '/reading', data),
  /** 点赞评价 */
  likeReview: (reviewId) => api.post('/api/v1/reviews/' + reviewId + '/like'),
  /** 踩评价 */
  dislikeReview: (reviewId) => api.post('/api/v1/reviews/' + reviewId + '/dislike'),
  submitFollowup: (id, data) => api.post('/api/v1/reviews/' + id + '/followup', data),
  submitReturnReview: (data) => api.post('/api/v1/reviews/return', data),
  getUserBalance: (params) => api.get('/api/v1/user/balance', params),
  withdraw: (data) => api.post('/api/v1/user/withdraw', data),
  withdrawReconcile: (data) => api.post('/api/v1/user/withdraw/reconcile', data || {}),
  withdrawCancelPending: (data) => api.post('/api/v1/user/withdraw/cancel-pending', data || {}),
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
  updateOrderStatus: (id, data) => merchantRequest({ url: '/api/v1/merchant/orders/' + id + '/status', method: 'PUT', data }),
  updateRepairPlan: (id, data) => merchantRequest({ url: '/api/v1/merchant/orders/' + id + '/repair-plan', method: 'PUT', data }),
  respondCancelRequest: (orderId, requestId, approve) => merchantRequest({ url: '/api/v1/merchant/orders/' + orderId + '/cancel-request/' + requestId + '/respond', method: 'POST', data: { approve } }),
  getMerchantProducts: () => merchantRequest({ url: '/api/v1/merchant/products', method: 'GET' }),
  createMerchantProduct: (data) => merchantRequest({ url: '/api/v1/merchant/products', method: 'POST', data }),
  updateMerchantProduct: (productId, data) => merchantRequest({ url: '/api/v1/merchant/products/' + productId, method: 'PUT', data }),
  offShelfMerchantProduct: (productId) => merchantRequest({ url: '/api/v1/merchant/products/' + productId + '/off-shelf', method: 'POST' }),
  getMerchantShop: () => merchantRequest({ url: '/api/v1/merchant/shop', method: 'GET' }),
  updateMerchantShop: (data) => merchantRequest({ url: '/api/v1/merchant/shop', method: 'PUT', data }),
  withdrawMerchantQualification: () => merchantRequest({ url: '/api/v1/merchant/shop/withdraw-qualification', method: 'POST' }),
  /** 职业证书 AI 识别 */
  merchantAnalyzeTechnicianCert: (imgUrl) => merchantRequest({ url: '/api/v1/merchant/technician-cert/analyze', method: 'POST', data: { img_url: imgUrl } }),
  /** 维修资质证明 AI 识别（营业执照未识别到时使用） */
  merchantAnalyzeQualificationCert: (imgUrl) => merchantRequest({ url: '/api/v1/merchant/qualification-cert/analyze', method: 'POST', data: { img_url: imgUrl } }),
  /** 商户申诉：待申诉列表 */
  getMerchantAppeals: (params) => merchantRequest({ url: '/api/v1/merchant/appeals', method: 'GET', data: params }),
  /** 商户申诉：提交申诉材料 */
  submitMerchantAppeal: (requestId, data) => merchantRequest({ url: '/api/v1/merchant/appeals/' + requestId + '/submit', method: 'POST', data }),
  /** 服务商消息 */
  getMerchantMessages: (params) => merchantRequest({ url: '/api/v1/merchant/messages', method: 'GET', data: params }),
  markMerchantMessagesRead: (data) => merchantRequest({ url: '/api/v1/merchant/messages/read', method: 'POST', data }),
  getMerchantUnreadCount: () => merchantRequest({ url: '/api/v1/merchant/messages/unread-count', method: 'GET' }),
  /** 绑定 openid（用于订阅消息推送，服务商进入工作台时调用） */
  merchantBindOpenid: (code) => merchantRequest({ url: '/api/v1/merchant/bind-openid', method: 'POST', data: { code } }),
  /** 佣金钱包 */
  getMerchantCommissionWallet: () => merchantRequest({ url: '/api/v1/merchant/commission/wallet', method: 'GET' }),
  putMerchantCommissionDeductMode: (mode) =>
    merchantRequest({ url: '/api/v1/merchant/commission/deduct-mode', method: 'PUT', data: { mode } }),
  getMerchantCommissionLedger: (params) =>
    merchantRequest({ url: '/api/v1/merchant/commission/ledger', method: 'GET', data: params }),
  merchantCommissionRechargePrepay: (amount, code) =>
    merchantRequest({ url: '/api/v1/merchant/commission/recharge-prepay', method: 'POST', data: { amount, code } }),
  merchantCommissionPayOrderPrepay: (order_id, code) =>
    merchantRequest({ url: '/api/v1/merchant/commission/pay-order-prepay', method: 'POST', data: { order_id, code } }),
  merchantCommissionFinalize: (orderId, data) =>
    merchantRequest({ url: '/api/v1/merchant/orders/' + orderId + '/commission-finalize', method: 'POST', data }),
  merchantCommissionRefund: (amount) =>
    merchantRequest({ url: '/api/v1/merchant/commission/refund', method: 'POST', data: { amount } })
};
