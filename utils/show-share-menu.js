/**
 * 自定义导航（navigationStyle: custom）下，需显式开启右上角「转发」能力。
 * 页级 `enableShareAppMessage` 在部分基础库/校验中无效，统一用本工具调用 `wx.showShareMenu`。
 */
function showWechatShareMenu() {
  if (typeof wx.showShareMenu !== 'function') return;
  try {
    wx.showShareMenu({
      withShareTicket: false,
      menus: ['shareAppMessage']
    });
  } catch (_) {
    try {
      wx.showShareMenu({ withShareTicket: false });
    } catch (e) {}
  }
}

module.exports = { showWechatShareMenu };
