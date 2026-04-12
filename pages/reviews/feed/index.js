// 已合并入口：请使用底部 Tab「口碑」→ 子标签「评价」。保留本页兼容旧路径与分享。
Page({
  onLoad() {
    try {
      const app = getApp();
      if (app && app.globalData) app.globalData.reputationSubTab = 'reviews';
    } catch (_) {}
    wx.switchTab({ url: '/pages/reputation/index' });
  }
});
