#!/bin/bash
set -e

cd "$(dirname "$0")/.."
BACKUP_DIR="backups"
DATA_DIR="data"
DB_FILE="$DATA_DIR/school_workflow.db"

echo "=================================================="
echo "  学校業務ワークフローシステム 6段階安全復元ツール"
echo "=================================================="
echo ""

# 1. サーバー停止確認
echo "【ステップ 1/6】 サーバー停止確認"
echo "※ 稼働中のサーバー（Nodeプロセス）を停止した状態で実行してください。"
echo ""

# バックアップ一覧表示
echo "【利用可能なバックアップ一覧】"
if [ ! -d "$BACKUP_DIR" ] || [ -z "$(ls -A $BACKUP_DIR/*.db 2>/dev/null)" ]; then
    echo "エラー: バックアップファイルが存在しません。"
    exit 1
fi

ls -lt "$BACKUP_DIR"/*.db | awk '{print NR, $9, "(" $5 " bytes,", $6, $7, $8 ")"}'
echo ""

read -p "復元に使用するバックアップファイルのフルパスを入力してください: " TARGET_BACKUP

if [ ! -f "$TARGET_BACKUP" ]; then
    echo "エラー: 指定されたバックアップファイルが存在しません: $TARGET_BACKUP"
    exit 1
fi

# 2. バックアップ整合性確認
echo ""
echo "【ステップ 2/6】 バックアップファイルの整合性検証中 (PRAGMA integrity_check)..."
CHECK_RESULT=$(sqlite3 "$TARGET_BACKUP" "PRAGMA integrity_check;" 2>&1 || true)
if [ "$CHECK_RESULT" != "ok" ]; then
    echo "警告: バックアップファイルに不整合が検出されました ($CHECK_RESULT)"
    read -p "それでも復元を続行しますか？ (y/N): " CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
        echo "復元処理を中止しました。"
        exit 1
    fi
else
    echo "✔ バックアップファイルの健全性を確認しました (ok)"
fi

# 3. 現DBの安全退避
echo ""
echo "【ステップ 3/6】 現在のデータベースを退避中..."
mkdir -p "$DATA_DIR"
if [ -f "$DB_FILE" ]; then
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP_CORRUPT="$DATA_DIR/school_workflow_before_restore_$TIMESTAMP.db"
    cp "$DB_FILE" "$BACKUP_CORRUPT"
    echo "✔ 現DBを退避しました: $BACKUP_CORRUPT"
fi

# 4. データ復元
echo ""
echo "【ステップ 4/6】 データベースファイルを復元中..."
cp "$TARGET_BACKUP" "$DB_FILE"
# WAL関連の一時ファイルがあれば削除して整合性を保つ
rm -f "$DATA_DIR/school_workflow.db-wal" "$DATA_DIR/school_workflow.db-shm"
echo "✔ バックアップからデータベースを配置しました。"

# 5. 復元後整合性確認
echo ""
echo "【ステップ 5/6】 復元後データベースの整合性検証中..."
FINAL_CHECK=$(sqlite3 "$DB_FILE" "PRAGMA integrity_check;" 2>&1 || true)
if [ "$FINAL_CHECK" == "ok" ]; then
    echo "✔ 復元後整合性確認: 正常 (ok)"
else
    echo "⚠ 復元後整合性警告: $FINAL_CHECK"
fi

# 6. 完了案内
echo ""
echo "=================================================="
echo "【ステップ 6/6】 復元処理が完了しました！"
echo "  サーバー起動スクリプト (start-windows.bat または start-mac.command)"
echo "  を実行してシステムを再開してください。"
echo "=================================================="
