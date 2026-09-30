import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { PolicyActivationService } from '../services/policyActivationService';
import { resolveWorkflowPolicy } from '../workflow/policyResolver';
import { WorkflowEngine } from '../workflow/engine';
import { UserContext } from '../types';
import * as serverTimeModule from '../utils/serverTime';

describe('Workflow Policy Revision & Activation Admin Tests', () => {
  let db: any;

  const adminUser: UserContext = {
    id: 6,
    username: 'admin',
    displayName: 'システム管理者E',
    roles: ['ADMIN'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const teacher1: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎 (教員A)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const vpUser: UserContext = {
    id: 3,
    username: 'vice_principal',
    displayName: '田中 誠 (教頭B)',
    roles: ['VICE_PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const principalUser: UserContext = {
    id: 4,
    username: 'principal',
    displayName: '鈴木 健一 (校長C)',
    roles: ['PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const chiefTeacherUser: UserContext = {
    id: 7,
    username: 'chief_teacher',
    displayName: '小林 繁 (教務主任)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  beforeEach(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  it('INV-ADM-001: 最終決裁ステップが 0 件 または 2 件以上の DRAFT は Activation 時に 422 で拒絶される', () => {
    // 0件のケース
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('LEAVE_STANDARD_V_NO_FINAL', 'LEAVE_STANDARD', 991, 'DRAFT', 100, '2026-04-01', '9999-12-31', '{}')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES ('LEAVE_STANDARD_V_NO_FINAL', 1, '教頭確認', 'VP_STEP', 'REVIEW', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0)
    `).run();

    const res1 = PolicyActivationService.activateVersion({
      actor: adminUser,
      versionId: 'LEAVE_STANDARD_V_NO_FINAL',
    });
    assert.strictEqual(res1.success, false);
    assert.strictEqual(res1.statusCode, 422);
    assert.strictEqual(res1.errorCode, 'WORKFLOW_FINAL_DECISION_INVALID');

    // 2件のケース
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('LEAVE_STANDARD_V_TWO_FINAL', 'LEAVE_STANDARD', 992, 'DRAFT', 100, '2026-04-01', '9999-12-31', '{}')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES 
        ('LEAVE_STANDARD_V_TWO_FINAL', 1, '教頭決裁', 'VP_DECIDE', 'DECIDE', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 1),
        ('LEAVE_STANDARD_V_TWO_FINAL', 2, '校長決裁', 'PRIN_DECIDE', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();

    const res2 = PolicyActivationService.activateVersion({
      actor: adminUser,
      versionId: 'LEAVE_STANDARD_V_TWO_FINAL',
    });
    assert.strictEqual(res2.success, false);
    assert.strictEqual(res2.statusCode, 422);
    assert.strictEqual(res2.errorCode, 'WORKFLOW_FINAL_DECISION_INVALID');
  });

  it('INV-ADM-002: step_order に重複や飛び番がある DRAFT は Activation 時に 422 で拒絶される', () => {
    // 飛び番 (1, 3)
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('LEAVE_STANDARD_V_GAP_ORDER', 'LEAVE_STANDARD', 993, 'DRAFT', 100, '2026-04-01', '9999-12-31', '{}')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES 
        ('LEAVE_STANDARD_V_GAP_ORDER', 1, '教頭確認', 'VP_STEP', 'REVIEW', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0),
        ('LEAVE_STANDARD_V_GAP_ORDER', 3, '校長決裁', 'PRIN_STEP', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();

    const res = PolicyActivationService.activateVersion({
      actor: adminUser,
      versionId: 'LEAVE_STANDARD_V_GAP_ORDER',
    });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(res.errorCode, 'WORKFLOW_STEP_ORDER_INVALID');
  });

  it('INV-ADM-003: 存在しない Canonical Position コードを含むステップは Activation 時に 422 で拒絶される', () => {
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('LEAVE_STANDARD_V_BAD_POS', 'LEAVE_STANDARD', 994, 'DRAFT', 100, '2026-04-01', '9999-12-31', '{}')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES 
        ('LEAVE_STANDARD_V_BAD_POS', 1, '謎の役職確認', 'MYSTERY_STEP', 'REVIEW', 'VICE_PRINCIPAL', 'POSITION', 'UNKNOWN_POSITION_CODE', 0),
        ('LEAVE_STANDARD_V_BAD_POS', 2, '校長決裁', 'PRIN_STEP', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();

    const res = PolicyActivationService.activateVersion({
      actor: adminUser,
      versionId: 'LEAVE_STANDARD_V_BAD_POS',
    });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(res.errorCode, 'WORKFLOW_POSITION_INVALID');
  });

  it('INV-ADM-004: ACTIVE または INACTIVE 状態のバージョンに対する有効化試行は 422 で拒絶される (完全不変性)', () => {
    // 既存 ACTIVE バージョン
    const resActive = PolicyActivationService.activateVersion({
      actor: adminUser,
      versionId: 'LEAVE_STANDARD_V1',
    });
    assert.strictEqual(resActive.success, false);
    assert.strictEqual(resActive.statusCode, 422);
    assert.strictEqual(resActive.errorCode, 'WORKFLOW_POLICY_VERSION_NOT_DRAFT');

    // INACTIVE バージョン
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('LEAVE_STANDARD_V_INACTIVE', 'LEAVE_STANDARD', 995, 'INACTIVE', 100, '2026-04-01', '9999-12-31', '{}')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES 
        ('LEAVE_STANDARD_V_INACTIVE', 1, '教頭確認', 'VP_STEP', 'REVIEW', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0),
        ('LEAVE_STANDARD_V_INACTIVE', 2, '校長決裁', 'PRIN_STEP', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();

    const resInactive = PolicyActivationService.activateVersion({
      actor: adminUser,
      versionId: 'LEAVE_STANDARD_V_INACTIVE',
    });
    assert.strictEqual(resInactive.success, false);
    assert.strictEqual(resInactive.statusCode, 422);
    assert.strictEqual(resInactive.errorCode, 'WORKFLOW_POLICY_VERSION_NOT_DRAFT');
  });

  it('TEST-1: Future Effective Date - 未来日開始の DRAFT は Activation 時に 422 で拒絶され、期日到来後に有効化できる', () => {
    const today = serverTimeModule.getCanonicalBusinessDate();
    // 明日開始のバージョン
    const tomorrow = '2099-10-01';

    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('LEAVE_STANDARD_V_FUTURE', 'LEAVE_STANDARD', 996, 'DRAFT', 200, ?, '9999-12-31', '{}')
    `).run(tomorrow);

    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES 
        ('LEAVE_STANDARD_V_FUTURE', 1, '教頭確認', 'VP_STEP', 'REVIEW', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0),
        ('LEAVE_STANDARD_V_FUTURE', 2, '校長決裁', 'PRIN_STEP', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();

    // 1. 本日時点で Activation 試行 -> 拒絶
    const resFuture = PolicyActivationService.activateVersion({
      actor: adminUser,
      versionId: 'LEAVE_STANDARD_V_FUTURE',
    });
    assert.strictEqual(resFuture.success, false);
    assert.strictEqual(resFuture.statusCode, 422);
    assert.strictEqual(resFuture.errorCode, 'WORKFLOW_ACTIVATION_BEFORE_EFFECTIVE_DATE');

    // v1 が ACTIVE を維持していること
    const v1 = db.prepare("SELECT status FROM workflow_policy_versions WHERE id = 'LEAVE_STANDARD_V1'").get() as any;
    assert.strictEqual(v1.status, 'ACTIVE');

    // 2. 適用開始日を本日以前に変更（期日到来をシミュレート）
    db.prepare("UPDATE workflow_policy_versions SET effective_from = '2026-04-01' WHERE id = 'LEAVE_STANDARD_V_FUTURE'").run();
    const resArrived = PolicyActivationService.activateVersion({
      actor: adminUser,
      versionId: 'LEAVE_STANDARD_V_FUTURE',
      expectedCurrentActiveVersionId: 'LEAVE_STANDARD_V1',
    });
    assert.strictEqual(resArrived.success, true);
    assert.strictEqual(resArrived.statusCode, 200);

    const vFuture = db.prepare("SELECT status FROM workflow_policy_versions WHERE id = 'LEAVE_STANDARD_V_FUTURE'").get() as any;
    assert.strictEqual(vFuture.status, 'ACTIVE');
  });

  it('TEST-2: Draft Isolation / Active Semantic Immutability - DRAFT を大幅改訂しても Activation するまでは ACTIVE の Policy Resolution が完全不変であること', () => {
    const today = serverTimeModule.getCanonicalBusinessDate();

    // 1. 改訂前の Policy Resolution (v1: 2ステップ [教頭, 校長])
    const initialResolved = resolveWorkflowPolicy({
      appTypeId: 'LEAVE_SICK',
      evaluationTime: `${today}T10:00:00.000Z`,
      subjectUserId: teacher1.id,
      submittedByUserId: teacher1.id,
    });
    assert.strictEqual(initialResolved.policyVersionId, 'LEAVE_STANDARD_V1');
    assert.strictEqual(initialResolved.steps.length, 2);
    assert.strictEqual(initialResolved.steps[0].approverPositionCode, 'VICE_PRINCIPAL_1');
    assert.strictEqual(initialResolved.steps[1].approverPositionCode, 'PRINCIPAL');

    // 2. v2 DRAFT を作成し、4段階フロー (教務主任 ➔ 第1教頭 ➔ 第2教頭 ➔ 校長) に設定
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('LEAVE_STANDARD_V2_ISOLATION', 'LEAVE_STANDARD', 997, 'DRAFT', 200, '2026-04-01', '9999-12-31', '{}')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES 
        ('LEAVE_STANDARD_V2_ISOLATION', 1, '教務主任確認', 'CHIEF_STEP', 'REVIEW', 'TEACHER', 'POSITION', 'CHIEF_TEACHER', 0),
        ('LEAVE_STANDARD_V2_ISOLATION', 2, '第1教頭確認', 'VP1_STEP', 'REVIEW', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0),
        ('LEAVE_STANDARD_V2_ISOLATION', 3, '第2教頭確認', 'VP2_STEP', 'REVIEW', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_2', 0),
        ('LEAVE_STANDARD_V2_ISOLATION', 4, '校長決裁', 'PRIN_STEP', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();

    // 3. DRAFT 存在下でも Policy Resolution は依然として v1 (2ステップ) のまま完全不変
    const afterDraftResolved = resolveWorkflowPolicy({
      appTypeId: 'LEAVE_SICK',
      evaluationTime: `${today}T10:00:00.000Z`,
      subjectUserId: teacher1.id,
      submittedByUserId: teacher1.id,
    });
    assert.strictEqual(afterDraftResolved.policyVersionId, 'LEAVE_STANDARD_V1');
    assert.strictEqual(afterDraftResolved.steps.length, 2);
    assert.strictEqual(afterDraftResolved.steps[0].approverPositionCode, 'VICE_PRINCIPAL_1');
    assert.strictEqual(afterDraftResolved.steps[1].approverPositionCode, 'PRINCIPAL');

    // 4. DRAFT のステップ内容を更に変更（1ステップ追加等）
    db.prepare(`
      DELETE FROM workflow_policy_steps WHERE policy_version_id = 'LEAVE_STANDARD_V2_ISOLATION'
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES 
        ('LEAVE_STANDARD_V2_ISOLATION', 1, '事務主幹確認', 'OFF_STEP', 'REVIEW', 'OFFICE', 'POSITION', 'OFFICE_HEAD', 0),
        ('LEAVE_STANDARD_V2_ISOLATION', 2, '校長決裁', 'PRIN_STEP', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();

    // ACTIVE の Policy Resolution は依然として影響ゼロ (v1 2ステップ)
    const afterEditDraftResolved = resolveWorkflowPolicy({
      appTypeId: 'LEAVE_SICK',
      evaluationTime: `${today}T10:00:00.000Z`,
      subjectUserId: teacher1.id,
      submittedByUserId: teacher1.id,
    });
    assert.strictEqual(afterEditDraftResolved.policyVersionId, 'LEAVE_STANDARD_V1');
    assert.strictEqual(afterEditDraftResolved.steps.length, 2);
    assert.strictEqual(afterEditDraftResolved.steps[0].approverPositionCode, 'VICE_PRINCIPAL_1');
    assert.strictEqual(afterEditDraftResolved.steps[1].approverPositionCode, 'PRINCIPAL');
  });

  it('TEST-3: Failure Audit Transaction Boundary - Activation 失敗時に Policy State は完全 Rollback され、独立した FAILED_ACTIVATION_ATTEMPT が記録される', () => {
    const today = serverTimeModule.getCanonicalBusinessDate();

    // 意図的にバリデーション違反の DRAFT (最終決裁なし) を作成
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('LEAVE_STANDARD_V_FAIL_AUDIT', 'LEAVE_STANDARD', 998, 'DRAFT', 200, '2026-04-01', '9999-12-31', '{}')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES 
        ('LEAVE_STANDARD_V_FAIL_AUDIT', 1, '教頭確認のみ', 'VP_STEP', 'REVIEW', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0)
    `).run();

    const res = PolicyActivationService.activateVersion({
      actor: adminUser,
      versionId: 'LEAVE_STANDARD_V_FAIL_AUDIT',
    });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 422);

    // 1. Policy State は完全 Rollback されていること (v1 は ACTIVE のまま、DRAFT は DRAFT のまま)
    const v1 = db.prepare("SELECT status FROM workflow_policy_versions WHERE id = 'LEAVE_STANDARD_V1'").get() as any;
    assert.strictEqual(v1.status, 'ACTIVE');

    const draft = db.prepare("SELECT status FROM workflow_policy_versions WHERE id = 'LEAVE_STANDARD_V_FAIL_AUDIT'").get() as any;
    assert.strictEqual(draft.status, 'DRAFT');

    // 2. 独立した AuditLog に FAILED_ACTIVATION_ATTEMPT が記録されていること
    const audit = db.prepare(`
      SELECT * FROM audit_logs 
      WHERE entity_type = 'WORKFLOW_POLICY_VERSION' AND entity_id = 'LEAVE_STANDARD_V_FAIL_AUDIT'
      ORDER BY id DESC LIMIT 1
    `).get() as any;
    assert.ok(audit, 'Audit log must be written even on failure');
    assert.strictEqual(audit.action, 'FAILED_ACTIVATION_ATTEMPT');
    assert.strictEqual(audit.is_success, 0);
  });

  it('TEST-4: Expired Effective Date & Boundaries - 過去終了日・当日終了日・無期限の境界値判定', () => {
    const today = serverTimeModule.getCanonicalBusinessDate();

    // 過去終了日 (effective_to = '2020-03-31') -> 拒絶
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('LEAVE_STANDARD_V_EXPIRED', 'LEAVE_STANDARD', 999, 'DRAFT', 200, '2019-04-01', '2020-03-31', '{}')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES 
        ('LEAVE_STANDARD_V_EXPIRED', 1, '教頭確認', 'VP_STEP', 'REVIEW', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0),
        ('LEAVE_STANDARD_V_EXPIRED', 2, '校長決裁', 'PRIN_STEP', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();

    const resExpired = PolicyActivationService.activateVersion({
      actor: adminUser,
      versionId: 'LEAVE_STANDARD_V_EXPIRED',
    });
    assert.strictEqual(resExpired.success, false);
    assert.strictEqual(resExpired.statusCode, 422);
    assert.strictEqual(resExpired.errorCode, 'WORKFLOW_ACTIVATION_AFTER_EFFECTIVE_DATE');

    // Case A: effective_to = activationDate (本日終了日) -> 有効期間内として許可
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('LEAVE_STANDARD_V_TODAY_END', 'LEAVE_STANDARD', 1000, 'DRAFT', 200, '2026-04-01', ?, '{}')
    `).run(today);
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES 
        ('LEAVE_STANDARD_V_TODAY_END', 1, '教頭確認', 'VP_STEP', 'REVIEW', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0),
        ('LEAVE_STANDARD_V_TODAY_END', 2, '校長決裁', 'PRIN_STEP', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();

    const resTodayEnd = PolicyActivationService.activateVersion({
      actor: adminUser,
      versionId: 'LEAVE_STANDARD_V_TODAY_END',
      expectedCurrentActiveVersionId: 'LEAVE_STANDARD_V1',
    });
    assert.strictEqual(resTodayEnd.success, true);
    assert.strictEqual(resTodayEnd.statusCode, 200);

    // Case C: effective_to = '9999-12-31' (無期限) -> 許可
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('LEAVE_STANDARD_V_FOREVER', 'LEAVE_STANDARD', 1001, 'DRAFT', 200, '2026-04-01', '9999-12-31', '{}')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES 
        ('LEAVE_STANDARD_V_FOREVER', 1, '教頭確認', 'VP_STEP', 'REVIEW', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0),
        ('LEAVE_STANDARD_V_FOREVER', 2, '校長決裁', 'PRIN_STEP', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();

    const resForever = PolicyActivationService.activateVersion({
      actor: adminUser,
      versionId: 'LEAVE_STANDARD_V_FOREVER',
      expectedCurrentActiveVersionId: 'LEAVE_STANDARD_V_TODAY_END',
    });
    assert.strictEqual(resForever.success, true);
    assert.strictEqual(resForever.statusCode, 200);
  });

  it('TEST-5: Canonical Business Date & JST Boundary / Client Tampering - サーバー業務日付 SSOT による判定', () => {
    // サーバー業務日付 (JST)
    const today = serverTimeModule.getCanonicalBusinessDate();

    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('LEAVE_STANDARD_V_JST_TEST', 'LEAVE_STANDARD', 1002, 'DRAFT', 200, ?, '9999-12-31', '{}')
    `).run(today);
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES 
        ('LEAVE_STANDARD_V_JST_TEST', 1, '教頭確認', 'VP_STEP', 'REVIEW', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0),
        ('LEAVE_STANDARD_V_JST_TEST', 2, '校長決裁', 'PRIN_STEP', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();

    // Client からの日時パラメータは渡さず（あるいは偽装があっても）、Server Canonical Business Date で正常に判定され有効化される
    const res = PolicyActivationService.activateVersion({
      actor: adminUser,
      versionId: 'LEAVE_STANDARD_V_JST_TEST',
      expectedCurrentActiveVersionId: 'LEAVE_STANDARD_V1',
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.statusCode, 200);
  });

  it('GOLDEN-WORKFLOW-008: Historical Workflow Golden Test - v1 で提出された申請Aは最後まで v1 Snapshot で決裁完了し、Activation 後の申請Bのみ v2 が適用される', () => {
    // 1. v1 ACTIVE (教頭 ➔ 校長) で 申請 A を提出
    const submitResA = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_SICK',
      title: '【病休】申請A (v1運用中)',
      formData: { unitType: 'DAY', startDate: '2026-05-18', endDate: '2026-05-18', calculatedDays: 1, reason: '私用' },
    });
    assert.strictEqual(submitResA.success, true);
    const appAId = submitResA.data.id;

    // 申請 A の Step スナップショット確認 (2段階)
    const stepsABefore = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? ORDER BY step_order ASC').all(appAId) as any[];
    assert.strictEqual(stepsABefore.length, 2);
    assert.strictEqual(stepsABefore[0].step_name, '教頭一次確認');
    assert.strictEqual(stepsABefore[1].step_name, '校長最終決裁');

    // 2. v2 DRAFT (3段階: 教務主任 ➔ 第1教頭 ➔ 校長) を作成して ACTIVE 化
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('LEAVE_STANDARD_V2_GOLDEN', 'LEAVE_STANDARD', 1003, 'DRAFT', 200, '2026-04-01', '9999-12-31', '{}')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES 
        ('LEAVE_STANDARD_V2_GOLDEN', 1, '教務主任確認', 'CHIEF_STEP', 'REVIEW', 'TEACHER', 'POSITION', 'CHIEF_TEACHER', 0),
        ('LEAVE_STANDARD_V2_GOLDEN', 2, '第1教頭確認', 'VP1_STEP', 'REVIEW', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0),
        ('LEAVE_STANDARD_V2_GOLDEN', 3, '校長最終決裁', 'PRIN_STEP', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();

    const actRes = PolicyActivationService.activateVersion({
      actor: adminUser,
      versionId: 'LEAVE_STANDARD_V2_GOLDEN',
      expectedCurrentActiveVersionId: 'LEAVE_STANDARD_V1',
    });
    assert.strictEqual(actRes.success, true);

    // 3. 申請 A を教頭・校長で承認進行 ──► v1 Snapshot のまま 2段階で決裁完了
    let appA = db.prepare('SELECT version FROM applications WHERE id = ?').get(appAId) as any;
    const vpApprove = WorkflowEngine.approveApplication(vpUser, {
      applicationId: appAId,
      expectedVersion: appA.version,
      comment: '教頭承認',
    });
    assert.strictEqual(vpApprove.success, true);

    appA = db.prepare('SELECT version FROM applications WHERE id = ?').get(appAId) as any;
    const prinApprove = WorkflowEngine.approveApplication(principalUser, {
      applicationId: appAId,
      expectedVersion: appA.version,
      comment: '校長決裁',
    });
    assert.strictEqual(prinApprove.success, true);

    const appAFinal = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appAId) as any;
    assert.strictEqual(appAFinal.current_status, 'FINAL_APPROVED');

    // 申請 A のステップレコード数が 2件のまま維持されていること
    const stepsAAfter = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? ORDER BY step_order ASC').all(appAId) as any[];
    assert.strictEqual(stepsAAfter.length, 2);

    // 4. Activation 後に新規申請 B を提出 ──► v2 Snapshot (3段階) が適用される
    const submitResB = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_SICK',
      title: '【病休】申請B (v2運用後)',
      formData: { unitType: 'DAY', startDate: '2026-05-19', endDate: '2026-05-19', calculatedDays: 1, reason: '私用' },
    });
    assert.strictEqual(submitResB.success, true);
    const appBId = submitResB.data.id;

    const stepsB = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? ORDER BY step_order ASC').all(appBId) as any[];
    assert.strictEqual(stepsB.length, 3);
    assert.strictEqual(stepsB[0].step_name, '教務主任確認');
    assert.strictEqual(stepsB[1].step_name, '第1教頭確認');
    assert.strictEqual(stepsB[2].step_name, '校長最終決裁');
  });

  it('INV-ADM-007: OCC & Partial Unique Index - 2人の管理者が同時に異なる DRAFT を有効化した場合、片方のみ成功し 409 CONFLICT となる', () => {
    // DRAFT v2 と DRAFT v3
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES 
        ('LEAVE_STANDARD_V2_OCC', 'LEAVE_STANDARD', 1004, 'DRAFT', 200, '2026-04-01', '9999-12-31', '{}'),
        ('LEAVE_STANDARD_V3_OCC', 'LEAVE_STANDARD', 1005, 'DRAFT', 200, '2026-04-01', '9999-12-31', '{}')
    `).run();

    const insertSteps = (vId: string) => {
      db.prepare(`
        INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
        VALUES 
          (?, 1, '教頭確認', 'VP_STEP', 'REVIEW', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0),
          (?, 2, '校長決裁', 'PRIN_STEP', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
      `).run(vId, vId);
    };
    insertSteps('LEAVE_STANDARD_V2_OCC');
    insertSteps('LEAVE_STANDARD_V3_OCC');

    // 管理者 A が v2 を有効化 (expected: 'LEAVE_STANDARD_V1') -> 成功
    const resA = PolicyActivationService.activateVersion({
      actor: adminUser,
      versionId: 'LEAVE_STANDARD_V2_OCC',
      expectedCurrentActiveVersionId: 'LEAVE_STANDARD_V1',
    });
    assert.strictEqual(resA.success, true);
    assert.strictEqual(resA.statusCode, 200);

    // 管理者 B が v3 を有効化 (画面表示時の想定: 'LEAVE_STANDARD_V1') -> OCC により 409 CONFLICT で拒絶
    const resB = PolicyActivationService.activateVersion({
      actor: adminUser,
      versionId: 'LEAVE_STANDARD_V3_OCC',
      expectedCurrentActiveVersionId: 'LEAVE_STANDARD_V1',
    });
    assert.strictEqual(resB.success, false);
    assert.strictEqual(resB.statusCode, 409);
    assert.strictEqual(resB.errorCode, 'WORKFLOW_ACTIVE_VERSION_CONFLICT');

    // DB 上の ACTIVE バージョンが厳密に 1 件 (v2 のみ) であること
    const activeVersions = db.prepare("SELECT * FROM workflow_policy_versions WHERE policy_id = 'LEAVE_STANDARD' AND status = 'ACTIVE'").all() as any[];
    assert.strictEqual(activeVersions.length, 1);
    assert.strictEqual(activeVersions[0].id, 'LEAVE_STANDARD_V2_OCC');
  });
});
