# Database Specification

## 1. Migration 管理

DB変更はすべてバージョン管理されたMigrationで実施する。

禁止事項：
- 適用済みMigrationファイルの直接書換え
- Production DBへの手動DDL直接実行
- 意味不明なNULL補完や不整合デフォルト値
- Migrationを介さないSchema変更

Migration検証項目：
- Fresh DB: `empty → latest`
- Upgrade: `previous → latest`
- 既存データ保持: `before data == semantically valid after data`

## 2. 永続化整合性境界とトランザクション規約（Transaction Boundary）

1. **単一トランザクション原則**: 複数テーブルにまたがる1業務操作（例：申請更新 + 承認ステップ追加 + 残数減算 + AuditLog記録）は、必ず単一のDBトランザクション内で実行する。
2. **中間コミットの禁止**: トランザクション途中で中間コミットを行ってはならない。例外発生時は自動ロールバックされる構造とする。
3. **DB外副作用の分離**: PDF生成、ファイルIO、外部メール/Webhook通知等のDB外副作用は、DBトランザクション内に含めず、トランザクションCommit後処理（Post-Commit Hooks / Outbox Pattern / Event Queue）として非同期または分離実行する。再試行時の冪等性を担保すること。

## 3. 履歴不変テーブル設計（Append-Only & Cycle-Versioned Schema）

1. **履歴の物理保持**: 承認ステップ（`application_approval_steps` 等）や監査ログ（`audit_logs` 等）は、更新（UPDATE）や削除（DELETE）を行わず、`approval_cycle` や `version` によるAppend-Only設計とする。
2. **一意性制約による二重計上防止**: 同一サイクル内のステップ重複や、同一イベントの二重処理を防ぐため、適切な複合UNIQUE制約（例: `UNIQUE(application_id, approval_cycle, step_order)`）を設定する。
