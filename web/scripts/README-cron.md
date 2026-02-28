# 竞价消息补发 - 定时任务

第二、第三梯队竞价消息的定时补发脚本，在第一梯队 15 分钟窗口结束后向对应店铺推送消息。

## 文件说明

| 文件 | 说明 |
|------|------|
| `cron-send-delayed-bidding-messages.sh` | 可执行脚本 |
| `cron.env.example` | 配置示例，复制为 `cron.env` 后填写 |
| `crontab.example` | crontab 示例 |
| `README-cron.md` | 本说明 |

## 部署步骤

### 1. 上传文件到服务器

将以下文件上传到 `/var/www/simplewin/scripts/`（或你的项目 scripts 目录）：

- `cron-send-delayed-bidding-messages.sh`
- `cron.env.example`

### 2. 配置 cron.env

```bash
cd /var/www/simplewin/scripts
cp cron.env.example cron.env
chmod 600 cron.env   # 限制权限，避免泄露密钥
```

编辑 `cron.env`，填写：

- `CRON_SECRET`：与 api-server 的 `.env` 中 `CRON_SECRET` 一致
- `API_BASE_URL`（可选）：API 地址，默认 `https://simplewin.cn/api`

### 3. 配置 api-server .env

在 `/var/www/simplewin/.env` 中增加：

```
CRON_SECRET=你的随机密钥
```

与 `cron.env` 中的 `CRON_SECRET` 保持一致。

### 4. 赋予执行权限

```bash
chmod +x /var/www/simplewin/scripts/cron-send-delayed-bidding-messages.sh
```

### 5. 手动测试

```bash
/var/www/simplewin/scripts/cron-send-delayed-bidding-messages.sh
```

成功时输出类似：`[2026-02-25 12:00:00] OK: {"code":200,"data":{"sentCount":0},...}`

### 6. 添加 crontab

```bash
crontab -e
```

添加（路径按实际调整）：

```
*/2 * * * * /var/www/simplewin/scripts/cron-send-delayed-bidding-messages.sh >> /var/log/chelizi-cron.log 2>&1
```

或使用示例文件：

```bash
# 先修改 crontab.example 中的路径，再：
crontab /var/www/simplewin/scripts/crontab.example
```

### 7. 创建日志文件（可选）

```bash
touch /var/log/chelizi-cron.log
chmod 644 /var/log/chelizi-cron.log
```

### 8. 若出现 `$'\r': command not found` 或 `bad interpreter`

说明 `cron.env` 或脚本为 Windows 换行符（CRLF），在服务器执行：

```bash
sed -i 's/\r$//' /var/www/simplewin/scripts/cron-send-delayed-bidding-messages.sh
sed -i 's/\r$//' /var/www/simplewin/scripts/cron.env
```

## 执行频率建议

- **每 2 分钟**：`*/2 * * * *`（推荐，窗口结束后约 2 分钟内推送）
- **每 1 分钟**：`* * * * *`（更及时，调用略多）

## 故障排查

- **401 未授权**：检查 `CRON_SECRET` 是否与 api-server `.env` 一致
- **脚本无执行权限**：`chmod +x cron-send-delayed-bidding-messages.sh`
- **cron.env 未找到**：确认脚本与 `cron.env` 在同一目录，或修改脚本中的 `SCRIPT_DIR`
- **查看日志**：`tail -f /var/log/chelizi-cron.log`
