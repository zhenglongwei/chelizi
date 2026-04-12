# 信任基建：实施清单与 Backlog

> 与《启发》对齐、主口径见 [辙见-全流程需求梳理.md](../../辙见-全流程需求梳理.md) 2.4 节、[维修方案调整与确认流程.md](../维修方案调整与确认流程.md)、[支付与结算总览.md](支付与结算总览.md)。

---

## 一、标准报价模板与导入

| 项 | 说明 | 优先级 |
|----|------|--------|
| 模板下载 | 列与 `quotes.items` / `warranty_months` 对齐；**已实现** `GET /api/v1/merchant/quote-template.xlsx`（中文说明 + 报价明细表）及 `GET /api/v1/merchant/quote-template`（JSON+csv 兼容） | P0 |
| 小程序上传解析 | **已实现** `POST /api/v1/merchant/quote-import/preview-xlsx`（`multipart` 字段 `file`，.xlsx）→ `items` + `amount_sum`；商户端竞价详情「导入 Excel」；`POST .../preview`（`csv_text`）保留脚本/兼容 | P0 |
| 字段校验 | 缺列、金额为负、必填项为空时逐行错误提示 | P0 |
| 拍照 / PDF OCR | **已实现** `POST /api/v1/merchant/quote-sheet/analyze-image`（`image_url`，千问视觉）；识别失败或缺项时提示补全 | P1 |
| 接口 | 见 [M05](../pages/M05-竞价详情与报价.md) | P0 |

---

## 二、预报价治理（贴近最终报价）

| 项 | 说明 | 优先级 |
|----|------|--------|
| 排序与匹配分 | 已用 `deviation_rate` 等；落地后切换为 **预↔终** 为主（见 [05](../体系/05-店铺综合评价体系.md)、[07](../体系/07-竞价单分发机制.md)） | P0 |
| 合规扣分 | 「无报价确认、额外项目、结算偏差」等与锁价规则对齐，避免与锁价后加价并存 | P0 |
| 预报价提交时 AI 预警 | 相对定损预估/公允区间偏离提示（非首期强制拦单） | P1 |
| 运营参数 | 偏差阈值、预警文案在 A05 或 bidding 配置中可配 | P2 |

---

## 三、分项质保与展示

| 项 | 说明 | 优先级 |
|----|------|--------|
| 逐项目质保 | `items[].warranty_months`；订单详情/评价展示分项约定 | P0 |
| 独立质保卡/核验/分享 | **已取消**（曾含小程序凭证页、公开核验接口等）；对外以订单约定为准；帮助页「质保责任说明」保留 | — |
| 到期提醒 | 订阅消息或站内信（可选） | P2 |

---

## 四、完工与责任人

| 项 | 说明 | 优先级 |
|----|------|--------|
| 负责技师/负责人 | `completion_evidence.lead_technician`，与 `technician_certs` 下拉 | P0 |
| 与评价/合规 | 便于追溯；与材料审核、申诉材料一致 | P1 |

---

## 五、官网历史成交价（非小程序刚需）

| 项 | 说明 |
|----|------|
| 接口 | `GET /api/v1/public/historical-fair-price?model=`（`web/api-server/services/historical-fair-price-service.js`） |
| 前端 | 官网 `/fair-price`，`VITE_API_BASE_URL` 指向 API |
| 规则 | 默认近 365 天、完成单、`actual_amount>0`；样本 `<5` 不展示区间 |

---

## 六、刻意不做（已拍板）

- 工商/交警系统自动核验接口（冷启动以人工+材料为准）
- 维修保证金、平台先行赔付
- 全程录像 + AI 过程分析（近期）

---

## 七、依赖与文档同步

- 表结构：`web/database/migration-20260326-orders-two-stage-quote.sql` 与 `docs/database/数据库设计文档.md`
- 体系变更已同步：[05](../体系/05-店铺综合评价体系.md)、[07](../体系/07-竞价单分发机制.md)、[03](../体系/03-全链路激励驱动体系.md) 2.4 节
