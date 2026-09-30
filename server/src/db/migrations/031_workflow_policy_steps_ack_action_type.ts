import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 031: workflow_policy_steps action_type CHECK 制約への 'ACK' 追加
 * 
 * 1. workflow_policy_steps テーブルの CHECK 制約に 'ACK' を追加
 *    - action_type: 'REVIEW' | 'APPROVE' | 'DECIDE' | 'ORDER' | 'CHECK' | 'ACK'
 * 2. SQLite Safe Table Recreation (外部キー・インデックス・既存データ完全維持)
 * 3. 既存データの改変・変換は一切行わない (CHECK 含む全レコードの完全継承)
 */
export const migration031: Migration = {
  version: 31,
  name: 'workflow_policy_steps_ack_action_type',
  up: (db: Database) => {
    // 外部キー制約を一時的に無効化して安全にテーブルを再作成
    db.pragma('foreign_keys = OFF');

    db.exec(`
      CREATE TABLE workflow_policy_steps_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        policy_version_id TEXT NOT NULL REFERENCES workflow_policy_versions(id) ON DELETE RESTRICT,
        step_order INTEGER NOT NULL,
        step_name TEXT NOT NULL,
        step_key TEXT NOT NULL,
        action_type TEXT NOT NULL DEFAULT 'APPROVE' CHECK (action_type IN ('REVIEW', 'APPROVE', 'DECIDE', 'ORDER', 'CHECK', 'ACK')),
        required_role_id TEXT NOT NULL REFERENCES roles(id),
        selector_type TEXT NOT NULL DEFAULT 'POSITION' CHECK (selector_type IN ('POSITION', 'ROLE')),
        selector_value TEXT NOT NULL,
        is_final_decision_step INTEGER NOT NULL DEFAULT 0 CHECK (is_final_decision_step IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        UNIQUE(policy_version_id, step_order),
        UNIQUE(policy_version_id, step_key)
      );

      INSERT INTO workflow_policy_steps_new (
        id, policy_version_id, step_order, step_name, step_key,
        action_type, required_role_id, selector_type, selector_value,
        is_final_decision_step, created_at
      )
      SELECT
        id, policy_version_id, step_order, step_name, step_key,
        action_type, required_role_id, selector_type, selector_value,
        is_final_decision_step, created_at
      FROM workflow_policy_steps;

      DROP TABLE workflow_policy_steps;

      ALTER TABLE workflow_policy_steps_new RENAME TO workflow_policy_steps;

      CREATE INDEX IF NOT EXISTS idx_wps_version ON workflow_policy_steps(policy_version_id);
    `);

    db.pragma('foreign_keys = ON');
  },
};
