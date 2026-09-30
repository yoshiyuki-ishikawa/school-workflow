@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion

echo ===============================================================================
echo   公立小中学校 服務管理システム (School Workflow Engine) 起動スクリプト
echo ===============================================================================
echo.

cd /d "%~dp0"

REM 1. ディレクトリの存在確認と作成
if not exist "data" mkdir "data"
if not exist "backups" mkdir "backups"
if not exist "logs" mkdir "logs"

REM 2. Node.js ランタイムの解決 (同梱ポータブル版 bin\node.exe を優先)
set "NODE_BIN=bin\node.exe"
if exist "%NODE_BIN%" (
    echo [INFO] 同梱のポータブルNode.jsランタイムを使用します: %NODE_BIN%
) else (
    echo [INFO] 同梱ランタイムが見つからないため、システムのNode.jsを使用します
    set "NODE_BIN=node"
)

REM 3. 初回環境設定 (.env の自動生成)
if not exist ".env" (
    echo [INFO] 初回起動のため .env を自動生成しています...
    (
        echo PORT=3000
        echo NODE_ENV=production
        echo POC_MODE=false
        echo SESSION_SECRET=school_secret_%RANDOM%_%RANDOM%_%RANDOM%
    ) > .env
    echo [INFO] .env を生成しました。
)

REM 4. サーバーの起動
echo.
echo [INFO] 服務管理システムを起動しています (ポート: 3000)...
echo [INFO] ブラウザから http://localhost:3000 にアクセスしてください。
echo [INFO] 同一LAN内の他のPCからは、この親機のIPアドレス (例: http://192.168.1.xxx:3000) でアクセスできます。
echo.
echo ===============================================================================
echo   停止する場合は、このウィンドウで Ctrl + C を押してください。
echo ===============================================================================
echo.

REM 5秒後にブラウザを自動起動
start "" http://localhost:3000

REM サーバープロセス実行
"%NODE_BIN%" server/dist/index.js

pause
