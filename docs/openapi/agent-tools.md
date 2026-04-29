# Agent 工具接入说明（v1）

## 目标
沉淀模块化能力的**当前可用使用方式**，用于内部团队、测试与运营联调。

## 当前开放策略（重要）
- 现阶段：能力已具备，但**暂不对外商业开放 OpenAPI**（不做公开发放，不做外部合作方接入承诺）。
- 当前可用范围：
  - 小程序内调用（正式）
  - 官网/H5 入口调用公共诊断能力（正式）
  - OpenAPI 路由仅用于内部联调与验收（非对外）
- 对外口径：以页面工具能力为主，不宣传“可申请 API”。

## 统一调用约定
- **鉴权**：
  - 用户态：`Authorization: Bearer <user_jwt>`
  - 第三方/Agent：`X-API-Key: <open_api_key>`（或 `Authorization: Bearer <open_api_key>`）
- **链路追踪**：建议客户端传 `X-Request-Id`，服务端会回传同名 header。
- **幂等**：对创建类接口建议传 `Idempotency-Key`（10分钟TTL）。

## 使用方式（当前）

### A) 车主/用户侧（推荐）
1. 打开 `https://simplewin.cn/h5/tools`
2. 进入“AI诊断助手”
3. 输入任一信息：图片 / 故障码 / 症状文本
4. 查看“损失报告（AI）”统一模板结果
5. 点击“获取维修商报价”跳转小程序继续流程

### B) 小程序内（正式）
- 用户在小程序按原流程上传与提交，诊断结果在统一报告组件中查看；
- 报告模块与 H5 结果使用同构字段（明显损伤/可能损伤/维修建议等）。

### C) 内部联调（仅内部）
- 运维/研发可使用本文件中的 OpenAPI 路由做接口联调与回归测试；
- 不作为外部客户接入文档，不用于商务承诺。

## 推荐工具（Tools，仅内部联调）

### 1) 获取能力目录
- `GET /api/v1/public/capabilities/catalog`
- 用途：Agent 在运行时理解可用能力与输入输出结构。

### 2) 获取当前可用能力（OpenAPI）
- `GET /api/v1/open/capabilities`
- Header：`X-API-Key: ...`
- 用途：内部联调时确认某 API Key 已开通能力（如 `damage.report_share`）。

### 3) 事故车预报价（同步）
- `POST /api/v1/damage/analyze`
- Header：用户态 JWT
- Body：
  - `images`: 公网可访问 URL 数组
  - `user_description`: 可选
- 输出：结构化损伤 + 维修建议 + `confidence_score`

### 4) 分享摘要（两步）
1. Mint token（车主本人）
   - `POST /api/v1/damage/report/:id/share-token`
2. 公共摘要（无需登录）
   - `GET /api/v1/public/damage/report/share/:token`

### 5) 图片诊断（可脱离小程序独立调用）
- `POST /api/v1/open/diagnosis/image-analyze`
- Header：`X-API-Key: ...`
- Body：
  - `images`: 公网可访问 URL 数组
  - `user_description`: 可选
- 输出（统一诊断协议）：
  - `problem_summary`
  - `severity`
  - `repair_options`
  - `price_range`
  - `safety_notes`
  - `confidence`
  - `disclaimer`

### 6) 故障码诊断
- `POST /api/v1/open/diagnosis/dtc-interpret`
- Header：`X-API-Key: ...`
- Body：
  - `dtc_code`: 例如 `P0300`
- 输出：同统一诊断协议

### 7) 症状文本诊断
- `POST /api/v1/open/diagnosis/symptom-analyze`
- Header：`X-API-Key: ...`
- Body：
  - `symptom_text`: 车主故障描述
- 输出：同统一诊断协议

### 7.1) 报价OCR（P1模块，内部联调）
- `POST /api/v1/open/quote/ocr-import/by-image`
- Header：`X-API-Key: ...`
- Body：
  - `image_url`: 报价单图片 URL
- 能力开关：`quote.ocr_import`
- 输出：结构化报价项目（含 `items`、`missing_fields`、`recognition_failed` 等）

### 7.2) 维修进度公示查询（P1模块，内部联调）
- `POST /api/v1/open/repair/timeline/public`
- Header：`X-API-Key: ...`
- Body：
  - `order_id`: 订单号
- 能力开关：`repair.timeline_public`
- 输出：`milestones[]`、`count`、`order_status`
- 访问约束：若 API Key 绑定了 `owner_id`，仅允许访问同 `shop_id` 的订单进度。

### 8) 配件验真聚合（当前状态：暂缓上线）
- 结论：当前未找到稳定、可公开调用且可直接给出真伪结论的官方渠道/API。
- 因此本能力在对外用户场景中暂缓，不作为正式可用能力对外承诺。
- 现阶段仅保留预研能力（内部联调/技术验证）：
  - 编号验真：`POST /api/v1/open/parts/auth/query-by-code`
  - 图片验真：`POST /api/v1/open/parts/auth/query-by-image`
  - VIN适配验真：`POST /api/v1/open/parts/auth/fitment-check-by-vin`
  - 风险复算：`POST /api/v1/open/parts/auth/risk-scoring`
- 约束：无论是否命中品牌渠道，均不得向用户表述为“官方已验真”或“100%正品”。

### 8.1) 公共H5直连接口（无需 OpenAPI Key）
- 诊断（图片）：`POST /api/v1/public/diagnosis/image-analyze`
- 诊断（故障码）：`POST /api/v1/public/diagnosis/dtc-interpret`
- 诊断（症状）：`POST /api/v1/public/diagnosis/symptom-analyze`
- 验真（编号/图片）：仅预研调试使用，暂不作为对外能力承诺
- 限流：按 IP 做基础限流，超限返回 `429`

### 9) 独立H5入口（验真）
- `GET /h5/parts-auth`
- 用途：当前仅用于内部预研演示，不作为正式对外入口。
- 微信内支持：通过 `wx-open-launch-weapp` 拉起小程序（需已完成 JSSDK 配置）。

### 10) 独立H5入口（AI诊断）
- `GET /h5/diagnosis`
- 用途：在官网、公众号网页、独立H5中直接使用图片/故障码/症状诊断。
- 微信内支持：通过 `wx-open-launch-weapp` 拉起小程序承接后续报价。
- 渠道参数：支持 `?src=xxx`（示例：`/h5/diagnosis?src=search`）用于来源标记与后续归因。

### 11) 工具导航入口（官网聚合页）
- `GET /h5/tools`
- 用途：统一承载工具入口；当前建议仅主推 AI 诊断，配件验真显示为“暂缓上线/预研”状态。

### 12) H5来源埋点（公共）
- `POST /api/v1/public/h5/track`
- 用途：记录 H5 页面来源与关键动作（如 `page_view`、`submit_*`、`copy_share_link`、`cta_open_miniapp_click`）。
- 请求示例：
  - `tool`: `diagnosis-assistant | parts-auth | tools-hub`
  - `source`: 来源标记（通常来自 URL 参数 `src`）
  - `action`: 行为名称
  - `extra`: 扩展字段对象

### 13) 回填凭证建议结构（risk-scoring）
- `official_verified`: `boolean`
- `callback_signature`: `string`（可选，建议按 HMAC-SHA256 生成；服务端可用 `PARTS_AUTH_CALLBACK_SECRET` 校验）
- `user_receipts`: `array<object>`，建议字段：
  - `channel_name`
  - `receipt_url`
  - `queried_at`
  - `result_code`（如 `verified` / `pass` / `fail`）
  - `result_text`

### 14) 签名载荷调试接口
- `POST /api/v1/open/parts/auth/signing-payload`
- 用途：生成标准化签名前载荷（canonical payload），供第三方侧签名调试。

### 15) 重点品牌自动核验环境变量（预留）
- 丰田自动核验 API：
  - `TOYOTA_PARTS_AUTH_API_URL`
  - `TOYOTA_PARTS_AUTH_API_KEY`（可选）
- 宝马自动核验 API：
  - `BMW_PARTS_AUTH_API_URL`
  - `BMW_PARTS_AUTH_API_KEY`（可选）
- 若未配置上述变量，系统仅能执行预研流程，不构成对用户可用的官方验真能力。

### 16) 丰田/宝马人工核验渠道清单（人工咨询用途）
- 丰田（中国）建议渠道：
  - 丰田纯牌零件信息页：`https://www.toyota.com.cn/mobile/about/pure_parts/parts_01.php`
  - 丰田配件站（支持按编号检索）：`https://www.toyotaparts.com.cn/toyotas`
  - 客服热线（按品牌分流）：一汽丰田 `400-810-1210`，广汽丰田 `400-830-8888`
- 宝马（中国）建议渠道：
  - BMW中国联系页（含服务入口）：`https://www.bmw.com.cn/zh/footer/companies-business-customers/contact_us.html/1000`
  - BMW官方商城：`https://www.bmw-emall.cn/`
  - 客服热线：`400-800-6666`
- 使用建议：优先使用“配件编号 + VIN”向官方渠道人工核验；截图保留“查询时间 + 结果页 + 编号”。
- 说明：以上渠道主要用于人工咨询/人工核验，不等于公开可编程验真接口。

### 17) 手动核验回填与复核记录
- 手动核验完成后，H5 页可回填：
  - `channel_name`、`result_code`、`receipt_url`、`notes`
- 复算接口（公共）：
  - `POST /api/v1/public/parts/auth/risk-scoring`
- 复核记录接口（公共）：
  - `POST /api/v1/public/parts/auth/manual-check-record`
  - 返回 `record_id` 与 `canonical_payload`，用于下载归档与后续审计复查。

## Agent 端输出建议
- 对用户展示时，优先使用 `human_display` 三段（明显损伤/可能损伤/维修建议）。
- 必须强调：结果为“辅助参考”，不构成保险定损或责任认定。
- 对验真结果必须强调：无官方回执时，不得给出“100%正品”绝对结论。

