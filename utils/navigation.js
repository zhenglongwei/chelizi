/**
 * 页面跳转统一封装
 * 参数必须使用对象形式传递，避免直接拼接 URL
 */

function buildUrl(path, params = {}) {
  const keys = Object.keys(params);
  if (keys.length === 0) return path;
  const qs = keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  return path + (path.includes('?') ? '&' : '?') + qs;
}

const navigation = {
  navigateTo(path, params = {}) {
    wx.navigateTo({ url: buildUrl(path, params) });
  },

  redirectTo(path, params = {}) {
    wx.redirectTo({ url: buildUrl(path, params) });
  },

  navigateBack(delta = 1) {
    wx.navigateBack({ delta });
  },

  switchTab(path, params = {}) {
    wx.switchTab({ url: buildUrl(path, params) });
  },

  reLaunch(path, params = {}) {
    wx.reLaunch({ url: buildUrl(path, params) });
  }
};

module.exports = navigation;
