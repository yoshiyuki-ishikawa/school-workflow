import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { WorkflowEngine, UserContext } from '../workflow/engine';

describe('Workflow Policy Lifecycle & Cycle Invariant Tests', () => {
  let db: any;

  beforeEach(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  const teacherActor: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎 (教員A)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
  };

  const vpActor: UserContext = {
    id: 3,
    username: 'vice_principal',
    displayName: '田中 誠 (教頭B)',
    roles: ['VICE_PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
  };

  it('INV-WORKFLOW-CYCLE-001: 新規申請提出時 - NEW_POLICY_ENGINE Cycle が生成され、Version/EvaluationAt/StartedBy が厳格に記録される', () => {
    const res = WorkflowEngine.submitApplication(
      teacherActor,
      {
        typeId: 'LEAVE_ANNUAL',
        title: '年次有給休暇申請',
        formData: {
          startDate: '2026-09-10',
          endDate: '2026-09-10',
          calculatedDays: 1,
          calculatedMinutes: 465,
          unitType: 'DAY',
          reason: '所用のため',
        },
      }
    );

    assert.strictEqual(res.success, true);
    const appId = res.data.id;

    const cycle = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 1').get(appId) as any;
    assert.ok(cycle);
    assert.strictEqual(cycle.workflow_source, 'NEW_POLICY_ENGINE');
    assert.strictEqual(cycle.workflow_policy_version_id, 'LEAVE_ANNUAL_STANDARD_V1');
    assert.ok(cycle.policy_evaluation_at);
    assert.strictEqual(cycle.started_by_user_id, teacherActor.id);
    assert.strictEqual(cycle.status, 'IN_PROGRESS');

    const steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND approval_cycle = 1 ORDER BY step_order ASC').all(appId) as any[];
    assert.strictEqual(steps.length, 2);
    assert.strictEqual(steps[0].workflow_cycle_id, cycle.id);
    assert.strictEqual(steps[0].status, 'PENDING');
    assert.strictEqual(steps[1].status, 'WAITING');
  });

  it('INV-WORKFLOW-CYCLE-002: 差戻し後再申請時 - Cycle 1 と Cycle 2 が独立分離し、旧スナップショットが改変されない', () => {
    // 1. 初回提出
    const submitRes = WorkflowEngine.submitApplication(
      teacherActor,
      {
        typeId: 'LEAVE_ANNUAL',
        title: '年次有給休暇申請',
        formData: {
          startDate: '2026-09-10',
          endDate: '2026-09-10',
          calculatedDays: 1,
          calculatedMinutes: 465,
          unitType: 'DAY',
          reason: '所用のため',
        },
      }
    );
    const appId = submitRes.data.id;

    // 2. 教頭が差戻し
    const returnRes = WorkflowEngine.returnApplication(
      vpActor,
      {
        applicationId: appId,
        expectedVersion: 1,
        comment: '理由を詳細に記載してください',
      }
    );
    assert.strictEqual(returnRes.success, true);

    const cycle1Before = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 1').get(appId) as any;
    const steps1Before = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND approval_cycle = 1 ORDER BY step_order ASC').all(appId) as any[];

    // 3. 再提出
    const resubmitRes = WorkflowEngine.resubmitApplication(
      teacherActor,
      {
        applicationId: appId,
        expectedVersion: 2,
        title: '年次有給休暇申請 (修正)',
        formData: {
          startDate: '2026-09-10',
          endDate: '2026-09-10',
          calculatedDays: 1,
          calculatedMinutes: 465,
          unitType: 'DAY',
          reason: '私用のため（家庭の事情）',
        },
      }
    );
    assert.strictEqual(resubmitRes.success, true);

    // 4. Cycle 1 と Cycle 2 の検証
    const cycle1After = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 1').get(appId) as any;
    const cycle2 = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 2').get(appId) as any;
    const steps1After = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND approval_cycle = 1 ORDER BY step_order ASC').all(appId) as any[];
    const steps2 = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND approval_cycle = 2 ORDER BY step_order ASC').all(appId) as any[];

    // Cycle 1 の完全不変性検証
    assert.deepStrictEqual(cycle1After, cycle1Before);
    assert.deepStrictEqual(steps1After, steps1Before);

    // Cycle 2 の生成検証
    assert.ok(cycle2);
    assert.strictEqual(cycle2.approval_cycle, 2);
    assert.strictEqual(cycle2.workflow_source, 'NEW_POLICY_ENGINE');
    assert.strictEqual(cycle2.workflow_policy_version_id, 'LEAVE_ANNUAL_STANDARD_V1');
    assert.strictEqual(steps2.length, 2);
    assert.strictEqual(steps2[0].workflow_cycle_id, cycle2.id);
    assert.strictEqual(steps2[0].status, 'PENDING');
  });

  it('INV-WORKFLOW-CYCLE-003: DB CHECK制約 - NEW_POLICY_ENGINE で policy_version_id 等が NULL の場合は DB レベルで遮断される', () => {
    // 外部キーを満たすための application を挿入
    const appRes = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, title, form_data, created_at, updated_at)
      VALUES ('LEAVE_ANNUAL', 1, 1, 'テスト申請', '{}', '2026-09-01', '2026-09-01')
    `).run();
    const testAppId = Number(appRes.lastInsertRowid);

    assert.throws(() => {
      db.prepare(`
        INSERT INTO application_workflow_cycles (
          application_id, approval_cycle, workflow_source, workflow_policy_version_id,
          policy_evaluation_at, status, started_at, started_by_user_id
        ) VALUES (?, 99, 'NEW_POLICY_ENGINE', NULL, '2026-09-01', 'IN_PROGRESS', '2026-09-01', 1)
      `).run(testAppId);
    }, /CHECK constraint failed/);
  });

  it('INV-WORKFLOW-CYCLE-004: DB CHECK制約 - LEGACY_SNAPSHOT は policy_version_id が NULL でも許可される', () => {
    const appRes = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, title, form_data, created_at, updated_at)
      VALUES ('LEAVE_ANNUAL', 1, 1, 'テスト申請2', '{}', '2026-09-01', '2026-09-01')
    `).run();
    const testAppId = Number(appRes.lastInsertRowid);

    assert.doesNotThrow(() => {
      db.prepare(`
        INSERT INTO application_workflow_cycles (
          application_id, approval_cycle, workflow_source, workflow_policy_version_id,
          policy_evaluation_at, status, started_at, started_by_user_id
        ) VALUES (?, 98, 'LEGACY_SNAPSHOT', NULL, NULL, 'APPROVED', '2026-01-01', NULL)
      `).run(testAppId);
    });
  });
});
