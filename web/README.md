# 车厘子 - 事故车维修平台 后端服务

## 项目概述

基于 **Node.js + Express + MySQL** 的 RESTful API 服务，部署在阿里云ECS上。

## 技术栈

- **运行时**: Node.js 18+
- **Web框架**: Express 4.x
- **数据库**: MySQL 8.0
- **文件存储**: 阿里云OSS
- **AI服务**: 阿里云百炼/通义千问
- **认证**: JWT (jsonwebtoken)

## 项目结构

```
web/
├── .env                      # 环境变量配置
├── README.md                 # 本文件
├── api-server/
│   ├── server.js            # 主服务入口
│   ├── package.json         # 依赖配置
│   └── node_modules/        # 依赖包
└── database/
    └── schema.sql           # 数据库Schema
```

## 快速开始

### 1. 安装依赖

```bash
cd api-server
npm install
```

### 2. 配置环境变量

复制 `.env` 文件并配置实际参数：

```bash
# MySQL数据库配置
DB_HOST=your_aliyun_ecs_ip
DB_PORT=3306
DB_NAME=chelizi
DB_USER=root
DB_PASSWORD=your_password

# 阿里云OSS配置
OSS_REGION=oss-cn-hangzhou
OSS_BUCKET=your-bucket-name
OSS_ACCESS_KEY_ID=your_key
OSS_ACCESS_KEY_SECRET=your_secret

# 微信小程序配置
WX_APPID=your_appid
WX_SECRET=your_secret

# JWT密钥
JWT_SECRET=your_random_secret_key
```

### 3. 初始化数据库

```bash
mysql -u root -p < database/schema.sql
```

### 4. 启动服务

```bash
# 开发模式
npm run dev

# 生产模式
npm start
```

服务将在 `http://0.0.0.0:3000` 启动

## API接口文档

### 1. 用户认证

| 方法 | 接口 | 说明 |
|------|------|------|
| POST | /api/v1/auth/login | 微信登录 |

### 2. 用户管理

| 方法 | 接口 | 说明 |
|------|------|------|
| GET | /api/v1/user/profile | 获取用户信息 |
| PUT | /api/v1/user/profile | 更新用户信息 |
| GET | /api/v1/user/balance | 余额明细 |
| POST | /api/v1/user/withdraw | 申请提现 |

### 3. 定损分析

| 方法 | 接口 | 说明 |
|------|------|------|
| POST | /api/v1/damage/analyze | AI定损分析 |
| GET | /api/v1/damage/report/:id | 获取报告 |

### 4. 竞价报价

| 方法 | 接口 | 说明 |
|------|------|------|
| POST | /api/v1/bidding/create | 创建竞价 |
| GET | /api/v1/bidding/:id | 竞价详情 |
| GET | /api/v1/bidding/:id/quotes | 报价列表 |
| POST | /api/v1/bidding/:id/select | 选择维修厂 |

### 5. 维修厂

| 方法 | 接口 | 说明 |
|------|------|------|
| GET | /api/v1/shops/nearby | 附近维修厂 |
| GET | /api/v1/shops/:id | 维修厂详情 |
| GET | /api/v1/shops/:id/reviews | 维修厂评价 |

### 6. 评价

| 方法 | 接口 | 说明 |
|------|------|------|
| POST | /api/v1/reviews | 提交评价 |
| POST | /api/v1/reviews/analyze | AI对比分析 |

## 数据库表结构

详见 `database/schema.sql`，包含以下表：

- `users` - 用户表
- `shops` - 维修厂表
- `damage_reports` - 定损报告表
- `biddings` - 竞价表
- `quotes` - 报价表
- `orders` - 订单表
- `reviews` - 评价表
- `transactions` - 交易记录表
- `withdrawals` - 提现申请表

## 部署说明

### 阿里云ECS配置

1. 购买ECS实例（推荐2核4G以上配置）
2. 安装Node.js 18+ 和 MySQL 8.0
3. 配置安全组，开放3000端口
4. 使用PM2启动服务：

```bash
npm install -g pm2
pm2 start server.js --name chelizi-api
pm2 startup
pm2 save
```

### Nginx反向代理（推荐）

```nginx
server {
    listen 80;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## 注意事项

1. **生产环境务必修改JWT_SECRET**
2. **数据库密码使用强密码**
3. **OSS配置使用RAM子账号，遵循最小权限原则**
4. **定期备份数据库**
5. **配置日志轮转防止磁盘占满**

## 更新日志

### v2.0.0 (2026-02-11)
- 从微信云开发迁移到阿里云ECS
- 新增完整的RESTful API
- 新增MySQL数据库支持
- 新增JWT认证
