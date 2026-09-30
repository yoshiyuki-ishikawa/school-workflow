import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 016: 差戻し後の再申請（Resubmit）における承認ステップ履歴不変保持対応
 * 
 * 1. application_approval_steps テーブルに approval_cycle カラムを追加 (デフォルト: 1)
 * 2. application_id, approval_cycle のインデックスを作成
 */
export const migration016: Migration = {
  version: 16,
  name: 'approval_cycle_and_resubmit_support',
  up: (db: Database) => {
    // 1. approval_cycle カラム存在確認 & 追加
    const stepCols = db.prepare('PRAGMA table_info(application_approval_steps)').all() as { name: string }[];
    const stepColNames = new Set(stepCols.map((c) => c.name));
    if (!stepColNames.has('approval_cycle')) {
      db.exec('ALTER TABLE application_approval_steps ADD COLUMN approval_cycle INTEGER NOT NULL DEFAULT 1');
    }

    // 2. インデックス作成 (Cycleごとのステップ高速検索 & 整合性保証)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_approval_steps_app_cycle 
        ON application_approval_steps(application_id, approval_cycle);
    `);
  }
};
