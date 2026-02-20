/**
 * 统一用户交互（弹窗、提示、加载）
 * 所有用户交互必须使用本模块
 */

const ui = {
  showLoading(title = '加载中...', mask = true) {
    wx.showLoading({ title, mask });
  },

  hideLoading() {
    wx.hideLoading();
  },

  showSuccess(title = '操作成功', duration = 2000) {
    wx.showToast({ title, icon: 'success', duration });
  },

  showError(title = '操作失败', duration = 2000) {
    wx.showToast({ title, icon: 'none', duration });
  },

  showWarning(title = '温馨提示', duration = 2000) {
    wx.showToast({ title, icon: 'none', duration });
  },

  showConfirm(options) {
    const {
      title = '提示',
      content = '',
      confirmText = '确定',
      cancelText = '取消',
      confirmColor = '#2B579A',
      showCancel = true,
      success
    } = options;
    wx.showModal({
      title,
      content,
      confirmText,
      cancelText,
      confirmColor,
      showCancel,
      success: (res) => {
        if (success) success(res);
      }
    });
  }
};

module.exports = ui;
