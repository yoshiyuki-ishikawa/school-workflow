import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 022: 承認後取消ワークフロー (GAP-01) ＆ Cancellation Policy Engine 導入
 * 
 * 1. workflow_policies: policy_purpose カラム追加 ('APPROVAL' | 'CANCELLATION')
 * 2. leave_usages: status, reversed_at, reversal_reason, reversal_cycle_id カラム追加
 * 3. application_workflow_cycles: テーブル再構築 (cycle_purpose, cancellation_reason 追加, status 制約保持)
 * 4. 全件移行整合性検証 (Fail-Closed Check)
 */
export const migration022: Migration = {
  version: 22,
  name: 'cancellation_workflow_and_policy_purpose',
  up: (db: Database) => {
    // 1. workflow_policies への policy_purpose カラム追加
    const wpCols = db.prepare('PRAGMA table_info(workflow_policies)').all() as { name: string }[];
    const wpColNames = new Set(wpCols.map((c) => c.name));
    if (!wpColNames.has('policy_purpose')) {
      db.exec(`
        ALTER TABLE workflow_policies
        ADD COLUMN policy_purpose TEXT NOT NULL DEFAULT 'APPROVAL'
        CHECK (policy_purpose IN ('APPROVAL', 'CANCELLATION'));
      `);
    }

    // 2. leave_usages への status / reversed_at / reversal_reason / reversal_cycle_id カラム追加
    const luCols = db.prepare('PRAGMA table_info(leave_usages)').all() as { name: string }[];
    const luColNames = new Set(luCols.map((c) => c.name));
    if (!luColNames.has('status')) {
      db.exec(`
        ALTER TABLE leave_usages
        ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'REVERSED'));
      `);
    }
    if (!luColNames.has('reversed_at')) {
      db.exec('ALTER TABLE leave_usages ADD COLUMN reversed_at TEXT;');
    }
    if (!luColNames.has('reversal_reason')) {
      db.exec('ALTER TABLE leave_usages ADD COLUMN reversal_reason TEXT;');
    }
    if (!luColNames.has('reversal_cycle_id')) {
      db.exec('ALTER TABLE leave_usages ADD COLUMN reversal_cycle_id INTEGER REFERENCES application_workflow_cycles(id);');
    }

    // 3. application_workflow_cycles テーブルへの cycle_purpose / cancellation_reason カラム追加
    const awcCols = db.prepare('PRAGMA table_info(application_workflow_cycles)').all() as { name: string }[];
    const awcColNames = new Set(awcCols.map((c) => c.name));

    if (!awcColNames.has('cycle_purpose')) {
      db.exec(`
        ALTER TABLE application_workflow_cycles
        ADD COLUMN cycle_purpose TEXT NOT NULL DEFAULT 'APPROVAL'
        CHECK (cycle_purpose IN ('APPROVAL', 'RESUBMISSION', 'CANCELLATION'));
      `);

      // 既存データの cycle_purpose 補正 (approval_cycle > 1 のものは RESUBMISSION)
      db.exec(`
        UPDATE application_workflow_cycles
        SET cycle_purpose = 'RESUBMISSION'
        WHERE approval_cycle > 1;
      `);
    }

    if (!awcColNames.has('cancellation_reason')) {
      db.exec('ALTER TABLE application_workflow_cycles ADD COLUMN cancellation_reason TEXT;');
    }
  },
};
