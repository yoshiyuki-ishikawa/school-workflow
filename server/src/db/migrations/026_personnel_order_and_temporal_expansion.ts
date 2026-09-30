import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 026: Original Wave 6 (GAP-07: 人事発令Fact基盤・出勤簿自動連動)
 * 
 * 1. applications テーブルへの Pre-Supersede Provenance カラム追加
 *    - pre_supersede_status: 発令重複失効直前のステータス ('FINAL_APPROVED', 'SUBMITTED', 等)
 *    - pre_supersede_workflow_cycle_id: 失効直前のアクティブ Cycle ID
 *    - superseded_by_personnel_status_id: 原因となった人事発令 ID
 *    - superseded_at: 失効日時 (ISO8601)
 * 
 * 2. personnel_statuses テーブルの安全な再構築
 *    - issued_at: 発令日 (Nullable for Legacy, 新規はService層で必須化)
 *    - effective_to: 終了日 (Nullable化: HD-W6-01)
 *    - status: 'SUPERSEDED_BY_AMENDMENT' を追加
 *    - authority_basis: 'OFFICIAL_ORDER' | 'OFFICIAL_NOTICE' | 'ELECTRONIC_NOTICE' | 'UNVERIFIED_LEGACY'
 *    - order_authority_snapshot: 登録時発令主体スナップショット (DB固定DEFAULT撤廃)
 *    - superseded_by_status_id: 訂正後続レコードID
 * 
 * 3. Legacy Backfill (Historical Fact Integrity 保証)
 *    - issued_at = NULL (推測コピー完全排除)
 *    - authority_basis = 'UNVERIFIED_LEGACY' (架空成立区分の注入禁止)
 *    - order_authority_snapshot = 'UNVERIFIED_LEGACY' (現在設定値の推測注入禁止)
 */
export const migration026: Migration = {
  version: 26,
  name: 'personnel_order_and_temporal_expansion',
  up: (db: Database) => {
    // 1. applications テーブルへの Pre-Supersede Provenance カラム追加
    const appCols = db.prepare('PRAGMA table_info(applications)').all() as { name: string }[];
    const appColNames = new Set(appCols.map((c) => c.name));

    if (!appColNames.has('pre_supersede_status')) {
      db.exec('ALTER TABLE applications ADD COLUMN pre_supersede_status TEXT;');
    }
    if (!appColNames.has('pre_supersede_workflow_cycle_id')) {
      db.exec('ALTER TABLE applications ADD COLUMN pre_supersede_workflow_cycle_id INTEGER REFERENCES application_workflow_cycles(id);');
    }
    if (!appColNames.has('superseded_by_personnel_status_id')) {
      db.exec('ALTER TABLE applications ADD COLUMN superseded_by_personnel_status_id INTEGER REFERENCES personnel_statuses(id);');
    }
    if (!appColNames.has('superseded_at')) {
      db.exec('ALTER TABLE applications ADD COLUMN superseded_at TEXT;');
    }

    // 2. personnel_statuses テーブルの安全な再構築
    db.exec(`
      CREATE TABLE personnel_statuses_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        status_type TEXT NOT NULL,
        policy_rule_id INTEGER REFERENCES policy_rules(id),
        source_application_id INTEGER UNIQUE REFERENCES applications(id) ON DELETE SET NULL,
        document_reference_no TEXT,
        issued_at TEXT,
        effective_from TEXT NOT NULL,
        effective_to TEXT,
        ended_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('REGISTERED', 'CONFIRMED', 'EFFECTIVE', 'ENDED', 'CANCELLED', 'SUPERSEDED_BY_AMENDMENT')),
        authority_basis TEXT NOT NULL CHECK(authority_basis IN ('OFFICIAL_ORDER', 'OFFICIAL_NOTICE', 'ELECTRONIC_NOTICE', 'UNVERIFIED_LEGACY')),
        order_authority_snapshot TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        registered_by_user_id INTEGER NOT NULL REFERENCES users(id),
        confirmed_by_user_id INTEGER REFERENCES users(id),
        superseded_by_status_id INTEGER REFERENCES personnel_statuses(id),
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        updated_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        CHECK (effective_to IS NULL OR effective_from <= effective_to)
      );

      INSERT INTO personnel_statuses_new (
        id, user_id, status_type, policy_rule_id, source_application_id, document_reference_no,
        issued_at, effective_from, effective_to, ended_at, status, authority_basis, order_authority_snapshot,
        reason_code, registered_by_user_id, confirmed_by_user_id, created_at, updated_at
      )
      SELECT
        id, user_id, status_type, policy_rule_id, source_application_id, document_reference_no,
        NULL,
        effective_from, effective_to, ended_at, status,
        'UNVERIFIED_LEGACY',
        'UNVERIFIED_LEGACY',
        reason_code, registered_by_user_id, confirmed_by_user_id, created_at, updated_at
      FROM personnel_statuses;

      DROP TABLE personnel_statuses;
      ALTER TABLE personnel_statuses_new RENAME TO personnel_statuses;

      CREATE INDEX IF NOT EXISTS idx_personnel_statuses_user_range ON personnel_statuses(user_id, effective_from, effective_to);
      CREATE INDEX IF NOT EXISTS idx_personnel_statuses_status ON personnel_statuses(status);
    `);
  }
};
