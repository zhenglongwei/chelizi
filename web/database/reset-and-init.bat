@echo off
chcp 65001 >nul
setlocal

:: 清空数据库并重建 - Windows
:: 用法：reset-and-init.bat [mysql路径]
:: 默认使用系统 PATH 中的 mysql

set "MYSQL=mysql"
if not "%~1"=="" set "MYSQL=%~1"

set "DB_DIR=%~dp0"
cd /d "%DB_DIR%"

echo [1/2] 删除数据库 chelizi...
"%MYSQL%" -u root -p < reset-db.sql
if errorlevel 1 (
    echo 执行 reset-db.sql 失败，请检查 MySQL 连接
    exit /b 1
)

echo [2/2] 重建 schema 及初始数据...
"%MYSQL%" -u root -p < schema.sql
if errorlevel 1 (
    echo 执行 schema.sql 失败
    exit /b 1
)

echo.
echo 完成。数据库已清空并重建。
exit /b 0
