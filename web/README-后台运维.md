# 车厘子 - 后台运维说明

本目录包含**管理后台**（Web）的源码与部署说明。管理后台用于平台运营人员管理维修厂、订单、配置等。

**单页功能文档**：各页面功能、参数、交互、接口详见 `docs/pages/A01-后台登录.md` ~ `A09-系统配置.md`，索引见 `docs/pages/00-页面索引.md`。

---

## 一、目录结构

| 路径 | 说明 |
|------|------|
| `src/admin/` | 管理后台页面与逻辑 |
| `src/admin/pages/` | 各功能页面 |
| `src/admin/layouts/AdminLayout.tsx` | 后台布局、侧边栏 |
| `api-server/server.js` | API 服务，含 `/api/v1/admin/*` 接口 |
| `dist/` | 构建产物，部署到服务器 assets |

---

## 二、后台页面与路由

| 页面 | 路由 | 功能 |
|------|------|------|
| 登录 | /admin/login | 管理员账号密码 |
| 工作台 | /admin/dashboard | 数据概览 |
| 维修厂管理 | /admin/merchants | 商户列表、审核 |
| 订单管理 | /admin/orders | 订单列表、详情、报价审核 |
| 规则配置 | /admin/rules | 竞价规则、偏差惩罚 |
| 结算管理 | /admin/settlement | 佣金、提现 |
| 纠纷管理 | /admin/disputes | 投诉处理 |
| 数据统计 | /admin/statistics | 订单、GMV、分布 |
| 系统配置 | /admin/config | AI 限制、全局参数 |

---

## 三、API 接口（/api/v1/admin/*）

| 接口 | 说明 |
|------|------|
| POST /admin/login | 登录，返回 token |
| GET /admin/merchants | 商户列表（支持 auditStatus、keyword） |
| POST /admin/merchants/:id/audit | 商户审核 |
| GET /admin/orders | 订单列表 |
| GET /admin/orders/:orderNo | 订单详情 |
| POST /admin/orders/:orderNo/audit-quote | 报价审核 |
| GET /admin/statistics | 数据统计 |
| GET /admin/settlements | 结算列表 |
| GET /admin/complaints | 纠纷列表 |
| GET/PUT /admin/config | 系统配置 |

---

## 四、与车厘子数据模型对齐

- **merchant_users**：服务商账号，`shop_id` 关联 shops
- **shops**：维修厂信息，需有地理位置、状态
- **orders**：订单，status 0-4（待接单、维修中、待确认、已完成、已取消）
- 后台字段名（orderNo、merchantId 等）与 API 返回需与数据库字段映射一致

---

## 五、本地开发

```bash
cd web
npm install
npm run dev
```

访问 `http://localhost:5173/admin/login`，默认账号 `admin` / `admin123`。

---

## 六、部署

参见根目录《部署清单.md》。构建后上传 `web/dist/` 至服务器 `assets/`。
