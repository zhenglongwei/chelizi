# 开发脚本

## 定损到返佣全流程模拟

模拟从用户定损开始到评价返佣的完整业务流程，用于开发调试与联调验证。

### 运行方式

```bash
cd web
npm run simulate:flow
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| API_BASE | API 地址 | http://localhost:3000 |
| USER_ID | 测试用户 ID | USER001 |
| MERCHANT_PHONE | 服务商手机号 | 18658823459 |

### 前置条件

1. **API 服务已启动**：`cd web/api-server && node server.js` 或通过 pm2 等启动
2. **数据库已初始化**：执行 `web/database/schema.sql`（含 users、shops seed）
3. **服务商账号已存在**：手机号 18658823459 已在 merchant_users 中且 status=1  
   - 可通过小程序「服务商注册」或后台审核通过后使用

### 模拟步骤

1. 获取用户 token
2. 创建定损报告（使用模拟结果，不调用 AI）
3. 创建竞价
4. 生成报价（优先使用指定服务商所属店铺）
5. 用户选厂 → 创建订单
6. 服务商接单
7. 维修完成 → 待用户确认
8. 用户确认完成
9. 用户评价 → 返佣 8%

### API 接口（仅非生产环境）

- `POST /api/v1/dev/simulate-full-flow`：一键执行全流程
- `POST /api/v1/dev/test-token`：获取测试 token（type=user 或 merchant）
