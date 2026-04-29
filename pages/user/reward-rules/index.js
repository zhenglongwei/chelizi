const { getNavBarHeight, getSystemInfo } = require('../../../utils/util');

Page({
  data: {
    pageRootStyle: '',
  },
  onLoad() {
    const top = getNavBarHeight();
    const sys = getSystemInfo();
    this.setData({
      pageRootStyle: `padding-top: ${top}px; min-height: ${(sys.windowHeight || 600)}px;`,
    });
  },
});
