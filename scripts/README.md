# 车厘子 - 项目完成度测试工具

按《协作规范》与《车厘子-全流程需求梳理》检查项目整体是否完成。

## 用法

```bash
# 使用默认 API 地址 (http://localhost:3000)
node scripts/check-completeness.js

# 指定 API 地址
node scripts/check-completeness.js http://localhost:3000
node scripts/check-completeness.js https://simplewin.cn/api

# 使用环境变量
set CHELIZI_API_URL=http://localhost:3000
node scripts/check-completeness.js
```

## 前置条件

- **API 检查**：需先启动 API 服务
  ```bash
  cd web/api-server && node server.js
  ```
- **结构检查**：无需 API，直接运行即可

## 检查项

1. **结构检查**
   - 车主端 + 服务商端页面是否在 app.json 中注册
   - 页面 .js/.wxml 文件是否存在
   - 后台路由是否在 App.tsx 中配置
   - Schema 是否包含核心表

2. **接口可用性**
   - GET /health 健康检查
   - GET /api/v1/shops/nearby 附近维修厂
   - POST /api/v1/admin/login 后台登录
   - GET /api/v1/admin/orders、merchants、statistics、config（需 token）
   - POST /api/v1/merchant/login 服务商登录

## 输出

- 通过: ✓
- 失败: ✗
- 跳过: ○

退出码：有失败项时返回 1，否则返回 0。
