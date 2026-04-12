# 数据库脚本说明（辙见）

## 为什么会有这么多文件？

| 类型 | 作用 |
|------|------|
| **`schema.sql`** | **空库一次性建全库**的基准脚本（表结构 + 必要初始数据）。适合本地/新环境。 |
| **`migration-*.sql`** | 按日期递增的**增量变更**（加表、加列、索引）。历史上先有库再改结构时，靠迁移补齐。 |
| **`reset-db.sql`** | 删除 `zhejian` 库（危险，仅开发/明确要重建时用）。 |

二者关系：**`schema.sql` 应尽量与「已执行全部迁移后的结构」一致**；若只执行了 `schema.sql` 而从未执行某些迁移，或 `schema` 未合并某次迁移里的列，就会出现「代码已引用某列，库里没有」的错误。

---

## 怎样保证数据库与代码一致？

### 场景 A：全新环境（可删库）

1. 执行 `schema.sql`（或 `reset-and-init.sh` / `reset-and-init.bat`：先 `reset-db.sql` 再 `schema.sql`）。
2. 运行 **校验脚本**（见下）确认关键表、列存在。
3. 若仍有报错：在**按文件名日期排序**后，对尚未合入 `schema.sql` 的迁移，**逐条**在测试库执行（可用 `mysql ... --force` 跳过「列已存在」类错误），再视情况把变更合并回 `schema.sql`（并更新 `docs/database/数据库设计文档.md`）。

### 场景 B：已有生产/测试库（不能删库）

1. **禁止**整文件覆盖执行 `schema.sql`（`CREATE TABLE IF NOT EXISTS` 不会更新已有表的缺列）。
2. 只执行**尚未执行过**的 `migration-*.sql`（按日期顺序），或针对缺失列执行对应迁移里的 `ALTER TABLE`。
3. 执行后同样用 **校验脚本** 或 `information_schema` 核对。

### 场景 C：不确定缺什么

1. 在库里执行 `web/database/verify-schema.sql`，查看输出是否均为「存在」。
2. 看 API 日志里 `Unknown column` / `doesn't exist`，用全局搜索在 `web/database/` 里找哪条迁移补该列/表，**只执行那一条**（或把该列补进 `schema.sql` 供以后新库使用）。

---

## 一键校验（推荐每次部署后）

```bash
mysql -u root -p zhejian < web/database/verify-schema.sql
```

（将 `zhejian`、账号按实际修改。）

---

## 维护建议（给项目维护者）

1. **新增字段/表**：先写 `migration-YYYYMMDD-简述.sql`，上线执行；再把 `schema.sql` 和 `docs/database/数据库设计文档.md` 同步改掉，避免下次「只导 schema」缺列。
2. **不要**在根目录堆积重复的 `migrations/` 与根级 `migration-*.sql`；新迁移统一用根目录 `migration-日期-主题.sql` 命名。
3. 定期用 `verify-schema.sql` + 接口冒烟测试，比「只跑一次 schema」更可靠。

---

## 与 `init-db.md` 的关系

具体操作命令仍以 **`init-db.md`** 中的 MySQL 客户端方式为准；本文件说明**策略与常见坑**，避免「只跑了 schema 仍缺列」。

---

## 极简评价 v3 列（`review_public_media` / `review_system_checks`）

- **单独补列**：若只跑 `migration-20260405-review-images-public.sql`，脚本已改为**可重复执行**（列已存在则跳过，避免 1060 Duplicate column）。
- **迁移**：`migration-20260406-review-minimal-v3.sql`（存储过程：若表上**没有** `review_images_public` 会先 `ADD` 该列，再追加两条 JSON 列，避免 `AFTER review_images_public` 在旧库上报错 1054）。
- **历史数据**：存量行两列均为 `NULL` 时，公示 API 按 **`review_images_public` 一刀切**过滤图片 URL（与改版前一致）；不做默认 `UPDATE` 回填 JSON，避免误公开历史图片。
- **新提交**：`review_form_version=3` 写入分项勾选 JSON 与系统校验快照；`review_images_public` 与「任一分项勾选为真」对齐，供旧逻辑兼容。
