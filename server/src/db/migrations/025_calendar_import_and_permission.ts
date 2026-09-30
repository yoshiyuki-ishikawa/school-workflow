import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 025: Original Wave 5 (GAP-05: 学校年間カレンダー一括インポート・勤務カレンダーFact基盤)
 * 
 * 1. calendar.manage パーミッションの追加とロール割当 (PRINCIPAL, VICE_PRINCIPAL, OFFICE, ADMIN)
 * 2. calendar_import_batches テーブル新設 (成功インポートバッチの単一真実源 SSOT)
 * 3. calendar_adjustments テーブルへの Import Provenance カラム追加
 *    - import_batch_id: 投入元バッチID
 *    - record_origin: レコード生成元 ('MANUAL' | 'CSV_IMPORT' | 'MIGRATION')
 *    - superseded_by_adjustment_id: 後続の置換調整ID
 * 4. custom_holidays テーブルへの Import Provenance カラム追加
 *    - import_batch_id: 投入元バッチID
 *    - record_origin: レコード生成元 ('MANUAL' | 'CSV_IMPORT' | 'SYSTEM_INITIAL')
 */
export const migration025: Migration = {
  version: 25,
  name: 'calendar_import_and_permission',
  up: (db: Database) => {
    // 1. permissions & role_permissions
    const insertPerm = db.prepare('INSERT OR IGNORE INTO permissions (id, description) VALUES (?, ?)');
    insertPerm.run('calendar.manage', '学校年間カレンダー・勤務調整・学校休日の管理および一括インポート権限');

    const insertRolePerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
    insertRolePerm.run('PRINCIPAL', 'calendar.manage');
    insertRolePerm.run('VICE_PRINCIPAL', 'calendar.manage');
    insertRolePerm.run('OFFICE', 'calendar.manage');
    insertRolePerm.run('ADMIN', 'calendar.manage');

    // 2. calendar_import_batches
    db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_import_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_code TEXT NOT NULL UNIQUE,
        fiscal_year INTEGER NOT NULL,
        imported_by_user_id INTEGER NOT NULL REFERENCES users(id),
        file_name TEXT NOT NULL,
        file_sha256 TEXT NOT NULL,
        total_rows INTEGER NOT NULL,
        applied_adjustments_count INTEGER NOT NULL,
        applied_custom_holidays_count INTEGER NOT NULL,
        superseded_adjustments_count INTEGER NOT NULL DEFAULT 0,
        superseded_custom_holidays_count INTEGER NOT NULL DEFAULT 0,
        commit_comment TEXT,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_cal_import_batches_fy ON calendar_import_batches(fiscal_year);
      CREATE INDEX IF NOT EXISTS idx_cal_import_batches_hash ON calendar_import_batches(file_sha256);
    `);

    // 3. calendar_adjustments table alteration
    const adjCols = db.prepare('PRAGMA table_info(calendar_adjustments)').all() as { name: string }[];
    const adjColNames = new Set(adjCols.map((c) => c.name));

    if (!adjColNames.has('import_batch_id')) {
      db.exec('ALTER TABLE calendar_adjustments ADD COLUMN import_batch_id INTEGER REFERENCES calendar_import_batches(id);');
    }
    if (!adjColNames.has('record_origin')) {
      db.exec("ALTER TABLE calendar_adjustments ADD COLUMN record_origin TEXT NOT NULL DEFAULT 'MANUAL' CHECK(record_origin IN ('MANUAL', 'CSV_IMPORT', 'MIGRATION'));");
    }
    if (!adjColNames.has('superseded_by_adjustment_id')) {
      db.exec('ALTER TABLE calendar_adjustments ADD COLUMN superseded_by_adjustment_id INTEGER REFERENCES calendar_adjustments(id);');
    }

    // 4. custom_holidays table alteration
    const holCols = db.prepare('PRAGMA table_info(custom_holidays)').all() as { name: string }[];
    const holColNames = new Set(holCols.map((c) => c.name));

    if (!holColNames.has('import_batch_id')) {
      db.exec('ALTER TABLE custom_holidays ADD COLUMN import_batch_id INTEGER REFERENCES calendar_import_batches(id);');
    }
    if (!holColNames.has('record_origin')) {
      db.exec("ALTER TABLE custom_holidays ADD COLUMN record_origin TEXT NOT NULL DEFAULT 'MANUAL' CHECK(record_origin IN ('MANUAL', 'CSV_IMPORT', 'SYSTEM_INITIAL'));");
    }
  }
};
