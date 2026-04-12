/**
 * 选取本地图片：优先 chooseMedia，失败时回退 chooseImage。
 * 部分基础库/机型上 chooseMedia 会报内部错误（如 indexOf is not a function），回退可避免。
 */
const { getLogger } = require('./logger');

const logger = getLogger('pickImage');

function isUserCancel(err) {
  const msg = (err && err.errMsg) || '';
  return typeof msg === 'string' && msg.indexOf('cancel') !== -1;
}

function pathsFromChooseMediaResult(res) {
  const files = res && res.tempFiles ? res.tempFiles : [];
  return files.map((f) => f && f.tempFilePath).filter(Boolean);
}

function chooseImagePaths(count) {
  const c = Math.max(1, Math.min(count, 9));
  return new Promise((resolve, reject) => {
    wx.chooseImage({
      count: c,
      sizeType: ['compressed', 'original'],
      sourceType: ['album', 'camera'],
      success: (r) => resolve(r.tempFilePaths || []),
      fail: (err) => {
        if (isUserCancel(err)) resolve([]);
        else reject(err);
      }
    });
  });
}

/**
 * @param {number} count 最多张数，1～9
 * @returns {Promise<string[]>} 临时文件路径；用户取消返回 []
 */
function pickImagePaths(count) {
  const c = Math.max(1, Math.min(count, 9));
  return new Promise((resolve, reject) => {
    if (!wx.chooseMedia) {
      chooseImagePaths(c).then(resolve).catch(reject);
      return;
    }
    wx.chooseMedia({
      count: c,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed', 'original'],
      success: (r) => {
        const paths = pathsFromChooseMediaResult(r);
        if (paths.length) {
          resolve(paths);
          return;
        }
        chooseImagePaths(c).then(resolve).catch(reject);
      },
      fail: (err) => {
        if (isUserCancel(err)) {
          resolve([]);
          return;
        }
        logger.warn('chooseMedia 失败，回退 chooseImage', err);
        chooseImagePaths(c).then(resolve).catch(reject);
      }
    });
  });
}

module.exports = { pickImagePaths };
