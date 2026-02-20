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
      wx.navigateBack();
    }
  },
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    navContentHeight: 44
  },
  attached() {
    const sys = wx.getSystemInfoSync();
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
