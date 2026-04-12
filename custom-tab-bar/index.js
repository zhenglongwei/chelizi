// 自定义 TabBar - 定损按钮核心入口突出 + 动态效果
// 左二 / 中凸 / 右二：首页、口碑 | AI分析 | 消息、我的
Component({
  data: {
    selected: 0,
    unreadCount: 0,
    leftList: [
      { pagePath: 'pages/index/index', text: '首页', iconPath: 'home', selectedIconPath: 'home_active', tabIndex: 0 },
      { pagePath: 'pages/reputation/index', text: '口碑', iconPath: 'merchant', selectedIconPath: 'merchant_active', tabIndex: 1 }
    ],
    centerItem: {
      pagePath: 'pages/damage/upload/index',
      text: 'AI分析',
      iconPath: 'camera_tab',
      selectedIconPath: 'camera_tab_active',
      tabIndex: 2
    },
    rightList: [
      { pagePath: 'pages/message/index', text: '消息', iconPath: 'message', selectedIconPath: 'message_active', tabIndex: 3 },
      { pagePath: 'pages/user/index/index', text: '我的', iconPath: 'person', selectedIconPath: 'person_active', tabIndex: 4 }
    ]
  },

  methods: {
    switchTab(e) {
      const index = Number(e.currentTarget.dataset.index);
      let item = null;
      if (index === 0 || index === 1) {
        item = this.data.leftList[index];
      } else if (index === 2) {
        item = this.data.centerItem;
      } else if (index === 3) {
        item = this.data.rightList[0];
      } else if (index === 4) {
        item = this.data.rightList[1];
      }
      if (item && item.pagePath) {
        wx.switchTab({ url: '/' + item.pagePath });
        this.setData({ selected: index });
      }
    }
  }
});
