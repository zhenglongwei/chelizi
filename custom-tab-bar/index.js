// 自定义 TabBar - 定损按钮核心入口突出 + 动态效果
Component({
  data: {
    selected: 0,
    unreadCount: 0,
    list: [
      { pagePath: 'pages/index/index', text: '首页', iconPath: 'home', selectedIconPath: 'home_active' },
      { pagePath: 'pages/reputation/index', text: '口碑', iconPath: 'merchant', selectedIconPath: 'merchant_active' },
      { pagePath: 'pages/damage/upload/index', text: 'AI分析', iconPath: 'camera_tab', selectedIconPath: 'camera_tab_active', isCenter: true },
      { pagePath: 'pages/user/index/index', text: '我的', iconPath: 'person', selectedIconPath: 'person_active' }
    ]
  },

  methods: {
    switchTab(e) {
      const index = e.currentTarget.dataset.index;
      const item = this.data.list[index];
      if (item) {
        wx.switchTab({ url: '/' + item.pagePath });
        this.setData({ selected: index });
      }
    }
  }
});
