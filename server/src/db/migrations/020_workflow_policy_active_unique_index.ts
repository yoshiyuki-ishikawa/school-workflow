import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 020: workflow_policy_versions に対する status='ACTIVE' Partial Unique Index 追加
 * 
 * 1. 同一 policy_id において status = 'ACTIVE' を持つレコードが最大 1 件であることを DB レベルで保証。
 * 2. 複数管理者の同時実行等による重複 ACTIVE 発生を完全防止。
 */
export const migration020: Migration = {
  version: 20,
  name: 'workflow_policy_active_unique_index',
  up: (db: Database) => {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_policy_versions_active_unique
      ON workflow_policy_versions(policy_id)
      WHERE status = 'ACTIVE';
    `);
  },
};
