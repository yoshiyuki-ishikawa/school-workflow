@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion

echo ===============================================================================
echo   公立小中学校 服務管理システム システム復元（リストア）スクリプト
echo ===============================================================================
echo.

cd /d "%~dp0"

if "%~1"=="" (
    echo [ERROR] 復元対象のバックアップフォルダのパスを引数に指定してください。
    echo 例: restore.bat backups\backup_20260831_120000
    echo.
    pause
    exit /b 1
)

set "TARGET_BACKUP=%~1"
set "NODE_BIN=bin\node.exe"
if not exist "%NODE_BIN%" set "NODE_BIN=node"

echo 復元対象: %TARGET_BACKUP%
echo 現在のデータは復元データに上書きされます。
set /p CONFIRM="復元を実行しますか？ (Y/N): "
if /i not "%CONFIRM%"=="Y" (
    echo キャンセルしました。
    pause
    exit /b 0
)

"%NODE_BIN%" -e "const { BackupManager } = require('./server/dist/utils/backupManager'); const res = BackupManager.restoreBackup(process.argv[1]); console.log(res.message); if (!res.success) process.exit(1);" "%TARGET_BACKUP%"

if %ERRORLEVEL% equ 0 (
    echo.
    echo [SUCCESS] システムの復元が正常に完了しました。
    echo サービスを再起動してください: start-windows.bat
) else (
    echo.
    echo [ERROR] 復元処理に失敗しました。
)

echo.
pause
