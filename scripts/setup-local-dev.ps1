# 辙见 - 本地开发快速初始化（Windows PowerShell）
# 用法：在项目根目录执行  .\scripts\setup-local-dev.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$envExample = Join-Path $root 'web\.env.example'
$envFile = Join-Path $root 'web\.env'
if (-not (Test-Path $envFile)) {
  if (Test-Path $envExample) {
    Copy-Item $envExample $envFile
    Write-Host "[OK] 已创建 web/.env（请编辑填写 DB_PASSWORD、WX_APPID、WX_SECRET）"
  } else {
    Write-Host "[WARN] 缺少 web/.env.example，请手动创建 web/.env"
  }
} else {
  Write-Host "[SKIP] web/.env 已存在"
}

$localExample = Join-Path $root 'config.local.example.js'
$localFile = Join-Path $root 'config.local.js'
if (-not (Test-Path $localFile)) {
  if (Test-Path $localExample) {
    Copy-Item $localExample $localFile
    Write-Host "[OK] 已创建 config.local.js（BASE_URL 默认 http://127.0.0.1:3000）"
  }
} else {
  Write-Host "[SKIP] config.local.js 已存在"
}

$apiDir = Join-Path $root 'web\api-server'
if (Test-Path (Join-Path $apiDir 'package.json')) {
  Write-Host ""
  Write-Host "下一步："
  Write-Host "  1. 安装 MySQL 8，创建库并导入：mysql -u root -p < web/database/schema.sql"
  Write-Host "  2. 编辑 web/.env 填写数据库密码与微信密钥"
  Write-Host "  3. cd web/api-server && npm install && npm run dev"
  Write-Host "  4. 浏览器访问 http://127.0.0.1:3000/health"
  Write-Host "  5. 微信开发者工具打开本项目，勾选不校验合法域名"
}
