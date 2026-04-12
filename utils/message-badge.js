/**
 * 车主端消息未读数：同步到自定义 TabBar「消息」角标
 * 需在已挂载 TabBar 的页面调用 getTabBar；冷启动时可用 schedule 延迟重试
 */
const { getToken, getUnreadCount } = require('./api');

/**
 * @param {number} count
 * @returns {boolean} 是否已成功写入 TabBar
 */
function applyUnreadToTabBar(count) {
  const pages = getCurrentPages();
  for (let i = pages.length - 1; i >= 0; i--) {
    const page = pages[i];
    if (page && typeof page.getTabBar === 'function') {
      const tabBar = page.getTabBar();
      if (tabBar && typeof tabBar.setData === 'function') {
        tabBar.setData({ unreadCount: count });
        return true;
      }
    }
  }
  return false;
}

/**
 * 拉取未读数并更新 TabBar；未登录时角标清零
 * @returns {Promise<number>} 未读数量
 */
async function fetchAndApplyUnreadBadge() {
  if (!getToken()) {
    applyUnreadToTabBar(0);
    return 0;
  }
  try {
    const res = await getUnreadCount();
    const n = parseInt(res && (res.count ?? res.unread_count ?? res), 10) || 0;
    applyUnreadToTabBar(n);
    return n;
  } catch (_) {
    applyUnreadToTabBar(0);
    return 0;
  }
}

/**
 * 小程序 onShow 等场景：TabBar 可能尚未挂载，延迟再试
 * @param {number[]} delaysMs 默认 [80, 320]
 */
function scheduleFetchUnreadBadge(delaysMs) {
  const delays = delaysMs && delaysMs.length ? delaysMs : [80, 320];
  delays.forEach((ms) => {
    setTimeout(() => fetchAndApplyUnreadBadge(), ms);
  });
}

module.exports = {
  applyUnreadToTabBar,
  fetchAndApplyUnreadBadge,
  scheduleFetchUnreadBadge
};
