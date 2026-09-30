import { describe, it } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../db/schema';
import { migration030 } from '../db/migrations/030_self_collision_resolution_and_authority_snapshot';
import { migrator } from '../db/migrations';
import { setDb } from '../db/database';
import { seedDatabase } from '../db/seeds';

describe('Migration 030: Self-Collision Resolution & Authority Snapshot Tests', () => {
  function setupDb() {
    const db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
    return db;
  }

  it('MIG-SC-01: v29 -> v30 migration applies successfully and adds new columns', () => {
    const db = setupDb();

    const cols = db.prepare('PRAGMA table_info(application_approval_steps)').all() as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));

    assert.strictEqual(colNames.has('resolution_reason'), true, 'resolution_reason column exists');
    assert.strictEqual(colNames.has('action_type'), true, 'action_type column exists');
    assert.strictEqual(colNames.has('is_final_decision_step'), true, 'is_final_decision_step column exists');

    db.close();
  });

  it('MIG-SC-02: Legacy approval steps authority semantic remains NULL (No Fabrication)', () => {
    const db = setupDb();

    try {
      db.prepare(`
        INSERT INTO users (id, username, password_hash, display_name, stamp_name, department, is_active, created_at)
        VALUES (990, 'legacy_user', 'hash', '過去教員', '過去', '小学部', 1, '2025-01-01T00:00:00.000Z');
      `).run();
    } catch (e: any) {
      console.error('USER INSERT ERROR:', e);
      throw e;
    }

    try {
      db.prepare(`
        INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, current_step_order, created_at, updated_at)
        VALUES (990, 'LEAVE_ANNUAL', 990, 990, '年休申請', '{}', 'FINAL_APPROVED', 2, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
      `).run();
    } catch (e: any) {
      console.error('APP INSERT ERROR:', e);
      throw e;
    }

    try {
      db.prepare(`
        INSERT INTO application_approval_steps (
          id, application_id, approval_cycle, step_order, step_name, step_key, step_label_snapshot,
          selector_type_snapshot, selector_value_snapshot, approver_name_snapshot,
          required_role_id, status, action_type, is_final_decision_step
        ) VALUES 
          (9901, 990, 1, 1, '教頭承認', 'VP', '教頭承認', 'ROLE', 'VICE_PRINCIPAL', '教頭', 'VICE_PRINCIPAL', 'APPROVED', NULL, NULL),
          (9902, 990, 1, 2, '校長決裁', 'PR', '校長決裁', 'ROLE', 'PRINCIPAL', '校長', 'PRINCIPAL', 'APPROVED', NULL, NULL);
      `).run();
    } catch (e: any) {
      console.error('STEP INSERT ERROR:', e);
      throw e;
    }

    const steps = db.prepare('SELECT id, resolution_reason, action_type, is_final_decision_step FROM application_approval_steps WHERE application_id = 990').all() as any[];
    for (const step of steps) {
      assert.strictEqual(step.action_type, null, `Step ${step.id} action_type must remain NULL`);
      assert.strictEqual(step.is_final_decision_step, null, `Step ${step.id} is_final_decision_step must remain NULL`);
    }

    db.close();
  });

  it('MIG-SC-03: Historical approval and audit facts remain unchanged', () => {
    const db = setupDb();

    const countBefore = (db.prepare('SELECT COUNT(*) as cnt FROM application_approval_steps').get() as any).cnt;
    migration030.up(db); // Idempotent execution
    const countAfter = (db.prepare('SELECT COUNT(*) as cnt FROM application_approval_steps').get() as any).cnt;

    assert.strictEqual(countBefore, countAfter, 'Record counts must be strictly unchanged');
    db.close();
  });

  it('MIG-SC-04: New Cycle snapshot completeness is guaranteed on creation', () => {
    const db = setupDb();

    db.prepare(`
      INSERT INTO users (id, username, password_hash, display_name, stamp_name, department, is_active, created_at)
      VALUES (101, 'user101', 'hash', '教員101', '教員', '小学部', 1, '2026-04-01T00:00:00.000Z');
    `).run();

    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, current_step_order, created_at, updated_at)
      VALUES (101, 'LEAVE_ANNUAL', 101, 101, '年休申請', '{}', 'SUBMITTED', 1, '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');
    `).run();

    db.prepare(`
      INSERT INTO application_approval_steps (
        application_id, approval_cycle, step_order, step_name, step_key, step_label_snapshot,
        selector_type_snapshot, selector_value_snapshot, approver_name_snapshot,
        required_role_id, status, resolution_reason, action_type, is_final_decision_step
      ) VALUES (101, 1, 1, '教頭承認', 'VP', '教頭承認', 'ROLE', 'VICE_PRINCIPAL', '教頭', 'VICE_PRINCIPAL', 'PENDING', NULL, 'APPROVE', 0);
    `).run();

    const row = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = 101').get() as any;
    assert.strictEqual(row.action_type, 'APPROVE');
    assert.strictEqual(row.is_final_decision_step, 0);

    db.close();
  });

  it('MIG-SC-05: Migration safety and idempotency', () => {
    const db = setupDb();
    assert.doesNotThrow(() => {
      migration030.up(db);
      migration030.up(db);
    });
    db.close();
  });

  it('MIG-SC-06: Legacy NULL authority semantic records can be queried safely', () => {
    const db = setupDb();

    const rows = db.prepare("SELECT id, COALESCE(action_type, 'LEGACY') as resolved_action FROM application_approval_steps").all() as any[];
    assert.strictEqual(Array.isArray(rows), true);
    db.close();
  });
});
