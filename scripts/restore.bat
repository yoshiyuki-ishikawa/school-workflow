@echo off
chcp 65001 > nul
title 学校業務ワークフローシステム 6段階安全復元ツール

echo ==================================================
echo   学校業務ワークフローシステム 6段階安全復元ツール
echo ==================================================
echo.

cd /d "%~dp0\.."

echo 【ステップ 1/6】 サーバー停止確認
echo ※ 稼働中のサーバー画面を閉じてから続行してください。
echo.

echo 【利用可能なバックアップ一覧】
dir /b /o-d backups\*.db
echo.

set /p TARGET_BACKUP="復元に使用するバックアップファイル名 (例: 2026-08-28_090000.db) を入力: "

if not exist "backups\%TARGET_BACKUP%" (
    echo [エラー] 指定されたバックアップファイルが存在しません。
    pause
    exit /b 1
)

echo.
echo 【ステップ 2/6】 バックアップファイルの配置準備中...
echo.

echo 【ステップ 3/6】 現在のデータベースを退避中...
if exist "data\school_workflow.db" (
    copy /y "data\school_workflow.db" "data\school_workflow_before_restore.db" > nul
    echo ✔ 現DBを退避しました: data\school_workflow_before_restore.db
)

echo.
echo 【ステップ 4/6】 データベースファイルを復元中...
copy /y "backups\%TARGET_BACKUP%" "data\school_workflow.db" > nul
if exist "data\school_workflow.db-wal" del /f /q "data\school_workflow.db-wal"
if exist "data\school_workflow.db-shm" del /f /q "data\school_workflow.db-shm"
echo ✔ バックアップからデータベースを配置しました。

echo.
echo ==================================================
echo 【ステップ 5/6 ＆ 6/6】 復元処理が完了しました！
echo   start-windows.bat をダブルクリックしてサーバーを起動してください。
echo ==================================================
pause
