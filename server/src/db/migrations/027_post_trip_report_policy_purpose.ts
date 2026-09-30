import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 027: 出張復命（POST-TRIP）ワークフローの Policy-Driven 化＆ Cycle 分離
 * 
 * 1. workflow_policies テーブル再構築 (Explicit Column Mapping):
 *    - policy_purpose CHECK 制約拡張 ('APPROVAL', 'CANCELLATION', 'POST_TRIP_REPORT')
 * 2. application_workflow_cycles テーブル再構築 (Explicit Column Mapping):
 *    - cycle_purpose CHECK 制約拡張 ('APPROVAL', 'RESUBMISSION', 'CANCELLATION', 'POST_TRIP_REPORT')
 *    - Index 再構築 (idx_awc_app_cycle)
 * 3. PR-08: Granular Idempotent Bootstrap:
 *    - TRIP_REPORT_STANDARD ポリシー、バインディング、Version、3段階Steps (教頭確認→校長決裁→事務係確認) を投入
 */
export const migration027: Migration = {
  version: 27,
  name: 'post_trip_report_policy_purpose',
  up: (db: Database) => {
    // 1. workflow_policies Table Rebuild (Explicit Column Mapping)
    db.exec(`
      CREATE TABLE workflow_policies_new (
        id TEXT PRIMARY KEY,
        policy_key TEXT NOT NULL UNIQUE,
        policy_name TEXT NOT NULL,
        description TEXT,
        policy_purpose TEXT NOT NULL DEFAULT 'APPROVAL' CHECK (policy_purpose IN ('APPROVAL', 'CANCELLATION', 'POST_TRIP_REPORT')),
        policy_source TEXT NOT NULL DEFAULT 'SYSTEM' CHECK (policy_source IN ('LEGACY_MIGRATED', 'TEMPLATE', 'CUSTOM', 'SYSTEM')),
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        created_by_user_id INTEGER REFERENCES users(id)
      );

      INSERT INTO workflow_policies_new (
        id, policy_key, policy_name, description, policy_purpose, policy_source, created_at, created_by_user_id
      )
      SELECT
        id, policy_key, policy_name, description, policy_purpose, policy_source, created_at, created_by_user_id
      FROM workflow_policies;

      DROP TABLE workflow_policies;
      ALTER TABLE workflow_policies_new RENAME TO workflow_policies;
    `);

    // 2. application_workflow_cycles Table Rebuild (Explicit Column Mapping)
    db.exec(`
      CREATE TABLE application_workflow_cycles_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        approval_cycle INTEGER NOT NULL,
        cycle_purpose TEXT NOT NULL DEFAULT 'APPROVAL' CHECK (cycle_purpose IN ('APPROVAL', 'RESUBMISSION', 'CANCELLATION', 'POST_TRIP_REPORT')),
        workflow_source TEXT NOT NULL DEFAULT 'NEW_POLICY_ENGINE' CHECK (workflow_source IN ('NEW_POLICY_ENGINE', 'LEGACY_SNAPSHOT')),
        workflow_policy_version_id TEXT REFERENCES workflow_policy_versions(id),
        policy_evaluation_at TEXT,
        status TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS', 'APPROVED', 'RETURNED', 'REJECTED', 'WITHDRAWN')),
        cancellation_reason TEXT,
        started_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        started_by_user_id INTEGER REFERENCES users(id),
        ended_at TEXT,
        return_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        UNIQUE(application_id, approval_cycle),
        CHECK (
          (workflow_source = 'NEW_POLICY_ENGINE' AND workflow_policy_version_id IS NOT NULL AND policy_evaluation_at IS NOT NULL AND started_by_user_id IS NOT NULL)
          OR
          (workflow_source = 'LEGACY_SNAPSHOT')
        )
      );

      INSERT INTO application_workflow_cycles_new (
        id, application_id, approval_cycle, cycle_purpose, workflow_source,
        workflow_policy_version_id, policy_evaluation_at, status, cancellation_reason,
        started_at, started_by_user_id, ended_at, return_reason, created_at
      )
      SELECT
        id, application_id, approval_cycle, cycle_purpose, workflow_source,
        workflow_policy_version_id, policy_evaluation_at, status, cancellation_reason,
        started_at, started_by_user_id, ended_at, return_reason, created_at
      FROM application_workflow_cycles;

      DROP TABLE application_workflow_cycles;
      ALTER TABLE application_workflow_cycles_new RENAME TO application_workflow_cycles;
      CREATE INDEX IF NOT EXISTS idx_awc_app_cycle ON application_workflow_cycles(application_id, approval_cycle);
    `);

    // 3. PR-08: Granular Idempotent Bootstrap
    db.prepare(`
      INSERT OR IGNORE INTO workflow_policies (id, policy_key, policy_name, description, policy_purpose, policy_source)
      VALUES ('TRIP_REPORT_STANDARD', 'TRIP_REPORT_STANDARD', '標準出張復命承認ポリシー (3段階)', '出張復命書の3段階決裁フロー (教頭確認→校長決裁→事務係確認)', 'POST_TRIP_REPORT', 'SYSTEM')
    `).run();

    const hasBusinessTrip = db.prepare("SELECT 1 FROM application_types WHERE id = 'BUSINESS_TRIP'").get();
    if (hasBusinessTrip) {
      db.prepare(`
        INSERT OR IGNORE INTO workflow_policy_application_types (policy_id, app_type_id)
        VALUES ('TRIP_REPORT_STANDARD', 'BUSINESS_TRIP')
      `).run();
    }

    db.prepare(`
      INSERT OR IGNORE INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('TRIP_REPORT_STANDARD_V1', 'TRIP_REPORT_STANDARD', 1, 'ACTIVE', 200, '2000-01-01', '9999-12-31', '{}')
    `).run();

    const insertStep = db.prepare(`
      INSERT OR IGNORE INTO workflow_policy_steps (
        policy_version_id, step_order, step_name, step_key, action_type,
        required_role_id, selector_type, selector_value, is_final_decision_step
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStep.run('TRIP_REPORT_STANDARD_V1', 1, '復命 教頭確認', 'VP_REPORT_STEP', 'APPROVE', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0);
    insertStep.run('TRIP_REPORT_STANDARD_V1', 2, '復命 校長決裁', 'PRINCIPAL_REPORT_STEP', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1);
    insertStep.run('TRIP_REPORT_STANDARD_V1', 3, '復命 事務係確認', 'OFFICE_REPORT_STEP', 'CHECK', 'OFFICE', 'POSITION', 'OFFICE_HEAD', 0);
  },
};
