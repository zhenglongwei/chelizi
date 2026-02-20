# E2E 测试经验文档

本文档整理车厘子项目**网页端（后台运维）**与**小程序端**的 E2E 测试经验，供后续开发与排查时备查。

---

## 一、后台运维 E2E（Playwright）

### 1.1 技术栈与配置

| 项目 | 说明 |
|------|------|
| 框架 | Playwright |
| 配置 | `web/playwright.config.js` |
| 用例 | `web/e2e/admin.spec.js` |
| 运行 | `npm run test:e2e` |

### 1.2 前置条件

- 本机已安装 **Chrome**
- 配置使用 `channel: 'chrome'`，**无需**执行 `npx playwright install chromium`
- 国内网络 Chromium 下载易失败，使用本机 Chrome 可避免

### 1.3 运行方式

```bash
cd web
npm run test:e2e
```

指定 baseURL（如测本地）：

```bash
set PLAYWRIGHT_BASE_URL=http://localhost:3001
npm run test:e2e
```

### 1.4 用例说明

| 用例 | 说明 |
|------|------|
| A01 登录页可访问 | 验证 `/admin/login` 可访问，用户名/密码输入框可见 |
| A01 登录成功并跳转工作台 | 登录后跳转 `/admin/dashboard` |
| A02 工作台显示数据概览 | 工作台展示「数据概览」区域 |
| A03 维修厂管理页可访问 | 登录后访问 `/admin/merchants` |
| A04 订单管理页可访问 | 登录后访问 `/admin/orders` |

### 1.5 经验要点

- **登录按钮选择器**：使用 `locator('button[type="submit"]')` 比 `getByRole('button', { name: '登录' })` 更稳定
- **URL 必须完整**：`page.goto(\`${BASE}/admin/login\`)`，避免相对路径导致 invalid URL
- **抽取 doLogin**：多个用例需登录时，抽取 `doLogin(page)` 复用
- **调试**：加 `--headed` 可查看浏览器操作：`npx playwright test --headed`

---

## 二、小程序 E2E（miniprogram-automator）

### 2.1 技术栈与配置

| 项目 | 说明 |
|------|------|
| 框架 | miniprogram-automator + Jest |
| 配置 | `web/jest.miniprogram.config.js` |
| 用例 | `web/e2e/miniprogram.spec.js` |
| 启动辅助 | `web/e2e/launch-weapp.js`（Windows 下 spawn .bat 的绕过） |
| 运行 | `npm run test:miniprogram` |

### 2.2 前置条件

- 已安装**微信开发者工具**
- 在 设置 → 安全设置 中**开启服务端口**（供 CLI 调用）
- 运行前**关闭**已打开的开发者工具窗口（若使用自动 launch）

### 2.3 端口说明（重要）

| 端口类型 | 说明 |
|---------|------|
| **服务端口** | 设置中显示的端口（如 51937），用于 CLI/HTTP 调用 |
| **自动化端口** | `cli auto --auto-port` 指定的 WebSocket 端口，默认 9420 |

**注意**：`connect()` 只能连接**通过 `cli auto` 启动**的自动化端口。手动打开 GUI 并开启服务端口，不会启动自动化 WebSocket。

### 2.4 运行方式

**推荐：手动启动后 connect**

```bash
# 终端 1：手动启动自动化窗口
& "C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat" auto --project "C:\Users\longwei\WeChatProjects\chelizi" --auto-port 9420

# 终端 2：等窗口打开后运行测试（跳过 launch）
cd web
$env:WEAPP_SKIP_LAUNCH=1
npm run test:miniprogram
```

**自动启动**（可能因启动慢而超时）：

```bash
cd web
npm run test:miniprogram
```

### 2.5 Windows 下 launch 失败原因

- **Node.js 18.20+** 在 Windows 下无法直接 `spawn` `.bat` 文件（安全策略 CVE-2024-27980）
- miniprogram-automator 的 `launch()` 内部使用 `spawn(cliPath, args)`，未传 `shell: true`
- **解决**：使用 `launch-weapp.js` 通过 `spawn(cmd, { shell: true })` 启动 CLI，再 `connect()`

### 2.6 环境变量

| 变量 | 说明 |
|------|------|
| `WEAPP_SKIP_LAUNCH` | 设为 1 时跳过 launch，仅 connect（需已手动启动） |
| `WEAPP_AUTO_PORT` | 自动化端口，默认 9420 |
| `WEAPP_CLI_PATH` | CLI 路径，默认 `C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat` |
| `WEAPP_PROJECT_PATH` | 项目路径，默认 `C:\Users\longwei\WeChatProjects\chelizi` |

### 2.7 选择器与操作

- `page.$(selector)`：单个元素，支持 class（如 `.idx-search`）、文本（如 `text=AI 智能定损`）
- `page.$$(selector)`：多个元素
- `element.tap()`：点击
- `page.waitFor(ms)` 或 `page.waitFor(selector)`：等待
- `miniProgram.reLaunch(path)`：重新打开页面
- `miniProgram.navigateTo(path)`：跳转

### 2.8 当前用例覆盖（全面测试）

**车主端（01-15）**：

| 页面 | 用例 |
|------|------|
| 01-首页 | AI 定损入口、搜索栏、附近服务商、点击搜索跳转 |
| 02-维修厂搜索列表 | 搜索/筛选、分类 |
| 03-维修厂详情 | 详情结构（需 SHOP001 等 seed 数据） |
| 04a-预约页 | 预约表单（需 shop id） |
| 05-个人中心 | 个人中心、我的订单入口 |
| 06-我的订单列表 | 订单 Tab/空态 |
| 07-我的竞价列表 | 竞价 Tab/空态 |
| 07a-订单详情 | 详情结构（无数据时 loading） |
| 07b-竞价报价页 | 详情结构（无数据时 empty/error） |
| 08-登录授权 | 登录页、微信快捷登录 |
| 09-消息页 | 消息页结构 |
| 10-设置页 | 设置菜单、服务商入口 |
| 11-返点余额 | 余额页结构 |
| 12-定损页 | 定损区域 |
| 13-定损历史 | 历史页结构 |
| 14-提现页 | 提现表单 |
| 15-服务商入口页（merchant/index） | 登录/注册/工作台入口汇总，非服务商首页 |

**服务商端（M01-M08）**：

| 页面 | 用例 |
|------|------|
| M01-服务商登录 | 登录表单、手机号密码 |
| M02-服务商注册 | 注册表单、企业名称 |
| M03-服务商工作台（merchant/home） | 服务商登录后首页，待报价、待接单等 |
| M04-竞价邀请列表 | 列表结构（未登录则重定向） |
| M06-服务商订单列表 | 列表结构（未登录则重定向） |
| M08-维修厂信息 | 信息页结构（未登录则重定向） |

**说明**：维修厂详情、预约页使用 `TEST_SHOP_ID=SHOP001`（schema seed）。M04/M06/M08 需服务商登录，用例会先以 18658823459 / 123456 自动登录，需确保该账号在数据库中已存在且 API 可访问。

---

## 三、规范与文档同步

- 新增/修改 E2E 用例时，同步更新 `web/e2e/README.md` 与本文档
- 页面路径、选择器变更时，检查用例是否仍有效
- 参考 `docs/pages/00-页面索引.md` 获取页面路径与功能说明

---

## 四、快速索引

| 需求 | 文档位置 |
|------|----------|
| 后台 E2E 运行与调试 | 本文 一、`web/e2e/README.md` |
| 小程序 E2E 运行与端口 | 本文 二、`web/e2e/README.md` |
| Windows launch 失败 | 本文 2.5、2.4 |
| 页面路径与功能 | `docs/pages/00-页面索引.md` |
