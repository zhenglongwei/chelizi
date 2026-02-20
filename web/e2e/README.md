# E2E 测试

## 一、后台 E2E（Playwright）

### 前置条件

**本机已安装 Chrome**。配置使用 `channel: 'chrome'`，无需执行 `npx playwright install chromium`。

## Chromium 下载失败 (ECONNRESET) 时

`npx playwright install chromium` 在国内网络可能失败，当前配置已改为使用本机 Chrome，**无需下载 Chromium**。确保本机已安装 [Google Chrome](https://www.google.com/chrome/) 即可。

## 运行

```bash
cd web
npm run test:e2e
```

指定 baseURL（如测本地）：

```bash
set PLAYWRIGHT_BASE_URL=http://localhost:3001
npm run test:e2e
```

## 用例说明

- A01：登录页可访问、登录成功跳转
- A02：工作台数据概览
- A03：维修厂管理页
- A04：订单管理页

详见 [docs/E2E测试经验.md](../../docs/E2E测试经验.md)。

## 调试

若用例失败，可加 `--headed` 查看浏览器操作：

```bash
npx playwright test --headed
```

---

## 二、小程序 E2E（miniprogram-automator）

### 前置条件

- 已安装**微信开发者工具**
- 在 设置 → 安全设置 中**开启服务端口**（供 CLI 调用）
- 运行前**关闭**已打开的开发者工具窗口（避免与 launch 冲突）

### 端口说明

| 端口类型 | 说明 |
|---------|------|
| **服务端口** | 设置中显示的端口（如 51937），用于 CLI/HTTP 调用 |
| **自动化端口** | `cli auto --auto-port` 指定的 WebSocket 端口，默认 9420。若服务端口为 51937，可尝试 `WEAPP_AUTO_PORT=51937` |

### 运行

```bash
cd web
npm run test:miniprogram
```

指定自动化端口（若服务端口为 51937，可尝试）：

```bash
set WEAPP_AUTO_PORT=51937
npm run test:miniprogram
```

若自动启动失败，可手动启动后再测：

```bash
# 终端 1：手动启动自动化窗口
"C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat" auto --project C:\Users\longwei\WeChatProjects\chelizi --auto-port 9420

# 终端 2：等窗口打开后运行测试（跳过 launch）
set WEAPP_SKIP_LAUNCH=1
npm run test:miniprogram
```

## 用例说明（小程序）

**车主端**：首页、搜索列表、维修厂详情、预约、订单列表/详情、竞价列表/详情、登录、消息、设置、返点余额、提现、定损、定损历史、服务商入口等。

**服务商端**：登录、注册、工作台、竞价邀请列表、订单列表、维修厂信息。

详见 [docs/E2E测试经验.md](../../docs/E2E测试经验.md)。
