// components/custom-nav-bar/index.js
// 自定义导航栏：解决系统导航栏标题过近/被遮挡问题，确保标题垂直居中
Component({
  options: {
    multipleSlots: true
  },
  properties: {
    title: { type: String, value: '' },
    showBack: { type: Boolean, value: false },
    showRight: { type: Boolean, value: false },
    backgroundColor: { type: String, value: '#ffffff' },
    textColor: { type: String, value: 'black' }
  },
  methods: {
    onBack() {
      // 从 Tab 页 redirectTo 子包页后栈深可能为 1，navigateBack 无效，需兜底
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      if (pages.length > 1) {
        wx.navigateBack({
          delta: 1,
          fail: () => {
            wx.switchTab({ url: '/pages/index/index' });
          }
        });
      } else {
        wx.switchTab({ url: '/pages/index/index' });
      }
    }
  },
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    navContentHeight: 44
  },
  attached() {
    const { getSystemInfo } = require('../../utils/util');
    const sys = getSystemInfo();
    const menu = wx.getMenuButtonBoundingClientRect();
    const statusBarHeight = sys.statusBarHeight || 20;
    const navContentHeight = (menu.top - statusBarHeight) * 2 + menu.height;
    const navBarHeight = statusBarHeight + navContentHeight;
    this.setData({
      statusBarHeight,
      navBarHeight,
      navContentHeight
    });
  }
});
