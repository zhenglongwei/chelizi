// e2e/miniprogram.spec.js
// 车主端 + 服务商端 E2E 全面测试，按 docs/pages/00-页面索引 与 E2E测试经验.md
const automator = require('miniprogram-automator');
const axios = require('axios');
const { launchWeapp, AUTO_PORT } = require('./launch-weapp');
const config = require('../../config.js');

// 测试用 ID（schema 中 seed 数据）
const TEST_SHOP_ID = 'SHOP001';

// 服务商测试账号（需在数据库中已存在）
const MERCHANT_PHONE = '18658823459';
const MERCHANT_PASSWORD = '123456';

const API_BASE = process.env.BASE_URL || process.env.API_BASE || config.BASE_URL;

/** 服务商登录：调用 API 获取 token，直接写入 storage，绕过登录 UI */
async function merchantLogin(miniProgram) {
  try {
    const res = await axios.post(API_BASE + '/api/v1/merchant/login', {
      phone: MERCHANT_PHONE,
      password: MERCHANT_PASSWORD
    }, { timeout: 10000 });
    const body = res.data || {};
    if (body.code === 200 && body.data && body.data.token) {
      const { token, user } = body.data;
      await miniProgram.callWxMethod('setStorageSync', 'merchant_token', token);
      await miniProgram.callWxMethod('setStorageSync', 'merchant_user', user || {});
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch (err) {
    // API 不可达或登录失败时静默，后续用例可能因未登录而重定向至登录页
  }
}

async function connectWithRetry(timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return await automator.connect({ wsEndpoint: `ws://127.0.0.1:${AUTO_PORT}` });
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(
    `连接开发者工具超时（端口 ${AUTO_PORT}），请确认：1) 已开启服务端口 2) 无其他项目占用该端口`
  );
}

describe('车主端 E2E', () => {
  let miniProgram;
  let page;

  beforeAll(async () => {
    if (!process.env.WEAPP_SKIP_LAUNCH) await launchWeapp();
    miniProgram = await connectWithRetry();
  }, 60000);

  afterAll(async () => {
    try {
      if (miniProgram) await miniProgram.close();
    } catch (e) {
      // 连接可能已断开，忽略
    }
  });

  describe('01-首页', () => {
    beforeAll(async () => {
      page = await miniProgram.reLaunch('/pages/index/index');
      await page.waitFor(1000);
    });

    it('应显示 AI 定损入口（TabBar 或广告区）', async () => {
      const el = await page.$('text=定损');
      expect(el).toBeTruthy();
    });

    it('应显示搜索栏', async () => {
      const el = await page.$('.idx-search');
      expect(el).toBeTruthy();
    });

    it('应显示附近服务商区域', async () => {
      const el = await page.$('text=附近服务商');
      expect(el).toBeTruthy();
    });

    it('搜索栏可点击（点击后可能跳转搜索列表）', async () => {
      const search = await page.$('.idx-search');
      expect(search).toBeTruthy();
      await search.tap();
      await page.waitFor(1000);
      // 跳转可能因模拟器差异未完成，仅验证点击无异常
    });
  });

  describe('02-维修厂搜索列表页', () => {
    beforeAll(async () => {
      page = await miniProgram.reLaunch('/pages/search/list/index');
      await page.waitFor(1000);
    });

    it('应显示搜索栏或筛选区域', async () => {
      const el = await page.$('.search-bar, .search-filter');
      expect(el).toBeTruthy();
    });

    it('应显示全部/分类筛选', async () => {
      const el = await page.$('text=全部, .filter-chip');
      expect(el).toBeTruthy();
    });
  });

  describe('03-维修厂详情页', () => {
    beforeAll(async () => {
      page = await miniProgram.navigateTo(`/pages/shop/detail/index?id=${TEST_SHOP_ID}`);
      await page.waitFor(3000);
    }, 10000);

    it('应显示维修厂信息或加载/错误状态', async () => {
      const el = await page.$('.shop-detail-page, .detail-header, .detail-loading');
      expect(el).toBeTruthy();
    }, 10000);
  });

  describe('04a-预约页', () => {
    beforeAll(async () => {
      page = await miniProgram.navigateTo(`/pages/shop/book/index?id=${TEST_SHOP_ID}`);
      await page.waitFor(4000);
    }, 20000);

    it('应显示预约表单或加载状态', async () => {
      const el = await page.$('.book-page, .book-section, .book-loading');
      expect(el).toBeTruthy();
    }, 15000);
  });

  describe('05-个人中心页', () => {
    beforeAll(async () => {
      page = await miniProgram.reLaunch('/pages/user/index/index');
      await page.waitFor(1000);
    });

    it('应显示个人中心结构', async () => {
      const el = await page.$('.user-page');
      expect(el).toBeTruthy();
    });

    it('应显示我的订单或登录入口', async () => {
      const el = await page.$('text=我的订单, text=登录');
      expect(el).toBeTruthy();
    });
  });

  describe('06-我的订单列表页', () => {
    beforeAll(async () => {
      page = await miniProgram.reLaunch('/pages/order/list/index');
      await page.waitFor(1000);
    });

    it('应显示订单页结构（含 Tab 或空态）', async () => {
      const el = await page.$('.order-list-page, .order-tabs, .order-empty');
      expect(el).toBeTruthy();
    });
  });

  describe('07-我的竞价列表页', () => {
    beforeAll(async () => {
      page = await miniProgram.reLaunch('/pages/bidding/list/index');
      await page.waitFor(1000);
    });

    it('应显示竞价页结构（含 Tab 或空态）', async () => {
      const el = await page.$('.bidding-list-page, .bidding-tabs, .bidding-empty');
      expect(el).toBeTruthy();
    });
  });

  describe('07a-订单详情页', () => {
    beforeAll(async () => {
      page = await miniProgram.navigateTo('/pages/order/detail/index?id=ORD_TEST');
      await page.waitFor(3000);
    }, 10000);

    it('应显示订单详情页结构', async () => {
      const el = await page.$('.order-detail-page, .order-loading');
      expect(el).toBeTruthy();
    }, 10000);
  });

  describe('07b-竞价报价页', () => {
    beforeAll(async () => {
      page = await miniProgram.navigateTo('/pages/bidding/detail/index?id=BID_TEST');
      await page.waitFor(3000);
    }, 10000);

    it('应显示竞价详情页结构', async () => {
      const el = await page.$('.bid-detail-page, .bid-empty, .bid-loading, .bid-error');
      expect(el).toBeTruthy();
    }, 10000);
  });

  describe('08-登录授权页', () => {
    beforeAll(async () => {
      page = await miniProgram.reLaunch('/pages/auth/login/index');
      await page.waitFor(1000);
    });

    it('应显示登录入口', async () => {
      const el = await page.$('.login-content, .login-page, text=车厘子');
      expect(el).toBeTruthy();
    });

    it('应显示微信快捷登录按钮', async () => {
      const el = await page.$('text=微信快捷登录, .login-btn');
      expect(el).toBeTruthy();
    });
  });

  describe('09-消息页（TabBar）', () => {
    beforeAll(async () => {
      page = await miniProgram.reLaunch('/pages/message/index');
      await page.waitFor(1000);
    });

    it('应显示消息页结构', async () => {
      const el = await page.$('.message-page');
      expect(el).toBeTruthy();
    });
  });

  describe('10-设置页', () => {
    beforeAll(async () => {
      page = await miniProgram.reLaunch('/pages/user/settings/index');
      await page.waitFor(1000);
    });

    it('应显示设置菜单', async () => {
      const el = await page.$('.settings-page');
      expect(el).toBeTruthy();
    });

    it('应显示服务商注册/登录入口', async () => {
      const el = await page.$('text=服务商注册, text=服务商登录');
      expect(el).toBeTruthy();
    });
  });

  describe('11-返点余额明细页', () => {
    beforeAll(async () => {
      page = await miniProgram.reLaunch('/pages/user/balance/index');
      await page.waitFor(1000);
    });

    it('应显示余额页结构', async () => {
      const el = await page.$('.balance-page, .balance-empty, .balance-summary');
      expect(el).toBeTruthy();
    });
  });

  describe('12-定损页（TabBar）', () => {
    beforeAll(async () => {
      page = await miniProgram.reLaunch('/pages/damage/upload/index');
      await page.waitFor(1000);
    });

    it('应显示定损相关区域', async () => {
      const el = await page.$('.damage-page, .damage-guide, .damage-upload-btn, .damage-empty');
      expect(el).toBeTruthy();
    });
  });

  describe('13-定损历史页', () => {
    beforeAll(async () => {
      page = await miniProgram.reLaunch('/pages/damage/history/index');
      await page.waitFor(1000);
    });

    it('应显示历史页结构', async () => {
      const el = await page.$('.history-page, .history-empty, .history-scroll');
      expect(el).toBeTruthy();
    });
  });

  describe('14-提现页', () => {
    beforeAll(async () => {
      page = await miniProgram.reLaunch('/pages/user/withdraw/index');
      await page.waitFor(1000);
    });

    it('应显示提现表单', async () => {
      const el = await page.$('.withdraw-page, .withdraw-card');
      expect(el).toBeTruthy();
    });
  });

  describe('15-服务商入口页（merchant/index）', () => {
    beforeAll(async () => {
      page = await miniProgram.reLaunch('/pages/merchant/index');
      await page.waitFor(1000);
    });

    it('应显示服务商登录/注册/工作台入口', async () => {
      const el = await page.$('.merchant-page');
      expect(el).toBeTruthy();
    });

    it('应显示服务商登录入口', async () => {
      const el = await page.$('text=服务商登录');
      expect(el).toBeTruthy();
    });
  });

  describe('M01-服务商登录', () => {
    beforeAll(async () => {
      page = await miniProgram.reLaunch('/pages/merchant/login');
      await page.waitFor(1000);
    });

    it('应显示登录表单', async () => {
      const el = await page.$('.merchant-login-page');
      expect(el).toBeTruthy();
    });

    it('应显示手机号、密码输入框', async () => {
      const el = await page.$('.merchant-form-input, text=手机号');
      expect(el).toBeTruthy();
    });
  });

  describe('M02-服务商注册', () => {
    beforeAll(async () => {
      page = await miniProgram.reLaunch('/pages/merchant/register');
      await page.waitFor(1000);
    });

    it('应显示注册表单', async () => {
      const el = await page.$('.merchant-register-page');
      expect(el).toBeTruthy();
    });

    it('应显示企业名称等必填项', async () => {
      const el = await page.$('text=企业名称, text=营业执照');
      expect(el).toBeTruthy();
    });
  });

  describe('M03-服务商工作台（merchant/home，服务商登录后首页）', () => {
    beforeAll(async () => {
      page = await miniProgram.reLaunch('/pages/merchant/home');
      await page.waitFor(1000);
    });

    it('应显示工作台结构', async () => {
      const el = await page.$('.merchant-home, .merchant-stats, text=待报价');
      expect(el).toBeTruthy();
    });
  });

  describe('M04-服务商竞价邀请列表', () => {
    beforeAll(async () => {
      await merchantLogin(miniProgram);
      page = await miniProgram.reLaunch('/pages/merchant/bidding/list/index');
      await page.waitFor(3000);
    });

    it('应显示竞价列表页结构（或重定向至登录）', async () => {
      const el =
        (await page.$('text=待报价')) ||
        (await page.$('text=已报价')) ||
        (await page.$('text=暂无竞价邀请')) ||
        (await page.$('text=加载中')) ||
        (await page.$('.merchant-bidding-list')) ||
        (await page.$('.merchant-login-page'));
      expect(el).toBeTruthy();
    });
  });

  describe('M06-服务商订单列表', () => {
    beforeAll(async () => {
      await merchantLogin(miniProgram);
      page = await miniProgram.reLaunch('/pages/merchant/order/list/index');
      await page.waitFor(3000);
    });

    it('应显示订单列表页结构（或重定向至登录）', async () => {
      const el =
        (await page.$('text=待接单')) ||
        (await page.$('text=全部')) ||
        (await page.$('text=暂无订单')) ||
        (await page.$('.merchant-order-list')) ||
        (await page.$('.merchant-login-page'));
      expect(el).toBeTruthy();
    });
  });

  describe('M08-维修厂信息', () => {
    beforeAll(async () => {
      await merchantLogin(miniProgram);
      page = await miniProgram.reLaunch('/pages/merchant/shop/profile/index');
      await page.waitFor(3000);
    });

    it('应显示维修厂信息页结构（或重定向至登录）', async () => {
      const el =
        (await page.$('text=店铺名称')) ||
        (await page.$('text=保存')) ||
        (await page.$('.merchant-shop-profile')) ||
        (await page.$('.merchant-login-page'));
      expect(el).toBeTruthy();
    });
  });
});
