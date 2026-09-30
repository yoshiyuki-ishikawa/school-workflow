import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { resolveWorkflowPolicy, validatePolicyDraft } from '../workflow/policyResolver';
import { PolicyActivationService } from '../services/policyActivationService';

describe('Workflow Policy Resolver & Activation Tests', () => {
  let db: any;

  beforeEach(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  it('INV-WORKFLOW-POLICY-001: 正常系 - 有効なACTIVEポリシーが決定論的に1件解決される', () => {
    const res = resolveWorkflowPolicy({
      appTypeId: 'LEAVE_ANNUAL',
      evaluationTime: '2026-09-01T09:00:00Z',
      subjectUserId: 1, // teacher1
      submittedByUserId: 1,
    });

    assert.ok(res);
    assert.strictEqual(res.policyId, 'LEAVE_ANNUAL_STANDARD');
    assert.strictEqual(res.policyVersionId, 'LEAVE_ANNUAL_STANDARD_V1');
    assert.strictEqual(res.steps.length, 2);
    assert.strictEqual(res.steps[0].stepOrder, 1);
    assert.ok(res.steps[0].stepName.includes('教頭'));
    assert.strictEqual(res.steps[1].stepOrder, 2);
    assert.ok(res.steps[1].stepName.includes('校長'));
    assert.strictEqual(res.steps[1].actionType, 'ACK');
    assert.strictEqual(res.steps[1].isFinalDecisionStep, true);
  });

  it('INV-WORKFLOW-POLICY-002: 0件合致時 - WORKFLOW_POLICY_UNRESOLVED で Fail-Closed 拒絶される', () => {
    assert.throws(() => {
      resolveWorkflowPolicy({
        appTypeId: 'NON_EXISTENT_APP_TYPE',
        evaluationTime: '2026-09-01T09:00:00Z',
        subjectUserId: 1,
        submittedByUserId: 1,
      });
    }, (err: any) => err.errorCode === 'WORKFLOW_POLICY_UNRESOLVED');
  });

  it('INV-WORKFLOW-POLICY-003: 同一優先度のACTIVEポリシーが重複する場合 - WORKFLOW_POLICY_AMBIGUOUS で Fail-Closed 拒絶される', () => {
    // 標準ポリシー（Priority 200）と競合する優先度 200 のポリシーを追加
    db.prepare(`
      INSERT INTO workflow_policies (id, policy_key, policy_name, policy_source)
      VALUES ('LEAVE_CONFLICT', 'LEAVE_CONFLICT', '競合ポリシー', 'CUSTOM')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_application_types (policy_id, app_type_id)
      VALUES ('LEAVE_CONFLICT', 'LEAVE_ANNUAL')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('LEAVE_CONFLICT_V1', 'LEAVE_CONFLICT', 1, 'ACTIVE', 200, '2026-01-01', '9999-12-31', '{}')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES ('LEAVE_CONFLICT_V1', 1, '決裁', 'FINAL', 'DECIDE', 'PRINCIPAL', 'ROLE', 'PRINCIPAL', 1)
    `).run();

    assert.throws(() => {
      resolveWorkflowPolicy({
        appTypeId: 'LEAVE_ANNUAL',
        evaluationTime: '2026-09-01T09:00:00Z',
        subjectUserId: 1,
        submittedByUserId: 1,
      });
    }, (err: any) => err.errorCode === 'WORKFLOW_POLICY_AMBIGUOUS');
  });

  it('INV-WORKFLOW-POLICY-004: Priority による決定論的優先解決', () => {
    // 標準ポリシー（Priority 200）より高い優先度 300 の別ポリシーを追加
    db.prepare(`
      INSERT INTO workflow_policies (id, policy_key, policy_name, policy_source)
      VALUES ('LEAVE_HIGH_PRIORITY', 'LEAVE_HIGH_PRIORITY', '高優先度ポリシー', 'CUSTOM')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_application_types (policy_id, app_type_id)
      VALUES ('LEAVE_HIGH_PRIORITY', 'LEAVE_ANNUAL')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('LEAVE_HIGH_PRIORITY_V1', 'LEAVE_HIGH_PRIORITY', 1, 'ACTIVE', 300, '2026-01-01', '9999-12-31', '{}')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES ('LEAVE_HIGH_PRIORITY_V1', 1, '優先決裁', 'FINAL', 'DECIDE', 'PRINCIPAL', 'ROLE', 'PRINCIPAL', 1)
    `).run();

    const res = resolveWorkflowPolicy({
      appTypeId: 'LEAVE_ANNUAL',
      evaluationTime: '2026-09-01T09:00:00Z',
      subjectUserId: 1,
      submittedByUserId: 1,
    });

    assert.strictEqual(res.policyId, 'LEAVE_HIGH_PRIORITY');
    assert.strictEqual(res.priority, 300);
  });

  it('INV-WORKFLOW-POLICY-005: 最終決裁ステップが 0 件 または 2 件以上の場合はバリデーションで拒絶される', () => {
    const v0 = validatePolicyDraft({
      steps: [
        { stepOrder: 1, stepName: '確認1', actionType: 'APPROVE', requiredRoleId: 'TEACHER', selectorType: 'ROLE', selectorValue: 'TEACHER', isFinalDecisionStep: false },
      ],
    });
    assert.strictEqual(v0.valid, false);
    assert.strictEqual(v0.errorCode, 'FINAL_DECISION_STEP_INVALID');

    const v2 = validatePolicyDraft({
      steps: [
        { stepOrder: 1, stepName: '決裁1', actionType: 'DECIDE', requiredRoleId: 'PRINCIPAL', selectorType: 'ROLE', selectorValue: 'PRINCIPAL', isFinalDecisionStep: true },
        { stepOrder: 2, stepName: '決裁2', actionType: 'DECIDE', requiredRoleId: 'PRINCIPAL', selectorType: 'ROLE', selectorValue: 'PRINCIPAL', isFinalDecisionStep: true },
      ],
    });
    assert.strictEqual(v2.valid, false);
    assert.strictEqual(v2.errorCode, 'FINAL_DECISION_STEP_INVALID');
  });

  it('INV-WORKFLOW-POLICY-006: 自己決裁（HD-02）防止ガード - 申請者本人が最終決裁者の場合、提出時に422 (FINAL_AUTHORITY_SELF_COLLISION) で厳格遮断される', () => {
    // 校長 (userId: 4) が病休（DECIDE終端）を申請する場合、Step 2 (校長決裁) で最終決裁者自己衝突となる
    const res = resolveWorkflowPolicy({
      appTypeId: 'LEAVE_SICK',
      evaluationTime: '2026-09-01T09:00:00Z',
      subjectUserId: 4, // principal
      submittedByUserId: 4,
    });
    assert.strictEqual(res.steps.length, 2);
    assert.strictEqual(res.steps[1].approverUserId, 4);

    // Engine側での提出実行時に 422 (FINAL_AUTHORITY_SELF_COLLISION) でFail-Closed遮断される (HD-02)
    const principalUser = { id: 4, username: 'principal', displayName: '鈴木 健一 (校長C)', roles: ['PRINCIPAL', 'TEACHER'], ipAddress: '127.0.0.1' };
    const { WorkflowEngine } = require('../workflow/engine');
    const submitRes = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'LEAVE_SICK',
      title: '校長自己申請(病休)',
      formData: {
        startDate: '2026-09-01',
        endDate: '2026-09-01',
        calculatedDays: 1,
        reason: '急性気管支炎による療養',
        medicalCertificateAttached: false,
      },
    });
    assert.strictEqual(submitRes.success, false);
    assert.strictEqual(submitRes.statusCode, 422);
    assert.strictEqual(submitRes.errorCode, 'FINAL_AUTHORITY_SELF_COLLISION');
  });

  it('INV-WORKFLOW-POLICY-007: PolicyActivationService - Atomic な v1 → v2 切替と過去バージョンの退役 (retired_at記録)', () => {
    // LEAVE_STANDARD の DRAFT v2 を作成
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('LEAVE_STANDARD_V2', 'LEAVE_STANDARD', 2, 'DRAFT', 100, '2026-09-01', '9999-12-31', '{}')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES
        ('LEAVE_STANDARD_V2', 1, '教頭確認v2', 'VP_REVIEW', 'REVIEW', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0),
        ('LEAVE_STANDARD_V2', 2, '校長決裁v2', 'PRINCIPAL_DECIDE', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();

    const actor = {
      id: 6,
      username: 'admin',
      displayName: 'システム管理者',
      roles: ['ADMIN'],
      ipAddress: '127.0.0.1',
    };

    const result = PolicyActivationService.activateVersion({
      actor,
      versionId: 'LEAVE_STANDARD_V2',
    });

    assert.strictEqual(result.success, true);

    const v1 = db.prepare('SELECT * FROM workflow_policy_versions WHERE id = ?').get('LEAVE_STANDARD_V1') as any;
    const v2 = db.prepare('SELECT * FROM workflow_policy_versions WHERE id = ?').get('LEAVE_STANDARD_V2') as any;

    assert.strictEqual(v1.status, 'INACTIVE');
    assert.ok(v1.retired_at);
    assert.strictEqual(v2.status, 'ACTIVE');
  });
});
