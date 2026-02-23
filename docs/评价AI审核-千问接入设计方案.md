# 评价 AI 审核 - 千问大模型接入设计方案

> 基于《全指标底层逻辑梳理.md》《评价和激励体系》（含第四章防刷管理规范）《评价奖励金体系-设计方案》，梳理需 AI 分析的维度、输入输出、接入时机。

---

## 一、文档中的 AI 审核要求汇总

### 1. 评价和激励体系 3.4.1 AI 核心能力模块

| 能力模块 | 核心校验内容 | 技术实现逻辑 | 千问可承担 |
|----------|--------------|--------------|------------|
| 交易真实性校验 | 订单、维修清单、车辆信息一致性 | OCR、VIN 解析、信息交叉比对 | 图文理解、信息比对 |
| 维修项目合规性校验 | 报修故障与维修项目匹配度 | 故障-维修匹配模型、语义识别 | 语义理解、匹配判断 |
| 配件真实性校验 | 配件型号、品牌与清单一致性 | OCR、图像特征、型号匹配 | 图文识别、一致性判断 |
| 内容完整性校验 | 是否完成对应订单的全部必填项 | NLP、图像完整性识别 | 结构化校验 + 图像有无判断 |
| 虚假内容识别 | 抄袭、套模板、无意义虚假评价 | 文本相似度、异常行为特征 | 文本质量、真实性判断 |

### 2. 防刷规范 - 事中审核

- **凭证异常**：凭证 PS 伪造、与订单项目不匹配、商户名称不符
- **内容重复度**：与平台已有评价高度重复、AI 生成批量套话
- **内容违规**：广告、低俗、辱骂、虚假宣传
- **有效内容门槛**：与维修项目相关的具体描述，无意义水评驳回

### 3. 评价奖励金体系 - 必填模块（以《全指标底层逻辑梳理》2.2 分阶管控为准）

- **L1-L2**：1–2 张实拍图（新旧配件对比图 / 施工结果图二选一），至少 1 句与项目相关描述。**无需**支付凭证、结算单、全过程施工图
- **L3-L4**：2 张核心实拍图（① 维修项目结果图；② 新旧配件对比图 / 维修明细单 / 定损单），包含项目、价格、服务细节等相关描述。**无需**支付凭证、全过程施工图、视频（仅作优质评价加分项）
- **差评**：问题实拍图（L3-L4 另需维修明细单）。**无需**沟通记录

**有效 vs 优质**：满足必传项为有效评价；完成加分项（维修明细、过程图、完整描述、追评等）为优质评价，可拿浮动奖励。

---

## 二、材料上传时的可校验项（提交前/上传时）

| 校验项 | 输入 | AI 分析内容 | 输出 | 时机 |
|--------|------|-------------|------|------|
| **材料是否上传** | 用户已选图片 URL 列表、订单复杂度等级、是否差评 | L1-L2：是否至少有 1 张施工图/新旧件对比图；L3-L4：是否至少有 2 张核心图（结果图 + 新旧件/明细单/定损单）；差评：是否有问题实拍图 | `{ hasRequiredImages: bool, imageCount: number, missing: string[] }` | 上传完成时 |
| **施工图与项目匹配** | 施工实拍图 URL 列表、订单维修项目（如钣金喷漆、换滤芯） | 1. 是否为维修/施工场景；2. 是否与项目类型匹配（如钣金图 vs 换滤芯）；3. 是否为新旧配件对比图或施工结果图 | `{ matchesProject: bool, imageCount: number, mismatchReason?: string }` | 上传完成时 |
| **差评凭证** | 问题图 | 差评时是否有问题实拍图（**无需沟通记录**） | `{ hasProblemImage: bool }` | 差评提交时 |

---

## 三、评价内容需 AI 分析的维度

| 维度 | 输入 | AI 分析内容 | 输出 | 说明 |
|------|------|-------------|------|------|
| **内容与项目相关性** | 评价文本、订单维修项目 | 描述是否与本次维修项目相关，是否泛泛而谈 | `{ relevant: bool, score: 0-1, reason?: string }` | 替代简单字数/水词规则 |
| **内容质量等级** | 评价文本、凭证完整性 | 基础有效 / 优质高价值 / 维权参考 / 无效水评 | `{ quality: 'invalid'|'basic'|'quality'|'维权参考', reason?: string }` | 供权重计算、奖励发放 |
| **虚假/抄袭识别** | 评价文本、平台历史评价 | 是否抄袭、套模板、AI 生成批量套话 | `{ isOriginal: bool, similarityToExisting?: number, isAIGenerated?: bool }` | 规范要求相似度>80% 驳回 |
| **违规内容** | 评价文本 | 广告、低俗、辱骂、虚假宣传 | `{ isClean: bool, violations?: string[] }` | 合规底线 |
| **维修项目匹配** | 评价文本、订单报修故障、维修项目 | 报修故障与维修项目、评价描述是否一致 | `{ faultMatch: bool, projectMatch: bool }` | 防过度维修、虚报项目 |

---

## 四、凭证与订单一致性（需订单上下文）

| 校验项 | 输入 | AI 分析内容 | 输出 |
|--------|------|-------------|------|
| **结算单与订单** | 结算单图片、订单金额、商户名称、维修项目 | 金额是否一致、商户名是否一致、项目是否在清单内 | `{ amountMatch: bool, shopMatch: bool, projectInList: bool }` |
| **施工图与项目** | 施工图、订单维修项目、复杂度等级 | 图片内容是否体现对应维修（如换件有新老对比、钣金有施工过程） | `{ sufficient: bool, detailLevel: 'ok'|'weak'|'missing' }` |
| **定损单核验** | 定损单图片、保险事故车标记 | 是否为有效定损单、单号格式（占位，实际对接保险公司） | `{ valid: bool, claimNo?: string }` |

---

## 五、千问调用时机与流程

### 方案 A：提交时一次性审核（推荐）

```
用户点击「提交评价」
    ↓
1. 规则校验（黑名单、双凭证有无、L1 封顶等）— 现有逻辑
    ↓
2. 调用千问：传入「订单信息 + 上传的图片 URL + 评价文本」
    ↓
3. 千问返回结构化 JSON：
   {
     pass: bool,           // 是否通过
     rejectReason?: string,
     details: {
       settlementCheck: {...},
       imageMatchCheck: {...},
       contentQuality: {...},
       contentViolation: {...},
       similarityRisk: {...}
     }
   }
    ↓
4. pass=true → 写入 reviews、发奖励、写 audit_log(ai,pass)
   pass=false → 400 + rejectReason，写 audit_log(ai,reject)
```

### 方案 B：上传时预检 + 提交时终审

- **上传时**：仅做「材料是否上传」「图片是否与类型匹配」的轻量预检，实时反馈用户
- **提交时**：做完整 AI 审核（凭证真实性、内容质量、违规、抄袭等）

---

## 六、千问输入输出设计

### 6.1 输入结构（Prompt 上下文）

```json
{
  "order": {
    "orderId": "ORDxxx",
    "shopName": "捷通汽车维修中心",
    "quotedAmount": 3500,
    "repairProjects": ["钣金喷漆", "更换前保险杠"],
    "complexityLevel": "L2",
    "faultDescription": "前保险杠刮擦"
  },
  "review": {
    "content": "用户填写的评价文本",
    "rating": 5,
    "isNegative": false
  },
  "images": [
    { "type": "settlement", "url": "https://..." },
    { "type": "completion", "url": "https://..." }
  ]
}
```

### 6.2 输出结构（结构化 JSON）

```json
{
  "pass": true,
  "rejectReason": null,
  "details": {
    "settlementCheck": {
      "hasValidSettlement": true,
      "shopNameMatch": true,
      "amountMatch": true,
      "note": "结算单清晰，金额一致"
    },
    "imageMatchCheck": {
      "matchesProject": true,
      "sufficientCount": true,
      "note": "施工图与钣金喷漆项目匹配"
    },
    "contentQuality": {
      "quality": "basic",
      "relevant": true,
      "minLengthOk": true,
      "note": "内容与维修项目相关，满足基础有效"
    },
    "contentViolation": {
      "isClean": true,
      "violations": []
    },
    "similarityRisk": {
      "isOriginal": true,
      "riskLevel": "low"
    }
  }
}
```

### 6.3 不通过时的输出示例

```json
{
  "pass": false,
  "rejectReason": "评价内容与维修项目关联不足，请补充具体维修体验描述",
  "details": {
    "contentQuality": {
      "quality": "invalid",
      "relevant": false,
      "note": "内容过于笼统，未涉及本次钣金喷漆项目"
    }
  }
}
```

---

## 七、实现要点

### 7.1 图片处理

- 千问多模态能力：支持图片 URL 或 base64 输入
- 若图片在 OSS，需生成可公网访问的 URL 或临时签名 URL 传入千问
- 单次请求图片数量建议 ≤6 张，避免超长上下文

### 7.2 Prompt 设计原则

1. **角色设定**：你是车厘子平台的评价审核助手，仅做形式化、可比对的合规校验，不对维修质量做担保
2. **输出约束**：必须返回合法 JSON，禁止自然语言兜底
3. **合规红线**：不审核内容正负倾向（好评/差评），只校验完整性、真实性、违规

### 7.2.1 已实现 Prompt（qwen-analyzer.js）

**System Prompt**（`REVIEW_AUDIT_SYSTEM_PROMPT`）：
- 角色：车厘子平台评价审核助手
- 职责：结算单真实性、施工图与项目匹配、内容质量、内容合规、套模板/AI 套话识别
- 合规红线：不审核好评/差评倾向，必须返回合法 JSON

**User Prompt**（`buildReviewAuditUserPrompt` 动态生成）：
- 注入订单 JSON（orderId、shopName、quotedAmount、repairProjects、complexityLevel、faultDescription）
- 注入评价 JSON（content、rating、isNegative）
- 图片类型说明（settlement、completion）
- 五维审核要求与输出 JSON 格式说明

**调用**：`analyzeReviewWithQwen({ order, review, images, apiKey })`，返回 `{ pass, rejectReason, details }`。

### 7.3 与现有逻辑的关系

- **保留**：黑名单、订单风控、L1 封顶、双凭证「有无」校验（材料未上传时直接驳回，不调 AI）
- **增强**：用千问替代 `checkContentAntiCheat` 的简单规则，实现内容质量、抄袭、违规的 AI 判断
- **新增**：凭证与订单一致性、施工图与项目匹配的 AI 校验

### 7.4 人工复核触发

- AI 返回 `pass=false` → 直接驳回，可进入申诉
- AI 返回 `pass=true` 但 `details` 中某项为弱（如 `contentQuality.quality='basic'` 且奖励金>800）→ 可标记为「建议人工复核」
- L3-L4、奖励金>800、保险事故车：AI 通过后仍可进入必审池，人工二次确认

---

## 八、修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0 | 2026-02-15 | 初稿，基于三份规范文档整理 AI 审核维度与千问接入设计 |
| v1.1 | 2026-02-15 | 实现 Prompt 与 analyzeReviewWithQwen，接入 POST /api/v1/reviews |
