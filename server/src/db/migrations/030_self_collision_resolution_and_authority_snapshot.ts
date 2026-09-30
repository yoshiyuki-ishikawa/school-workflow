import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 030: Self-Collision Resolution and Authority Semantic Snapshot
 * 
 * 1. application_approval_steps テーブルへの新カラム追加:
 *    - resolution_reason: TEXT (NULL | 'SELF_COLLISION')
 *    - action_type: TEXT (NULL | 'REVIEW' | 'APPROVE' | 'DECIDE' | 'ORDER' | 'CHECK')
 *    - is_final_decision_step: INTEGER (NULL | 0 | 1)
 * 2. 検索用インデックスの追加:
 *    - idx_app_steps_cycle_order_status
 * 
 * ※ Historical Records の推測 Backfill は禁止 (action_type, is_final_decision_step は NULL のまま保全)
 */
export const migration030: Migration = {
  version: 30,
  name: 'self_collision_resolution_and_authority_snapshot',
  up: (db: Database) => {
    const stepCols = db.prepare('PRAGMA table_info(application_approval_steps)').all() as { name: string }[];
    const colNames = new Set(stepCols.map((c) => c.name));

    if (!colNames.has('resolution_reason')) {
      db.exec('ALTER TABLE application_approval_steps ADD COLUMN resolution_reason TEXT;');
    }
    if (!colNames.has('action_type')) {
      db.exec('ALTER TABLE application_approval_steps ADD COLUMN action_type TEXT;');
    }
    if (!colNames.has('is_final_decision_step')) {
      db.exec('ALTER TABLE application_approval_steps ADD COLUMN is_final_decision_step INTEGER;');
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_app_steps_cycle_order_status
      ON application_approval_steps(workflow_cycle_id, step_order, status);
    `);
  },
};
