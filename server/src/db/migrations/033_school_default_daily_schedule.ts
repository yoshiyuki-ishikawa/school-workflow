import { Database as DatabaseType } from 'better-sqlite3';
import { Migration } from './migrator';

export const migration033: Migration = {
  version: 33,
  name: '033_school_default_daily_schedule',
  up: (db: DatabaseType) => {
    // 1. 学校標準日課テーブル作成 (Single-School Scope, Effective-Dated, workIntervals Canonical)
    db.exec(`
      CREATE TABLE IF NOT EXISTS school_work_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_name TEXT NOT NULL,
        effective_from TEXT NOT NULL,
        effective_to TEXT NOT NULL,
        weekly_off_days TEXT NOT NULL DEFAULT '0,6',
        schedule_details_json TEXT NOT NULL,
        weekly_total_minutes INTEGER NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_by_user_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        updated_by_user_id INTEGER,
        updated_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        FOREIGN KEY (created_by_user_id) REFERENCES users(id),
        FOREIGN KEY (updated_by_user_id) REFERENCES users(id),
        CHECK (effective_from <= effective_to)
      );

      CREATE INDEX IF NOT EXISTS idx_school_work_schedules_effective
        ON school_work_schedules(effective_from, effective_to);

      CREATE INDEX IF NOT EXISTS idx_school_work_schedules_active
        ON school_work_schedules(is_active);
    `);

    // 2. user_work_patterns に schedule_source カラムを追加
    const uwpCols = db.prepare('PRAGMA table_info(user_work_patterns)').all() as { name: string }[];
    const uwpColNames = new Set(uwpCols.map((c) => c.name));
    if (!uwpColNames.has('schedule_source')) {
      db.exec(`
        ALTER TABLE user_work_patterns
        ADD COLUMN schedule_source TEXT DEFAULT 'INDIVIDUAL' CHECK(
          schedule_source IS NULL OR schedule_source IN ('SCHOOL_DEFAULT', 'INDIVIDUAL')
        );
      `);
    }

    // 3. Zero-Guess Backfill: 既存の全行を 'INDIVIDUAL' として確定保全
    // (推測による学校標準化を完全排除し、現行のRuntime Semanticを100%維持)
    db.exec(`
      UPDATE user_work_patterns
      SET schedule_source = 'INDIVIDUAL'
      WHERE schedule_source IS NULL;
    `);
  }
};
