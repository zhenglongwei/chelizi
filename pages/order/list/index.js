// 已合并到「我的订单」hub；保留路径以兼容旧链接与测试
Page({
  onLoad(options) {
    const status =
      options.status !== undefined && options.status !== null ? String(options.status) : '';
    const qs = ['tab=repair'];
    if (status !== '') qs.push('status=' + encodeURIComponent(status));
    wx.redirectTo({ url: '/pages/order/hub/index?' + qs.join('&') });
  }
});
