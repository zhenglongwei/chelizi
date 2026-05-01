// 自定义 TabBar - 简化为四个入口：首页、口碑、报价、我的
Component({
  data: {
    selected: 0,
    list: [
      { pagePath: 'pages/index/index', text: '首页', iconPath: 'home', selectedIconPath: 'home_active', tabIndex: 0 },
      { pagePath: 'pages/reputation/index', text: '口碑', iconPath: 'merchant', selectedIconPath: 'merchant_active', tabIndex: 1 },
      { pagePath: 'pages/damage/upload/index', text: '报价', iconPath: 'camera_tab', selectedIconPath: 'camera_tab_active', tabIndex: 2 },
      { pagePath: 'pages/user/index/index', text: '我的', iconPath: 'person', selectedIconPath: 'person_active', tabIndex: 3 }
    ]
  },

  methods: {
    switchTab(e) {
      const index = Number(e.currentTarget.dataset.index);
      const item = (this.data.list || []).find((x) => x && x.tabIndex === index) || null;
      if (item && item.pagePath) {
        wx.switchTab({ url: '/' + item.pagePath });
        this.setData({ selected: index });
      }
    }
  }
});
