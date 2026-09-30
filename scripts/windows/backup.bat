@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion

echo ===============================================================================
echo   公立小中学校 服務管理システム 手動バックアップ実行スクリプト
echo ===============================================================================
echo.

cd /d "%~dp0"

set "NODE_BIN=bin\node.exe"
if not exist "%NODE_BIN%" set "NODE_BIN=node"

"%NODE_BIN%" -e "const { BackupManager } = require('./server/dist/utils/backupManager'); const res = BackupManager.createBackup(); console.log(res.message); if (!res.success) process.exit(1);"

if %ERRORLEVEL% equ 0 (
    echo.
    echo [SUCCESS] バックアップが正常に作成されました。
    echo 保存先: %~dp0backups\
) else (
    echo.
    echo [ERROR] バックアップの作成に失敗しました。
)

echo.
pause
