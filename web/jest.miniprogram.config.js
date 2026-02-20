/** Jest 配置：仅用于小程序 E2E 测试 */
module.exports = {
  testMatch: ['**/e2e/miniprogram.spec.js'],
  testTimeout: 90000,
  verbose: true,
};
