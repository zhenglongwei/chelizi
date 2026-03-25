/**
 * 本地开发：复制本文件为 config.local.js（已加入 .gitignore），仅改 BASE_URL。
 * 小程序将请求该地址的 API，需与 web/api-server 监听地址一致。
 *
 * 微信开发者工具：设置 → 项目设置 → 本地设置 → 勾选「不校验合法域名…」
 * 真机预览：请改为本机局域网 IP，如 http://192.168.1.8:3000
 */
module.exports = {
  BASE_URL: 'http://127.0.0.1:3000',
};
