/**
 * API 请求封装
 * 所有请求必须通过本模块
 * 与 web 后台共用同一 api-server（阿里云）
 */

const config = require('../config.js');
const BASE_URL = config.BASE_URL;

/** 微信拦截未在合法域名中的请求时，附带可操作的说明 */
function attachWechatDomainHint(err) {
  if (!err || typeof err !== 'object') return err;
  const msg = String(err.errMsg || '');
  if (!msg.includes('domain list') && !msg.includes('合法域名')) return err;
  err.domainBlocked = true;
  const isLocal =
    /localhost|127\.0\.0\.1/i.test(BASE_URL) || /^http:\/\//i.test(BASE_URL);
  err.userHint = isLocal
    ? '本地 API：工具「详情→本地设置」勾选不校验合法域名；真机请用已备案 HTTPS 域名'
    : '请在公众平台配置 request 合法域名';
  return err;
}

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
  const { url, method = 'GET', data, header = {}, timeout } = options;
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...header
  };
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  return requestWithHeaders({ url, method, data, headers, timeout }).catch((err) => {
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
  const { url, method = 'GET', data, header = {}, timeout } = options;
  const token = getMerchantToken();
  const headers = { 'Content-Type': 'application/json', ...header };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return requestWithHeaders({ url, method, data, headers, timeout }).catch((err) => {
    if (err && err.statusCode === 401) {
      handleMerchantUnauthorized();
    }
    throw err;
  });
}

function requestWithHeaders(options) {
  const { url, method = 'GET', data, headers = {}, timeout } = options;
  return new Promise((resolve, reject) => {
    const wxOpts = {
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
      fail: (err) => reject(attachWechatDomainHint(err))
    };
    if (timeout != null && timeout > 0) wxOpts.timeout = timeout;
    wx.request(wxOpts);
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
  /** 车主商品直购 */
  createUserProductOrder: (data) => api.post('/api/v1/user/product-orders', data),
  getUserProductOrders: (params) => api.get('/api/v1/user/product-orders', params),
  /** 已支付标品单详情（预约展示）；未支付返回 404 */
  getUserProductOrder: (id) => api.get('/api/v1/user/product-orders/' + id),
  getShopBookingOptions: (shopId) => api.get('/api/v1/user/shops/' + shopId + '/booking-options'),
  /** 全平台可预约项（不限店），供「我的」预约入口 */
  getUserBookingOptionsAll: () => api.get('/api/v1/user/booking-options'),
  getUserBookingSummary: () => api.get('/api/v1/user/booking-summary'),
  prepayUserProductOrder: (productOrderId, code) =>
    api.post('/api/v1/user/product-orders/' + productOrderId + '/prepay', { code }),
  /** 竞价自费单：维修款 JSAPI 预支付 */
  prepayUserRepairOrder: (orderId, code) =>
    api.post('/api/v1/user/orders/' + orderId + '/repair-prepay', { code }),
  /** 车主端图片上传（需 token） */
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

    const token = getToken();
    return new Promise((resolve, reject) => {
      wx.uploadFile({
        url: BASE_URL + (BASE_URL.endsWith('/') ? '' : '/') + 'api/v1/upload/image',
        filePath: toUpload,
        name: 'image',
        header: token ? { Authorization: 'Bearer ' + token } : {},
        timeout: 120000,
        success: (res) => {
          let body = {};
          try {
            body = JSON.parse(res.data || '{}');
          } catch (_) {}
          if (res.statusCode >= 200 && res.statusCode < 300 && body.code === 200 && body.data && body.data.url) {
            resolve(body.data.url);
          } else {
            const hint413 = res.statusCode === 413 ? '（请求体过大，请缩小图片或调高网关 client_max_body_size）' : '';
            const rawPreview =
              typeof res.data === 'string' && res.data.length > 0 && body.code == null
                ? ' ' + res.data.slice(0, 80).replace(/\s+/g, ' ')
                : '';
            const msg =
              body.message ||
              (res.statusCode === 401
                ? '请先登录'
                : res.statusCode === 503
                  ? '图片上传功能暂不可用'
                  : res.statusCode >= 400
                    ? `上传失败（HTTP ${res.statusCode}）`
                    : '上传失败');
            reject(new Error(String(msg) + hint413 + rawPreview));
          }
        },
        fail: (err) => {
          attachWechatDomainHint(err);
          const extra = err && err.userHint ? ' ' + err.userHint : '';
          reject(new Error((err.errMsg || err.message || '网络异常，请检查网络后重试') + extra));
        }
      });
    });
  },

  /** 服务商端图片上传（需 merchant_token） */
  uploadMerchantImage: (filePath) => {
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

    return (async () => {
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
          timeout: 120000,
          success: (res) => {
            let body = {};
            try {
              body = JSON.parse(res.data || '{}');
            } catch (_) {}
            if (res.statusCode >= 200 && res.statusCode < 300 && body.code === 200 && body.data && body.data.url) {
              resolve(body.data.url);
            } else {
              const hint413 = res.statusCode === 413 ? '（请求体过大，请缩小图片或调高网关 client_max_body_size）' : '';
              const rawPreview =
                typeof res.data === 'string' && res.data.length > 0 && body.code == null
                  ? ' ' + res.data.slice(0, 80).replace(/\s+/g, ' ')
                  : '';
              const msg =
                body.message ||
                (res.statusCode === 401
                  ? '请先登录服务商端'
                  : res.statusCode === 503
                    ? '图片上传功能暂不可用'
                    : res.statusCode >= 400
                      ? `上传失败（HTTP ${res.statusCode}）`
                      : '上传失败');
              reject(new Error(String(msg) + hint413 + rawPreview));
            }
          },
          fail: (err) => {
            attachWechatDomainHint(err);
            const extra = err && err.userHint ? ' ' + err.userHint : '';
            reject(new Error((err.errMsg || err.message || '网络异常，请检查网络后重试') + extra));
          }
        });
      });
    })();
  },
  /** 定损 AI 走服务端再调 DashScope，大图/新模型易超 60s，单独放宽小程序等待 */
  analyzeDamage: (data) => request({ url: '/api/v1/damage/analyze', method: 'POST', data, timeout: 180000 }),
  /** 跳过等待：创建定损报告并异步分析（后台完成后才会分发竞价） */
  createDamageReport: (data) => api.post('/api/v1/damage/reports/create', data),
  getDamageDailyQuota: () => api.get('/api/v1/damage/daily-quota'),
  getDamageReports: (params) => api.get('/api/v1/damage/reports', params),
  getDamageReport: (id) => api.get('/api/v1/damage/report/' + id),
  /** 当前用户能力开关（Phase1：全局 settings） */
  getCapabilities: () => api.get('/api/v1/capabilities'),
  /** 生成报告分享 token（本人） */
  createDamageReportShareToken: (reportId, expiresInSec) =>
    api.post('/api/v1/damage/report/' + reportId + '/share-token', expiresInSec ? { expires_in_sec: expiresInSec } : {}),
  /** 公共：通过 token 获取分享摘要（无需登录） */
  getSharedDamageReport: (token) => api.get('/api/v1/public/damage/report/share/' + encodeURIComponent(token)),
  /** Lead：外部引流 token 获取报告摘要（无需登录） */
  getLeadDamageReport: (token) => api.get('/api/v1/public/lead/damage/report/' + encodeURIComponent(token)),
  /** Lead：登录后认领 token（首次使用）并将报告归属到本人 */
  claimDamageReportByToken: (token) => api.post('/api/v1/damage/report/claim-by-token', { token }),
  createBidding: (data) => api.post('/api/v1/bidding/create', data),
  authLogin: (code) => api.post('/api/v1/auth/login', { code }),
  authPhoneByCode: (code) => api.post('/api/v1/auth/phone', { code }),
  authPhoneBySms: (phone, smsCode) => api.post('/api/v1/auth/phone/verify-sms', { phone, sms_code: smsCode }),
  updateUserProfile: (data) => api.put('/api/v1/user/profile', data),
  getUserProfile: () => api.get('/api/v1/user/profile'),
  /** 绑定一级推荐人（仅首次、成功后标记分销买家；需登录） */
  bindReferrer: (referrer_user_id) => api.post('/api/v1/user/referral/bind', { referrer_user_id }),
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
  markUserOrderArrived: (id) => api.post('/api/v1/user/orders/' + id + '/arrived'),
  claimMerchantNotHandled: (id, data) => api.post('/api/v1/user/orders/' + id + '/merchant-not-handled', data || {}),
  forceCloseOrder: (id, data) => api.post('/api/v1/user/orders/' + id + '/force-close', data || {}),
  submitUserOfflineFeeProof: (id, data) => api.post('/api/v1/user/orders/' + id + '/offline-fee-proof', data),
  /** 历史接口：小程序已下线质保卡页，保留以防旧版或其它端调用 */
  getUserOrderWarrantyCard: (id) => api.get('/api/v1/user/orders/' + id + '/warranty-card'),
  /** 历史公开核验接口 */
  verifyWarrantyCard: (data) => api.post('/api/v1/public/warranty-card/verify', data),
  getRewardPreview: (id) => api.get('/api/v1/user/orders/' + id + '/reward-preview'),
  cancelOrder: (id) => api.post('/api/v1/user/orders/' + id + '/cancel', {}),
  confirmOrder: (id) => api.post('/api/v1/user/orders/' + id + '/confirm'),
  approveRepairPlan: (id, approved) => api.post('/api/v1/user/orders/' + id + '/repair-plan/approve', { approved }),
  /** 车主确认/拒绝最终报价（双阶段报价锁价） */
  confirmFinalQuote: (id, approved) => api.post('/api/v1/user/orders/' + id + '/final-quote/confirm', { approved }),
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
  /** 列表行曝光（日去重），表未迁移时接口仍 200 且 recorded:false */
  reportReviewListImpression: (reviewId) => api.post('/api/v1/reviews/' + reviewId + '/impression', {}),
  /** 点赞评价 */
  likeReview: (reviewId) => api.post('/api/v1/reviews/' + reviewId + '/like'),
  /** 踩评价（已废止，服务端返回错误；保留仅防旧代码调用） */
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
  /** 服务商微信快捷登录（需 merchant_users 已绑定当前小程序 openid） */
  merchantWechatLogin: (data) => api.post('/api/v1/merchant/wechat-login', data),
  /** 检测当前微信是否已绑定服务商（不发 token） */
  merchantCheckOpenid: (data) => api.post('/api/v1/merchant/check-openid', data),
  /** 找回密码：手机号 + 新密码 + wx.login 的 code，服务端校验 openid 与账号一致 */
  merchantResetPassword: (data) => api.post('/api/v1/merchant/reset-password', data),
  merchantRegister: (data) => api.post('/api/v1/merchant/register', data),
  ocrBusinessLicense: (imgUrl) => api.post('/api/v1/merchant/ocr-license', { img_url: imgUrl }),
  // 服务商端接口（需 merchant_token）
  getMerchantDashboard: () => merchantRequest({ url: '/api/v1/merchant/dashboard', method: 'GET' }),
  getMerchantBiddings: (params) => merchantRequest({ url: '/api/v1/merchant/biddings', method: 'GET', data: params }),
  getMerchantBidding: (id) => merchantRequest({ url: '/api/v1/merchant/bidding/' + id, method: 'GET' }),
  submitQuote: (data) => merchantRequest({ url: '/api/v1/merchant/quote', method: 'POST', data }),
  /** 标准报价 CSV 模板说明与示例（JSON，兼容旧逻辑） */
  getMerchantQuoteTemplate: () => merchantRequest({ url: '/api/v1/merchant/quote-template', method: 'GET' }),
  /** 标准报价 Excel 模板完整下载 URL（GET，需 Header Authorization，返回 xlsx 二进制） */
  getMerchantQuoteTemplateXlsxUrl: () => {
    const base = String(BASE_URL || '').replace(/\/$/, '');
    return `${base}/api/v1/merchant/quote-template.xlsx`;
  },
  /** 解析 CSV 文本 → items 预览 */
  previewMerchantQuoteImport: (csvText, opts) =>
    merchantRequest({
      url: '/api/v1/merchant/quote-import/preview',
      method: 'POST',
      data: {
        csv_text: csvText,
        ai_enrich: !opts || opts.ai_enrich !== false,
      },
    }),
  /** 上传本地 .xlsx（微信聊天文件）解析报价明细，返回结构与 CSV 预览一致 */
  previewMerchantQuoteImportXlsx: (filePath, opts) =>
    new Promise((resolve, reject) => {
      const token = getMerchantToken();
      if (!token) {
        reject(new Error('请先登录'));
        return;
      }
      const base = String(BASE_URL || '').replace(/\/$/, '');
      wx.uploadFile({
        url: `${base}/api/v1/merchant/quote-import/preview-xlsx`,
        filePath,
        name: 'file',
        header: { Authorization: 'Bearer ' + token },
        formData: {
          ai_enrich: !opts || opts.ai_enrich !== false ? '1' : '0',
        },
        success: (res) => {
          const sc = res.statusCode;
          if (sc === 401) {
            handleMerchantUnauthorized();
            reject(new Error('登录已失效'));
            return;
          }
          let body;
          try {
            body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
          } catch (_) {
            reject(new Error('服务器响应无效'));
            return;
          }
          if (sc < 200 || sc >= 300) {
            reject(new Error((body && body.message) || '上传失败'));
            return;
          }
          if (body.code !== undefined && body.code !== 200) {
            reject(new Error(body.message || '解析失败'));
            return;
          }
          resolve(body.data !== undefined ? body.data : body);
        },
        fail: (err) => reject(attachWechatDomainHint(err)),
      });
    }),
  /** 报价单拍照 AI 识别 */
  analyzeMerchantQuoteSheetImage: (imageUrl) =>
    merchantRequest({ url: '/api/v1/merchant/quote-sheet/analyze-image', method: 'POST', data: { image_url: imageUrl } }),
  getMerchantOrders: (params) => merchantRequest({ url: '/api/v1/merchant/orders', method: 'GET', data: params }),
  getMerchantOrder: (id) => merchantRequest({ url: '/api/v1/merchant/orders/' + id, method: 'GET' }),
  /** 历史接口：商户端已下线质保卡页 */
  getMerchantOrderWarrantyCard: (id) =>
    merchantRequest({ url: '/api/v1/merchant/orders/' + id + '/warranty-card', method: 'GET' }),
  /** 历史接口 */
  getMerchantWarrantyCardTemplates: () =>
    merchantRequest({ url: '/api/v1/merchant/warranty-card/templates', method: 'GET' }),
  acceptOrder: (id) => merchantRequest({ url: '/api/v1/merchant/orders/' + id + '/accept', method: 'POST' }),
  updateOrderStatus: (id, data) => merchantRequest({ url: '/api/v1/merchant/orders/' + id + '/status', method: 'PUT', data }),
  /** 维修中记录关键节点进展（照片+说明），并通知车主 */
  postMerchantRepairMilestone: (id, data) =>
    merchantRequest({ url: '/api/v1/merchant/orders/' + id + '/repair-milestones', method: 'POST', data }),
  updateRepairPlan: (id, data) => merchantRequest({ url: '/api/v1/merchant/orders/' + id + '/repair-plan', method: 'PUT', data }),
  /** 服务商提交到店最终报价 */
  submitMerchantFinalQuote: (id, data) => merchantRequest({ url: '/api/v1/merchant/orders/' + id + '/final-quote', method: 'PUT', data }),
  merchantWaitingPartsExtension: (orderId, data) =>
    merchantRequest({ url: '/api/v1/merchant/orders/' + orderId + '/waiting-parts-extension', method: 'POST', data }),
  setMerchantPromisedDelivery: (orderId, data) =>
    merchantRequest({ url: '/api/v1/merchant/orders/' + orderId + '/promised-delivery', method: 'PUT', data }),
  getMerchantProducts: () => merchantRequest({ url: '/api/v1/merchant/products', method: 'GET' }),
  createMerchantProduct: (data) => merchantRequest({ url: '/api/v1/merchant/products', method: 'POST', data }),
  updateMerchantProduct: (productId, data) => merchantRequest({ url: '/api/v1/merchant/products/' + productId, method: 'PUT', data }),
  offShelfMerchantProduct: (productId) => merchantRequest({ url: '/api/v1/merchant/products/' + productId + '/off-shelf', method: 'POST' }),
  deleteMerchantProductPending: (productId) =>
    merchantRequest({ url: '/api/v1/merchant/products/' + productId, method: 'DELETE' }),
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
    merchantRequest({ url: '/api/v1/merchant/commission/refund', method: 'POST', data: { amount } }),
  /** 标品货款流水 */
  getMerchantShopIncomeLedger: (params) =>
    merchantRequest({ url: '/api/v1/merchant/shop-income/ledger', method: 'GET', data: params }),
  merchantShopIncomeWithdraw: (data) =>
    merchantRequest({ url: '/api/v1/merchant/shop-income/withdraw', method: 'POST', data }),
  merchantShopIncomeWithdrawReconcile: (data) =>
    merchantRequest({ url: '/api/v1/merchant/shop-income/withdraw/reconcile', method: 'POST', data }),
  merchantShopIncomeWithdrawCancel: (data) =>
    merchantRequest({ url: '/api/v1/merchant/shop-income/withdraw/cancel', method: 'POST', data }),
  merchantShopIncomeCorpWithdraw: (data) =>
    merchantRequest({ url: '/api/v1/merchant/shop-income/corp-withdraw', method: 'POST', data }),
  getMerchantShopIncomeCorpWithdrawals: (params) =>
    merchantRequest({ url: '/api/v1/merchant/shop-income/corp-withdrawals', method: 'GET', data: params }),
  merchantShopIncomeCorpWithdrawCancel: (data) =>
    merchantRequest({ url: '/api/v1/merchant/shop-income/corp-withdraw/cancel', method: 'POST', data }),
  /** 服务商：车主商品订单 */
  getMerchantProductOrders: (params) =>
    merchantRequest({ url: '/api/v1/merchant/product-orders', method: 'GET', data: params })
};
