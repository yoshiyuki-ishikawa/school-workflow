import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine } from '../workflow/engine';
import { AnnualLeaveService } from '../services/annualLeaveService';
import { resolveWorkflowPolicy } from '../workflow/policyResolver';

describe('Decision-less Terminal Workflow — Production Policy Seed & Activation Verification Tests', () => {
  let db: any;

  const teacherA = { id: 1, username: 'teacher1', displayName: '山田 太郎 (教員A)', roles: ['TEACHER'], ipAddress: '127.0.0.1' };
  const teacherB = { id: 2, username: 'teacher2', displayName: '佐藤 花子 (教員B)', roles: ['TEACHER'], ipAddress: '127.0.0.1' };
  const vpB = { id: 3, username: 'vice_principal', displayName: '田中 誠 (教頭B)', roles: ['VICE_PRINCIPAL', 'TEACHER'], ipAddress: '127.0.0.1' };
  const prinC = { id: 4, username: 'principal', displayName: '鈴木 健一 (校長C)', roles: ['PRINCIPAL', 'TEACHER'], ipAddress: '127.0.0.1' };
  const staffD = { id: 5, username: 'staff1', displayName: '高橋 健 (事務係)', roles: ['OFFICE', 'STAFF'], ipAddress: '127.0.0.1' };

  beforeEach(() => {
    initDatabase();
    seedDatabase();
    db = getDb();

    // 既存申請・年休データをクリアしてクリーンな本番シード環境を作成
    db.prepare('DELETE FROM leave_usages').run();
    db.prepare('DELETE FROM leave_entitlements').run();
    db.prepare('DELETE FROM travel_order_snapshots').run();
    db.prepare('DELETE FROM post_trip_report_snapshots').run();
    db.prepare('DELETE FROM application_approval_steps').run();
    db.prepare('DELETE FROM application_workflow_cycles').run();
    db.prepare('DELETE FROM trip_event_members').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM trip_events').run();
    db.prepare('DELETE FROM monthly_attendance_approvals').run();

    // テスト対象教職員に年休を付与 (2026年度)
    [1, 2, 3, 4].forEach((uid) => {
      AnnualLeaveService.grantEntitlement({
        userId: uid,
        entitlementType: 'REGULAR_GRANT',
        fiscalYear: 2026,
        grantedDays: 20,
        grantDate: '2026-04-01',
        effectiveFrom: '2026-04-01',
        expiresAt: '2028-03-31',
        reason: '2026年度当初付与',
        grantEventKey: `SEED_TEST_${uid}_2026`,
      });
    });
  });

  it('GT-SEED-DLT-01: Fresh seeded DB: LEAVE_ANNUAL resolves LEAVE_ANNUAL_STANDARD policy', () => {
    const policy = resolveWorkflowPolicy({
      appTypeId: 'LEAVE_ANNUAL',
      evaluationTime: '2026-05-11',
      subjectUserId: teacherA.id,
      submittedByUserId: teacherA.id,
      policyPurpose: 'APPROVAL',
    });

    assert.strictEqual(policy.policyId, 'LEAVE_ANNUAL_STANDARD');
    assert.strictEqual(policy.policyKey, 'LEAVE_ANNUAL_STANDARD');
    assert.strictEqual(policy.steps.length, 2);
  });

  it('GT-SEED-DLT-02: General Staff annual leave route: Step 1 REVIEW → Step 2 ACK (No DECIDE)', () => {
    const policy = resolveWorkflowPolicy({
      appTypeId: 'LEAVE_ANNUAL',
      evaluationTime: '2026-05-11',
      subjectUserId: teacherA.id,
      submittedByUserId: teacherA.id,
      policyPurpose: 'APPROVAL',
    });

    assert.strictEqual(policy.steps[0].actionType, 'REVIEW');
    assert.strictEqual(policy.steps[0].isFinalDecisionStep, false);
    assert.strictEqual(policy.steps[0].approverUserId, vpB.id);

    assert.strictEqual(policy.steps[1].actionType, 'ACK');
    assert.strictEqual(policy.steps[1].isFinalDecisionStep, true);
    assert.strictEqual(policy.steps[1].approverUserId, prinC.id);

    // DECIDE が一切含まれていないこと
    const decideSteps = policy.steps.filter((s) => s.actionType === 'DECIDE');
    assert.strictEqual(decideSteps.length, 0);
  });

  it('GT-SEED-DLT-03: Fresh seeded DB E2E: General Staff TYPE-B (CLAIM → VP REVIEW → Principal ACK-B → FINAL_APPROVED → Fact Activation)', () => {
    // 1. 一般教員Aが年休申請を提出 (テストローカルPolicy注入なし)
    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-SEED-DLT-03)',
      formData: {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        unitType: 'DAY',
        reason: '私事都合',
      },
    });
    assert.strictEqual(submitRes.success, true, `Submit failed: ${submitRes.message}`);
    const appId = submitRes.data.id;

    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'SUBMITTED');
    assert.strictEqual(app.current_step_order, 1);

    // 2. 教頭Bが Step 1 (REVIEW) を承認
    const reviewRes = WorkflowEngine.approveApplication(vpB, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '教頭審査完了',
      actionType: 'REVIEW',
    });
    assert.strictEqual(reviewRes.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'IN_APPROVAL');
    assert.strictEqual(app.current_step_order, 2);

    // 3. 校長Cが Step 2 (ACK-B) を受領確認
    const ackRes = WorkflowEngine.approveApplication(prinC, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '校長受領確認',
      actionType: 'ACK',
    });
    assert.strictEqual(ackRes.success, true);

    // 4. 終端到達により FINAL_APPROVED に遷移
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'FINAL_APPROVED');

    // 5. Fact Activation (leave_usages) が 1件 確定されていること
    const usages = db.prepare('SELECT * FROM leave_usages WHERE application_id = ?').all(appId) as any[];
    assert.strictEqual(usages.length, 1);
    assert.strictEqual(usages[0].status, 'ACTIVE');
  });

  it('GT-SEED-DLT-04: Fresh seeded DB E2E: Principal Self-Service TYPE-D (SUBMIT → VP REVIEW → Principal ACK-A → FINAL_APPROVED → Fact Activation)', () => {
    // 1. 校長C本人が年休申請を提出 (テストローカルPolicy注入なし)
    const submitRes = WorkflowEngine.submitApplication(prinC, {
      typeId: 'LEAVE_ANNUAL',
      title: '校長年休届 (GT-SEED-DLT-04)',
      formData: {
        startDate: '2026-05-12',
        endDate: '2026-05-12',
        unitType: 'DAY',
        reason: '私事都合',
      },
    });
    assert.strictEqual(submitRes.success, true, `Submit failed: ${submitRes.message}`);
    const appId = submitRes.data.id;

    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'SUBMITTED');
    assert.strictEqual(app.current_step_order, 1);

    // 2. 教頭Bが Step 1 (REVIEW) を事前確認
    const reviewRes = WorkflowEngine.approveApplication(vpB, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '教頭事前確認',
      actionType: 'REVIEW',
    });
    assert.strictEqual(reviewRes.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'IN_APPROVAL');
    assert.strictEqual(app.current_step_order, 2);

    // 3. 校長C本人が Step 2 (ACK-A Positive Authorization) を受領確認
    const ackRes = WorkflowEngine.approveApplication(prinC, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '校長本人受領確認',
      actionType: 'ACK',
    });
    assert.strictEqual(ackRes.success, true);

    // 4. 終端到達により FINAL_APPROVED に遷移
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'FINAL_APPROVED');

    // 5. Fact Activation (leave_usages) が 1件 確定されていること
    const usages = db.prepare('SELECT * FROM leave_usages WHERE application_id = ?').all(appId) as any[];
    assert.strictEqual(usages.length, 1);
  });

  it('GT-SEED-DLT-05: Vice Principal Annual Leave: Step 1 (VP REVIEW) is SKIPPED and Step 2 (Principal ACK) is PENDING', () => {
    const submitRes = WorkflowEngine.submitApplication(vpB, {
      typeId: 'LEAVE_ANNUAL',
      title: '教頭年休 (GT-SEED-DLT-05)',
      formData: {
        startDate: '2026-05-13',
        endDate: '2026-05-13',
        unitType: 'DAY',
        reason: '私事都合',
      },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'SUBMITTED');
    assert.strictEqual(app.current_step_order, 2, '教頭本人のため Step 1 は SKIPPED され Step 2 が最初のアクティブステップ');

    // 校長が Step 2 ACK を受領確認
    const ackRes = WorkflowEngine.approveApplication(prinC, {
      applicationId: appId,
      expectedVersion: app.version,
      actionType: 'ACK',
    });
    assert.strictEqual(ackRes.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'FINAL_APPROVED');
  });

  it('GT-SEED-DLT-06: Existing DB Activation Strategy: Re-running seedDatabase() cleans up old LEAVE_STANDARD mapping', () => {
    // 既存DBに旧 LEAVE_STANDARD -> LEAVE_ANNUAL が残っていた状況をシミュレート
    db.prepare("INSERT OR REPLACE INTO workflow_policy_application_types (policy_id, app_type_id) VALUES ('LEAVE_STANDARD', 'LEAVE_ANNUAL')").run();

    // seedDatabase() 再実行
    seedDatabase();

    // LEAVE_STANDARD -> LEAVE_ANNUAL のマッピングが削除されていること
    const oldMapping = db.prepare("SELECT * FROM workflow_policy_application_types WHERE policy_id = 'LEAVE_STANDARD' AND app_type_id = 'LEAVE_ANNUAL'").get();
    assert.strictEqual(oldMapping, undefined, 'Old mapping must be cleaned up');

    // 新しい LEAVE_ANNUAL_STANDARD -> LEAVE_ANNUAL のマッピングのみが存在すること
    const newMapping = db.prepare("SELECT * FROM workflow_policy_application_types WHERE policy_id = 'LEAVE_ANNUAL_STANDARD' AND app_type_id = 'LEAVE_ANNUAL'").get();
    assert.strictEqual(newMapping !== undefined, true, 'New mapping must exist');
  });

  it('GT-SEED-DLT-07: LEAVE_SICK and LEAVE_SPECIAL remain TYPE-A (REVIEW → DECIDE)', () => {
    const sickPolicy = resolveWorkflowPolicy({
      appTypeId: 'LEAVE_SICK',
      evaluationTime: '2026-05-14',
      subjectUserId: teacherA.id,
      submittedByUserId: teacherA.id,
      policyPurpose: 'APPROVAL',
    });
    assert.strictEqual(sickPolicy.policyId, 'LEAVE_STANDARD');
    assert.strictEqual(sickPolicy.steps[0].actionType, 'REVIEW');
    assert.strictEqual(sickPolicy.steps[1].actionType, 'DECIDE');
    assert.strictEqual(sickPolicy.steps[1].isFinalDecisionStep, true);

    const specialPolicy = resolveWorkflowPolicy({
      appTypeId: 'LEAVE_SPECIAL',
      evaluationTime: '2026-05-14',
      subjectUserId: teacherA.id,
      submittedByUserId: teacherA.id,
      policyPurpose: 'APPROVAL',
    });
    assert.strictEqual(specialPolicy.policyId, 'LEAVE_STANDARD');
    assert.strictEqual(specialPolicy.steps[0].actionType, 'REVIEW');
    assert.strictEqual(specialPolicy.steps[1].actionType, 'DECIDE');
  });

  it('GT-SEED-DLT-08: BUSINESS_TRIP is REVIEW → APPROVE → DECIDE', () => {
    const tripPolicy = resolveWorkflowPolicy({
      appTypeId: 'BUSINESS_TRIP',
      evaluationTime: '2026-05-15',
      subjectUserId: teacherA.id,
      submittedByUserId: teacherA.id,
      policyPurpose: 'APPROVAL',
    });
    assert.strictEqual(tripPolicy.policyId, 'TRIP_STANDARD');
    assert.strictEqual(tripPolicy.steps.length, 3);
    assert.strictEqual(tripPolicy.steps[0].actionType, 'REVIEW');
    assert.strictEqual(tripPolicy.steps[1].actionType, 'APPROVE');
    assert.strictEqual(tripPolicy.steps[2].actionType, 'DECIDE');
  });

  it('GT-SEED-DLT-09: INV-SEM-09 correctly accepts seeded LEAVE_ANNUAL_STANDARD route', () => {
    // INV-SEM-09 により年休申請が問題なくバリデーションを通過して提出されること
    const res = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-SEED-DLT-09)',
      formData: {
        startDate: '2026-05-18',
        endDate: '2026-05-18',
        unitType: 'DAY',
        reason: '私事都合',
      },
    });
    assert.strictEqual(res.success, true);
  });
});