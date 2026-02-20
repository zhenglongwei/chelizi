# 车厘子 - 部署说明

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

## 二、API 服务部署

### 1. 上传代码

将以下目录/文件上传到服务器（如 `/home/chelizi/`）：

- `web/api-server/`（含 server.js、package.json）
- `web/.env`（环境变量，注意勿提交到公开仓库）

### 2. 安装依赖并启动

```bash
cd /home/chelizi/web/api-server
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
pm2 start server.js --name chelizi-api
pm2 save
pm2 startup  # 开机自启
```

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
| `DASHSCOPE_MODEL` | 视觉模型名称 | `qwen-vl-plus` |
| `DASHSCOPE_BASE_URL` | 兼容模式地址 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |

### 4. 未配置时的行为

未配置 `ALIYUN_AI_KEY` 或 `DASHSCOPE_API_KEY` 时，定损接口使用**模拟结果**，不影响其他功能。

---

## 五、测试

1. **健康检查**
   ```bash
   curl https://simplewin.cn/health
   ```

2. **附近维修厂接口**
   ```bash
   curl "https://simplewin.cn/api/v1/shops/nearby?limit=5"
   ```

3. **小程序**：打开首页，应能加载附近维修厂列表。
4. **管理后台**：admin / admin123 登录后查看各模块。
