// app.js - 车厘子小程序入口
const { getLogger } = require('./utils/logger');
const { setToken } = require('./utils/api');

const logger = getLogger('App');

App({
  globalData: {
    // 注意：根据规范，禁止在此处存储用户信息
    // 用户信息、位置等统一存储在 storage，仅保留系统级数据
    systemInfo: null
  },

  onLaunch(options) {
    logger.info('小程序启动', options);
    this.initSystemInfo();
    this.checkUpdate();
  },

  onShow(options) {
    logger.debug('小程序显示', options);
  },

  onHide() {
    logger.debug('小程序隐藏');
  },

  onError(error) {
    logger.error('小程序错误', error);
  },

  onPageNotFound(options) {
    logger.warn('页面不存在', options);
    wx.redirectTo({
      url: '/pages/index/index'
    });
  },

  // 初始化系统信息
  initSystemInfo() {
    try {
      const systemInfo = wx.getSystemInfoSync();
      this.globalData.systemInfo = systemInfo;
      logger.info('系统信息', {
        brand: systemInfo.brand,
        model: systemInfo.model,
        system: systemInfo.system,
        SDKVersion: systemInfo.SDKVersion
      });
    } catch (error) {
      logger.error('获取系统信息失败', error);
    }
  },

  // 检查小程序更新
  checkUpdate() {
    if (!wx.canIUse('getUpdateManager')) {
      logger.warn('当前版本不支持自动更新检查');
      return;
    }

    const updateManager = wx.getUpdateManager();

    updateManager.onCheckForUpdate((res) => {
      logger.info('检查更新结果', res);
    });

    updateManager.onUpdateReady(() => {
      wx.showModal({
        title: '更新提示',
        content: '新版本已准备好，是否重启应用？',
        success: (res) => {
          if (res.confirm) {
            updateManager.applyUpdate();
          }
        }
      });
    });

    updateManager.onUpdateFailed(() => {
      logger.error('新版本下载失败');
    });
  },

  // 从缓存读取用户选择的位置（统一缓存 key: user_chosen_location）
  getCachedLocation() {
    try {
      const cached = wx.getStorageSync('user_chosen_location');
      if (cached && cached.latitude != null && cached.longitude != null) {
        return {
          latitude: cached.latitude,
          longitude: cached.longitude,
          address: cached.address,
          name: cached.name
        };
      }
    } catch (_) {}
    return null;
  },

  // 打开地图选择位置（不依赖 getLocation 授权），选择后写入 storage 并返回
  chooseLocation() {
    return new Promise((resolve, reject) => {
      wx.chooseLocation({
        success: (res) => {
          const location = {
            latitude: res.latitude,
            longitude: res.longitude,
            address: res.address,
            name: res.name
          };
          try {
            wx.setStorageSync('user_chosen_location', location);
          } catch (_) {}
          logger.info('[App-位置] 选择成功', { lat: location.latitude, lng: location.longitude, name: location.name });
          resolve(location);
        },
        fail: (err) => {
          logger.error('选择位置失败', err);
          reject(err);
        }
      });
    });
  }
});
