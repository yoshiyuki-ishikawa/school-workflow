@echo off
chcp 65001 > nul
title 学校業務ワークフローシステム (サーバー)

echo ==================================================
echo   学校業務ワークフローシステム を起動しています...
echo ==================================================
echo.

cd /d "%~dp0\.."

REM Node.jsの存在確認
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [エラー] Node.js がインストールされていません。
    echo Node.js (v20以上推奨) をインストールしてください。
    pause
    exit /b 1
)

REM サーバー起動
npm run start

if %errorlevel% neq 0 (
    echo.
    echo [警告] 通常起動に失敗しました。開発モードで再試行します...
    npm run dev:server
)

pause
