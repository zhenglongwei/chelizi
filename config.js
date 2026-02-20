/**
 * 小程序配置
 * 与 web/.env 中的服务器配置对应，小程序和网页后台共用同一阿里云 api-server
 * 
 * 微信合法域名要求 HTTPS，BASE_URL 需与微信后台配置的 request 合法域名一致
 */

module.exports = {
  BASE_URL: 'https://simplewin.cn'
};
