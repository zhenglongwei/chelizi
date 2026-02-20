/**
 * 后台运维 E2E 测试
 * 按《车厘子-全流程需求梳理》A01-A02 验证
 */
const { test, expect } = require('@playwright/test');

const BASE = (process.env.PLAYWRIGHT_BASE_URL || 'https://simplewin.cn').replace(/\/$/, '');

async function doLogin(page) {
  await page.goto(`${BASE}/admin/login`);
  await page.getByPlaceholder('请输入用户名').waitFor({ state: 'visible', timeout: 10000 });
  await page.getByPlaceholder('请输入用户名').fill('admin');
  await page.getByPlaceholder('请输入密码').fill('admin123');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/admin\/dashboard/, { timeout: 15000 });
}

test.describe('后台登录与工作台', () => {
  test('A01 登录页可访问', async ({ page }) => {
    await page.goto(`${BASE}/admin/login`);
    await expect(page).toHaveURL(/\/admin\/login/);
    await expect(page.getByPlaceholder('请输入用户名')).toBeVisible();
    await expect(page.getByPlaceholder('请输入密码')).toBeVisible();
  });

  test('A01 登录成功并跳转工作台', async ({ page }) => {
    await doLogin(page);
    await expect(page).toHaveURL(/\/admin\/dashboard/);
  });

  test('A02 工作台显示数据概览', async ({ page }) => {
    await doLogin(page);
    await expect(page.locator('text=数据概览').first()).toBeVisible({ timeout: 5000 });
  });

  test('A03 维修厂管理页可访问', async ({ page }) => {
    await doLogin(page);
    await page.goto(`${BASE}/admin/merchants`);
    await expect(page).toHaveURL(/\/admin\/merchants/);
  });

  test('A04 订单管理页可访问', async ({ page }) => {
    await doLogin(page);
    await page.goto(`${BASE}/admin/orders`);
    await expect(page).toHaveURL(/\/admin\/orders/);
  });
});
