import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 015: 確定時計算スナップショット & Idempotency 保証
 * 
 * 1. applications テーブルに final_calculation_snapshot カラムを追加
 * 2. leave_usages テーブルに calculation_snapshot カラムを追加
 * 3. leave_usages.application_id に UNIQUE インデックスを追加し、二重引当を物理防止
 */
export const migration015: Migration = {
  version: 15,
  name: 'leave_calculation_snapshot_and_idempotency',
  up: (db: Database) => {
    // 1. applications.final_calculation_snapshot カラム存在確認 & 追加
    const appCols = db.prepare('PRAGMA table_info(applications)').all() as { name: string }[];
    const appColNames = new Set(appCols.map((c) => c.name));
    if (!appColNames.has('final_calculation_snapshot')) {
      db.exec('ALTER TABLE applications ADD COLUMN final_calculation_snapshot TEXT');
    }

    // 2. leave_usages.calculation_snapshot カラム存在確認 & 追加
    const usageCols = db.prepare('PRAGMA table_info(leave_usages)').all() as { name: string }[];
    const usageColNames = new Set(usageCols.map((c) => c.name));
    if (!usageColNames.has('calculation_snapshot')) {
      db.exec('ALTER TABLE leave_usages ADD COLUMN calculation_snapshot TEXT');
    }

    // 3. UNIQUE インデックス作成 (二重引当・二重行使を物理防止)
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_leave_usages_application_unique 
        ON leave_usages(application_id);
    `);
  }
};
