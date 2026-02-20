/**
 * 通用工具函数（时间、金额格式化等）
 * 不得在各页面中重复实现格式化逻辑
 */

function formatDateTime(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => (n < 10 ? '0' + n : n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDate(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => (n < 10 ? '0' + n : n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatRelativeTime(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  if (diff < 2592000) return Math.floor(diff / 86400) + '天前';
  return formatDate(d);
}

function formatAmount(amount, showUnit = true) {
  const n = parseFloat(amount);
  if (isNaN(n)) return showUnit ? '0.00元' : '0.00';
  const s = n.toFixed(2);
  return showUnit ? s + '元' : s;
}

/**
 * 获取自定义导航栏高度（px）
 * 用于 navigationStyle: custom 时页面内容区的 padding-top
 * 公式：statusBarHeight + (capsuleTop - statusBarHeight) * 2 + capsuleHeight
 */
function getNavBarHeight() {
  try {
    const sys = wx.getSystemInfoSync();
    const menu = wx.getMenuButtonBoundingClientRect();
    const statusBarHeight = sys.statusBarHeight || 20;
    const navContentHeight = (menu.top - statusBarHeight) * 2 + menu.height;
    return statusBarHeight + navContentHeight;
  } catch (e) {
    return 88; // 默认值
  }
}

/**
 * 将图片压缩到指定大小以内（用于上传前）
 * Nginx 默认 client_max_body_size 为 1MB，故默认限制 800KB
 * @param {string} filePath 本地图片路径
 * @param {number} maxBytes 最大字节数，默认 800KB
 * @returns {Promise<string>} 压缩后的临时文件路径
 */
function compressImageForUpload(filePath, maxBytes = 800 * 1024) {
  return new Promise((resolve, reject) => {
    wx.getFileInfo({
      filePath,
      success: (res) => {
        if (res.size <= maxBytes) {
          resolve(filePath);
          return;
        }
        const tryCompress = (quality) => {
          wx.compressImage({
            src: filePath,
            quality,
            success: (cres) => {
              wx.getFileInfo({
                filePath: cres.tempFilePath,
                success: (fres) => {
                  if (fres.size <= maxBytes || quality <= 20) {
                    resolve(cres.tempFilePath);
                  } else {
                    tryCompress(Math.max(20, quality - 20));
                  }
                },
                fail: () => resolve(cres.tempFilePath)
              });
            },
            fail: (err) => reject(err)
          });
        };
        tryCompress(70);
      },
      fail: (err) => reject(err)
    });
  });
}

module.exports = {
  formatDateTime,
  formatDate,
  formatRelativeTime,
  formatAmount,
  getNavBarHeight,
  compressImageForUpload
};
