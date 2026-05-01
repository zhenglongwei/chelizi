# 辙见 - 部署说明

> 线上目录约定（当前生产默认）：`/var/www/simplewin` 下直接包含 `api-server/`、`scripts/`、`database/`、`.env`，**不包含** `web/` 中间目录。本文中若出现 `web/...`，在该部署结构下应对应为同级目录（如 `web/scripts` -> `scripts`）。

## 一、数据库初始化（必须先执行）

在服务器 MySQL 中执行 `web/database/schema.sql`，按《docs/database/数据库设计文档.md》创建 14 张表及初始数据。

详见 [web/database/init-db.md](database/init-db.md)。

**快速执行：**
```bash
# 在项目根目录执行
mysql -u root -p < web/database/schema.sql

# 或进入 database 目录后
cd web/database
bash run-init.sh
```

### 奖励金 `reward_rules` 一次性清理（基础轨简化）

若线上库在旧版后台曾保存过「单项目封顶 / 车价浮动校准 / 订单分级封顶 / 破格升级」等非零配置，而代码已按《docs/体系/03-全链路激励驱动体系.md》仅保留 **基础固定额 × 车价系数** 与 **佣金红线**，建议在部署机对**当前环境 `.env` 指向的库**执行脚本（**务必先 `--dry-run`** 核对输出）：

```bash
# 仓库根目录；依赖已安装在 web/api-server/node_modules
node web/scripts/normalize-reward-rules-db.js --info     # 查看当前连接的库与已有 rule_key
node web/scripts/normalize-reward-rules-db.js --dry-run
node web/scripts/normalize-reward-rules-db.js
```

逻辑见 `web/api-server/utils/normalize-reward-rules-json.js`。亦可由运营在后台「奖励金规则配置」页点击「保存全部配置」达到类似效果（脚本适合批量、可审计的线上清理）。

## 二、API 服务部署

### 1. 上传代码

将以下目录/文件上传到服务器（如 `/home/zhejian/`）：

- `web/api-server/`（含 server.js、package.json）
- `web/.env`（环境变量，注意勿提交到公开仓库）

### 2. 安装依赖并启动

```bash
cd /home/zhejian/web/api-server
npm install --production
```

### 3. 启动服务（任选一种）

**方式 A：直接运行**
```bash
node server.js
# 或
npm start
```

**方式 B：使用 pm2（推荐）**
```bash
# 推荐：用 ecosystem 固定 cwd，避免相对路径与 .env 读取问题
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # 开机自启
```

**PM2 多实例 / cluster 注意**：本项目的 `server.js` **未**使用 Node `cluster` 模块。若使用 `pm2 start -i 2` 或 ecosystem 里 `instances > 1` 且为 **cluster 模式**，多个进程会争抢同一 `PORT`，易出现 `EADDRINUSE`，PM2 会报 `too many unstable restarts` 后进入 `errored`。生产请 **`instances: 1`**，或改用 **fork 单实例**；若要多核负载，需在 Nginx 后挂多个**不同端口**的进程，或自行在代码中接入 `cluster`。

**.env 放置位置**：启动时会依次读取 `web/.env`（即 `api-server` 的上一级目录下的 `.env`）以及 `web/api-server/.env`（存在则**覆盖**前者）。仅把密钥放在 `api-server/.env` 即可，不必再复制到 `web/` 根目录。

**启动失败反复重启**：在服务器执行 `pm2 logs zhejian-api --lines 80` 查看首条报错。常见为：① 生产环境未设置 `JWT_SECRET`；② 多实例抢端口；③ `Cannot find module`（部署缺文件，需完整同步 `api-server` 目录后 `npm install --production`）。

### 4. 若使用 Nginx 反向代理

```nginx
location /api {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

确保已配置 SSL（HTTPS），微信小程序合法域名要求 HTTPS。

### 5. 云端联调（无本地开发环境）

本机**未**安装 Node/MySQL、或未配置 `web/.env` 时，可直接在服务器上验证功能：

1. **上传/同步代码**（含 `web/api-server/`、小程序工程、`web/.env` 等，勿把密钥提交到公开仓库）。
2. **数据库**：对线上库执行尚未跑过的迁移脚本（例如含佣金结算的 `web/database/migration-20260321-merchant-commission.sql`）；全新库可继续以 `schema.sql` 为基准。
3. **依赖与重启**：
   ```bash
   cd /path/to/web/api-server
   npm install --production
   pm2 restart zhejian-api   # 或你实际使用的进程名
   ```
4. **小程序**：保持 `config.js` 中 `BASE_URL` 为线上 HTTPS 域名，用微信开发者工具**真机/预览**走合法域名。
5. **佣金与微信支付（若启用）**：在服务器 `web/.env` 配置 `PUBLIC_API_BASE_URL`、`WECHAT_PAY_*` 等（见 [docs/本地开发环境配置.md](../docs/本地开发环境配置.md)）；在微信商户平台将支付回调 URL 设为 `https://你的域名/api/v1/pay/wechat/commission-notify`。**用户奖励金商家转账**：在商户平台「商家转账」中配置结果通知 URL 为 `https://你的域名/api/v1/pay/wechat/reward-transfer-notify`（或与 `WECHAT_PAY_TRANSFER_NOTIFY_URL` 一致）。
6. **微信支付 API 出口 IP 白名单**：若日志出现 `INVALID_REQUEST` / **「此IP地址不允许调用接口，请按开发指引设置」**，说明当前 **发起 APIv3 请求的服务器公网出口 IP** 未加入商户平台白名单。登录 [微信支付商户平台](https://pay.weixin.qq.com/) → **账户中心 → API 安全**（或「IP 白名单」相关菜单，以平台当前界面为准）→ 将 **运行 Node API 的那台机器访问外网时使用的公网 IP** 加入白名单。在服务器上可用 `curl -s ifconfig.me` 或 `curl -s ip.sb` 查看出口 IP；若使用负载均衡/多机，需分别加入或改用固定出口；云函数/无固定 IP 时需按微信文档使用允许的方案。

## 三、小程序 & 管理端配置

### 合法域名

微信后台配置的 request 合法域名需为 **HTTPS**。当前使用：`https://simplewin.cn`

### 修改 BASE_URL

| 端 | 文件 | 修改项 |
|----|------|--------|
| 小程序 | `config.js` | `BASE_URL: 'https://simplewin.cn'` |
| 管理端 | `web/.env` | `VITE_API_BASE_URL=https://simplewin.cn/api` |

注意：小程序与管理端使用同一 API 服务器。

## 四、AI 定损（千问 API）配置

### 1. 获取 API Key

1. 登录 [阿里云百炼控制台](https://dashscope.console.aliyun.com/)
2. 开通「模型服务灵积」或「通义千问」
3. 在「API-KEY 管理」中创建 Key，复制 `sk-xxx` 格式的密钥

### 2. 填写环境变量

在 `web/.env` 中配置：

```env
# 定损分析用（必填一项）
ALIYUN_AI_KEY=sk-xxxxxxxxxxxxxxxx
# 或
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxx

# 图片公网地址（千问需拉取图片，必须可访问）
BASE_URL=https://simplewin.cn
```

### 3. 可选配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DASHSCOPE_MODEL` | 千问模型名（OpenAI 兼容 `/chat/completions`） | `qwen-vl-plus` |
| `DASHSCOPE_BASE_URL` | OpenAI 兼容接口根（`…/compatible-mode/v1`，无尾斜杠） | `https://dashscope.aliyuncs.com/compatible-mode/v1` |

### 4. 未配置时的行为

未配置 `ALIYUN_AI_KEY` 或 `DASHSCOPE_API_KEY` 时，定损接口使用**模拟结果**，不影响其他功能。

---

## 五、测试

1. **健康检查**
   ```bash
   curl https://simplewin.cn/api/health
   ```

2. **附近维修厂接口**
   ```bash
   curl "https://simplewin.cn/api/v1/shops/nearby?limit=5"
   ```

3. **小程序**：打开首页，应能加载附近维修厂列表。
4. **管理后台**：admin / admin123 登录后查看各模块。
