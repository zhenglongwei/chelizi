/**
 * Playwright E2E 配置
 * 使用本机 Chrome（channel: 'chrome'），避免 npx playwright install 下载失败 (ECONNRESET)
 * 需本机已安装 Chrome 浏览器
 */
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  baseURL: (process.env.PLAYWRIGHT_BASE_URL || 'https://simplewin.cn').replace(/\/$/, ''),
  timeout: 30000,
  retries: 1,
  projects: [
    {
      name: 'chrome',
      use: {
        channel: 'chrome',
        headless: true,
        screenshot: 'only-on-failure',
      },
    },
  ],
});
