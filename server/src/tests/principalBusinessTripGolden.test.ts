import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { WorkflowEngine } from '../workflow/engine';
import { resolveWorkflowPolicy, WorkflowPolicyError } from '../workflow/policyResolver';
import { AnnualLeaveService } from '../services/annualLeaveService';
import { UserContext } from '../types/express';

describe('Principal Self Business Trip × TYPE-D ACK Golden Tests (GT-PSBT-01〜22)', () => {
  const teacherUser: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎 (教員A)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
  };

  const vpUser: UserContext = {
    id: 3,
    username: 'vice_principal',
    displayName: '田中 誠 (教頭B)',
    roles: ['VICE_PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
  };

  const principalUser: UserContext = {
    id: 4,
    username: 'principal',
    displayName: '鈴木 健一 (校長C)',
    roles: ['PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
  };

  const officeUser: UserContext = {
    id: 5,
    username: 'office',
    displayName: '高橋 節子 (事務D)',
    roles: ['OFFICE'],
    ipAddress: '127.0.0.1',
  };

  beforeEach(() => {
    const db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  const validPrincipalTripData = {
    startDate: '2026-10-20',
    endDate: '2026-10-20',
    startAt: '2026-10-20T09:00:00',
    endAt: '2026-10-20T17:00:00',
    destination: '県庁教育委員会',
    departurePlace: '本校',
    arrivalPlace: '本校',
    purpose: '校長会総会出席',
    transport: '公用車',
    fundingSource: '県費',
  };

  it('GT-PSBT-01: Principal本人BUSINESS_TRIP提出成功', () => {
    const res = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'BUSINESS_TRIP',
      title: '校長会総会出張',
      formData: validPrincipalTripData,
    });
    assert.strictEqual(res.success, true, res.message);
    assert.ok(res.data?.id);
  });

  it('GT-PSBT-02: workflow_policy_version_id === TRIP_PRINCIPAL_STANDARD_V1', () => {
    const db = getDb();
    const res = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'BUSINESS_TRIP',
      title: '校長会総会出張 (GT-02)',
      formData: validPrincipalTripData,
    });
    assert.strictEqual(res.success, true);
    const appId = res.data.id;

    const cycle = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 1').get(appId) as any;
    assert.ok(cycle);
    assert.strictEqual(cycle.workflow_policy_version_id, 'TRIP_PRINCIPAL_STANDARD_V1');
  });

  it('GT-PSBT-03: Step 1: OFFICE_TRIP_STEP, REVIEW, OFFICE', () => {
    const db = getDb();
    const res = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'BUSINESS_TRIP',
      title: '出張 (GT-03)',
      formData: validPrincipalTripData,
    });
    const appId = res.data.id;
    const steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? ORDER BY step_order ASC').all(appId) as any[];

    assert.ok(steps.length >= 1);
    assert.strictEqual(steps[0].step_order, 1);
    assert.strictEqual(steps[0].step_key, 'OFFICE_TRIP_STEP');
    assert.strictEqual(steps[0].action_type, 'REVIEW');
    assert.strictEqual(steps[0].required_role_id, 'OFFICE');
    assert.strictEqual(steps[0].is_final_decision_step, 0);
  });

  it('GT-PSBT-04: Step 2: VP_TRIP_REVIEW_STEP, REVIEW, VICE_PRINCIPAL', () => {
    const db = getDb();
    const res = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'BUSINESS_TRIP',
      title: '出張 (GT-04)',
      formData: validPrincipalTripData,
    });
    const appId = res.data.id;
    const steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? ORDER BY step_order ASC').all(appId) as any[];

    assert.ok(steps.length >= 2);
    assert.strictEqual(steps[1].step_order, 2);
    assert.strictEqual(steps[1].step_key, 'VP_TRIP_REVIEW_STEP');
    assert.strictEqual(steps[1].action_type, 'REVIEW');
    assert.strictEqual(steps[1].required_role_id, 'VICE_PRINCIPAL');
    assert.strictEqual(steps[1].is_final_decision_step, 0);
  });

  it('GT-PSBT-05: Step 3: PRINCIPAL_TRIP_ACK_STEP, ACK, PRINCIPAL, isFinalDecisionStep = 1', () => {
    const db = getDb();
    const res = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'BUSINESS_TRIP',
      title: '出張 (GT-05)',
      formData: validPrincipalTripData,
    });
    const appId = res.data.id;
    const steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? ORDER BY step_order ASC').all(appId) as any[];

    assert.strictEqual(steps.length, 3);
    assert.strictEqual(steps[2].step_order, 3);
    assert.strictEqual(steps[2].step_key, 'PRINCIPAL_TRIP_ACK_STEP');
    assert.strictEqual(steps[2].action_type, 'ACK');
    assert.strictEqual(steps[2].required_role_id, 'PRINCIPAL');
    assert.strictEqual(steps[2].is_final_decision_step, 1);
  });

  it('GT-PSBT-06: Final Action !== DECIDE', () => {
    const db = getDb();
    const res = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'BUSINESS_TRIP',
      title: '出張 (GT-06)',
      formData: validPrincipalTripData,
    });
    const appId = res.data.id;
    const finalStep = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND is_final_decision_step = 1').get(appId) as any;
    assert.ok(finalStep);
    assert.notStrictEqual(finalStep.action_type, 'DECIDE');
  });

  it('GT-PSBT-07: Final Action !== ORDER', () => {
    const db = getDb();
    const res = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'BUSINESS_TRIP',
      title: '出張 (GT-07)',
      formData: validPrincipalTripData,
    });
    const appId = res.data.id;
    const finalStep = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND is_final_decision_step = 1').get(appId) as any;
    assert.ok(finalStep);
    assert.notStrictEqual(finalStep.action_type, 'ORDER');
  });

  it('GT-PSBT-08: Applicant == Final ACK Actor でも HD-02 非発火', () => {
    const db = getDb();
    const submitRes = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'BUSINESS_TRIP',
      title: '出張 (GT-08)',
      formData: validPrincipalTripData,
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    // Step 1: 事務審査
    const app1 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const appv1 = WorkflowEngine.approveApplication(officeUser, { applicationId: appId, expectedVersion: app1.version });
    assert.strictEqual(appv1.success, true);

    // Step 2: 教頭確認
    const app2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const appv2 = WorkflowEngine.approveApplication(vpUser, { applicationId: appId, expectedVersion: app2.version });
    assert.strictEqual(appv2.success, true);

    // Step 3: 校長本人 ACK (Applicant == Final ACK Actor)
    const app3 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const finalRes = WorkflowEngine.approveApplication(principalUser, { applicationId: appId, expectedVersion: app3.version });
    assert.strictEqual(finalRes.success, true, 'Principal self ACK must succeed without HD-02 violation');

    const updatedApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(updatedApp.current_status, 'TRIP_APPROVED');
  });

  it('GT-PSBT-09: Applicant == Final DECIDE Actor は HD-02 422 Fail-Closed', () => {
    // 校長が DECIDE 終端のポリシー（病休: LEAVE_SICK）を申請しようとすると 422 で Fail-Closed
    const submitRes = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'LEAVE_SICK',
      title: '校長自己病休',
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

  it('GT-PSBT-10: Office REVIEW完了時は非Terminal / IN_APPROVAL', () => {
    const db = getDb();
    const submitRes = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'BUSINESS_TRIP',
      title: '出張 (GT-10)',
      formData: validPrincipalTripData,
    });
    const appId = submitRes.data.id;

    const app1 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const appv1 = WorkflowEngine.approveApplication(officeUser, { applicationId: appId, expectedVersion: app1.version });
    assert.strictEqual(appv1.success, true);

    const updatedApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(updatedApp.current_status, 'IN_APPROVAL');
    assert.notStrictEqual(updatedApp.current_status, 'TRIP_APPROVED');
    assert.strictEqual(updatedApp.current_step_order, 2);
  });

  it('GT-PSBT-11: Vice Principal REVIEW完了時も非Terminal / IN_APPROVAL', () => {
    const db = getDb();
    const submitRes = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'BUSINESS_TRIP',
      title: '出張 (GT-11)',
      formData: validPrincipalTripData,
    });
    const appId = submitRes.data.id;

    // Step 1: 事務審査
    const app1 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(officeUser, { applicationId: appId, expectedVersion: app1.version });

    // Step 2: 教頭確認
    const app2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const appv2 = WorkflowEngine.approveApplication(vpUser, { applicationId: appId, expectedVersion: app2.version });
    assert.strictEqual(appv2.success, true);

    const updatedApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(updatedApp.current_status, 'IN_APPROVAL');
    assert.notStrictEqual(updatedApp.current_status, 'TRIP_APPROVED');
    assert.strictEqual(updatedApp.current_step_order, 3);
  });

  it('GT-PSBT-12: Principal ACK完了時のみ TRIP_APPROVED', () => {
    const db = getDb();
    const submitRes = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'BUSINESS_TRIP',
      title: '出張 (GT-12)',
      formData: validPrincipalTripData,
    });
    const appId = submitRes.data.id;

    const app1 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(officeUser, { applicationId: appId, expectedVersion: app1.version });

    const app2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vpUser, { applicationId: appId, expectedVersion: app2.version });

    const appBefore = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.notStrictEqual(appBefore.current_status, 'TRIP_APPROVED');

    const app3 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principalUser, { applicationId: appId, expectedVersion: app3.version });

    const appAfter = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(appAfter.current_status, 'TRIP_APPROVED');
  });

  it('GT-PSBT-13: 一般職員BUSINESS_TRIP: TRIP_STANDARD_V2 (事務 REVIEW → VP APPROVE → 校長 DECIDE) を100%維持', () => {
    const db = getDb();
    const submitRes = WorkflowEngine.submitApplication(teacherUser, {
      typeId: 'BUSINESS_TRIP',
      title: '教員研究出張',
      formData: validPrincipalTripData,
    });
    assert.strictEqual(submitRes.success, true, submitRes.message);
    const appId = submitRes.data.id;

    // Cycle check
    const cycle = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ?').get(appId) as any;
    assert.strictEqual(cycle.workflow_policy_version_id, 'TRIP_STANDARD_V2');

    // Steps check
    const steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? ORDER BY step_order ASC').all(appId) as any[];
    assert.strictEqual(steps.length, 3);
    assert.strictEqual(steps[0].action_type, 'REVIEW');
    assert.strictEqual(steps[0].required_role_id, 'OFFICE');
    assert.strictEqual(steps[1].action_type, 'APPROVE');
    assert.strictEqual(steps[1].required_role_id, 'VICE_PRINCIPAL');
    assert.strictEqual(steps[2].action_type, 'DECIDE');
    assert.strictEqual(steps[2].required_role_id, 'PRINCIPAL');

    // Full execution
    const a1 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(officeUser, { applicationId: appId, expectedVersion: a1.version });
    const a2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vpUser, { applicationId: appId, expectedVersion: a2.version });
    const a3 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principalUser, { applicationId: appId, expectedVersion: a3.version });

    const finalApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(finalApp.current_status, 'TRIP_APPROVED');
  });

  it('GT-PSBT-14: Principal LEAVE_ANNUAL TYPE-D Regressionなし', () => {
    const db = getDb();
    AnnualLeaveService.grantEntitlement({
      userId: principalUser.id,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-01-01',
      effectiveFrom: '2026-01-01',
      expiresAt: '2027-12-31',
      reason: '当初付与',
    });

    const submitRes = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'LEAVE_ANNUAL',
      title: '校長年休',
      formData: {
        startDate: '2026-10-26', // 平日（月曜）
        endDate: '2026-10-26',
        calculatedDays: 1,
        reason: '私事都合',
      },
    });
    assert.strictEqual(submitRes.success, true, submitRes.message);
    const appId = submitRes.data.id;

    const cycle = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ?').get(appId) as any;
    assert.strictEqual(cycle.workflow_policy_version_id, 'LEAVE_ANNUAL_STANDARD_V1');

    const steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? ORDER BY step_order ASC').all(appId) as any[];
    assert.strictEqual(steps.length, 2);
    assert.strictEqual(steps[0].action_type, 'REVIEW');
    assert.strictEqual(steps[0].required_role_id, 'VICE_PRINCIPAL');
    assert.strictEqual(steps[1].action_type, 'ACK');
    assert.strictEqual(steps[1].required_role_id, 'PRINCIPAL');

    // VP Review -> Principal ACK
    const a1 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vpUser, { applicationId: appId, expectedVersion: a1.version });
    const a2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principalUser, { applicationId: appId, expectedVersion: a2.version });

    const finalApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(finalApp.current_status, 'FINAL_APPROVED');
  });

  it('GT-PSBT-15: Proxy Actor / Subject Resolution Regressionなし (代理申請時もsubjectUserId判定で校長ポリシー解決)', () => {
    const db = getDb();
    // 1. Resolver 直接テスト: subjectUserId が校長であれば、起票者が教員であっても校長出張ポリシーが解決される
    const resolved = resolveWorkflowPolicy({
      appTypeId: 'BUSINESS_TRIP',
      evaluationTime: '2026-10-20',
      subjectUserId: principalUser.id,
      submittedByUserId: teacherUser.id,
    });
    assert.strictEqual(resolved.policyVersionId, 'TRIP_PRINCIPAL_STANDARD_V1', 'Direct resolver: Subject is Principal -> Must resolve TRIP_PRINCIPAL_STANDARD_V1');

    // 2. Engine 代理申請テスト: vpUser が principalUser の代理で出張申請を提出
    const submitRes = WorkflowEngine.submitProxyApplication(vpUser, {
      typeId: 'BUSINESS_TRIP',
      subjectUserId: principalUser.id,
      title: '校長代理出張申請',
      formData: validPrincipalTripData,
      proxyReason: '校長公務多忙のため教頭代理起票',
    });
    assert.strictEqual(submitRes.success, true, submitRes.message);
    const appId = submitRes.data.id;

    const cycle = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ?').get(appId) as any;
    assert.strictEqual(cycle.workflow_policy_version_id, 'TRIP_PRINCIPAL_STANDARD_V1', 'Engine submitProxyApplication: Subject is Principal -> Must resolve TRIP_PRINCIPAL_STANDARD_V1');
  });

  it('GT-PSBT-16: Principal ACK完了時 travel_order_snapshots 正常生成', () => {
    const db = getDb();
    const submitRes = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'BUSINESS_TRIP',
      title: '出張 (GT-16)',
      formData: validPrincipalTripData,
    });
    const appId = submitRes.data.id;

    const a1 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(officeUser, { applicationId: appId, expectedVersion: a1.version });
    const a2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vpUser, { applicationId: appId, expectedVersion: a2.version });
    const a3 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principalUser, { applicationId: appId, expectedVersion: a3.version });

    const snapshot = db.prepare('SELECT * FROM travel_order_snapshots WHERE application_id = ?').get(appId) as any;
    assert.ok(snapshot, 'travel_order_snapshots record must exist');
    assert.strictEqual(snapshot.traveler_user_id_snapshot, principalUser.id);
    assert.ok(snapshot.travel_order_issued_at);
    assert.ok(snapshot.trip_plan_facts_json);
    assert.ok(snapshot.approval_history_snapshots_json);

    const history = JSON.parse(snapshot.approval_history_snapshots_json);
    assert.strictEqual(history.length, 3);
    assert.strictEqual(history[0].step_key, 'OFFICE_TRIP_STEP');
    assert.strictEqual(history[1].step_key, 'VP_TRIP_REVIEW_STEP');
    assert.strictEqual(history[2].step_key, 'PRINCIPAL_TRIP_ACK_STEP');
  });

  it('GT-PSBT-17: report_status === UNSUBMITTED', () => {
    const db = getDb();
    const submitRes = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'BUSINESS_TRIP',
      title: '出張 (GT-17)',
      formData: validPrincipalTripData,
    });
    const appId = submitRes.data.id;

    const a1 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(officeUser, { applicationId: appId, expectedVersion: a1.version });
    const a2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vpUser, { applicationId: appId, expectedVersion: a2.version });
    const a3 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principalUser, { applicationId: appId, expectedVersion: a3.version });

    const finalApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(finalApp.report_status, 'UNSUBMITTED');
  });

  it('GT-PSBT-18: Non-Principal へ TRIP_PRINCIPAL_STANDARD 適用禁止', () => {
    const res = resolveWorkflowPolicy({
      appTypeId: 'BUSINESS_TRIP',
      evaluationTime: '2026-10-20',
      subjectUserId: teacherUser.id,
      submittedByUserId: teacherUser.id,
    });
    assert.strictEqual(res.policyId, 'TRIP_STANDARD');
    assert.strictEqual(res.policyVersionId, 'TRIP_STANDARD_V2');
    assert.notStrictEqual(res.policyId, 'TRIP_PRINCIPAL_STANDARD');
  });

  it('GT-PSBT-19: Principal Policy Missing / Inactive 時、General TRIP Policy へ Fallback せず WORKFLOW_POLICY_UNRESOLVED 400', () => {
    const db = getDb();
    // TRIP_PRINCIPAL_STANDARD を一時的に INACTIVE に更新
    db.prepare("UPDATE workflow_policy_versions SET status = 'INACTIVE' WHERE policy_id = 'TRIP_PRINCIPAL_STANDARD'").run();

    assert.throws(() => {
      resolveWorkflowPolicy({
        appTypeId: 'BUSINESS_TRIP',
        evaluationTime: '2026-10-20',
        subjectUserId: principalUser.id,
        submittedByUserId: principalUser.id,
      });
    }, (err: any) => {
      assert.strictEqual(err.statusCode, 400);
      assert.strictEqual(err.errorCode, 'WORKFLOW_POLICY_UNRESOLVED');
      return true;
    });

    // 復元
    db.prepare("UPDATE workflow_policy_versions SET status = 'ACTIVE' WHERE policy_id = 'TRIP_PRINCIPAL_STANDARD'").run();
  });

  it('GT-PSBT-20: TRIP_STANDARD_V1/V2 Historical Immutability', () => {
    const db = getDb();
    const v1 = db.prepare("SELECT * FROM workflow_policy_versions WHERE id = 'TRIP_STANDARD_V1'").get() as any;
    assert.ok(v1);
    assert.strictEqual(v1.status, 'INACTIVE');
    assert.strictEqual(v1.version, 1);

    const v1Steps = db.prepare("SELECT * FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_V1' ORDER BY step_order ASC").all() as any[];
    assert.strictEqual(v1Steps.length, 3);
    assert.strictEqual(v1Steps[0].action_type, 'APPROVE');
    assert.strictEqual(v1Steps[1].action_type, 'DECIDE');
    assert.strictEqual(v1Steps[2].action_type, 'CHECK');

    const v2 = db.prepare("SELECT * FROM workflow_policy_versions WHERE id = 'TRIP_STANDARD_V2'").get() as any;
    assert.ok(v2);
    assert.strictEqual(v2.status, 'ACTIVE');
    assert.strictEqual(v2.version, 2);

    const v2Steps = db.prepare("SELECT * FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_V2' ORDER BY step_order ASC").all() as any[];
    assert.strictEqual(v2Steps.length, 3);
    assert.strictEqual(v2Steps[0].action_type, 'REVIEW');
    assert.strictEqual(v2Steps[1].action_type, 'APPROVE');
    assert.strictEqual(v2Steps[2].action_type, 'DECIDE');
  });

  it('GT-PSBT-21: Seed複数回実行 → Principal Policy 重複なし → Existing Version Mutationなし', () => {
    const db = getDb();
    const countBefore = db.prepare("SELECT COUNT(*) as c FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_PRINCIPAL_STANDARD_V1'").get().c;
    assert.strictEqual(countBefore, 3);

    seedDatabase();
    seedDatabase();

    const countAfter = db.prepare("SELECT COUNT(*) as c FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_PRINCIPAL_STANDARD_V1'").get().c;
    assert.strictEqual(countAfter, 3, 'Principal steps count must remain exactly 3 after re-seeding');

    const versionsCount = db.prepare("SELECT COUNT(*) as c FROM workflow_policy_versions WHERE policy_id = 'TRIP_PRINCIPAL_STANDARD'").get().c;
    assert.strictEqual(versionsCount, 1, 'Principal versions count must remain exactly 1');
  });

  it('GT-PSBT-22: Semantic Partitioning が Priority Resolution より先に機能すること (同Priority 200でも一意解決)', () => {
    const db = getDb();
    const vTripStandard = db.prepare("SELECT priority FROM workflow_policy_versions WHERE id = 'TRIP_STANDARD_V2'").get() as any;
    const vTripPrincipal = db.prepare("SELECT priority FROM workflow_policy_versions WHERE id = 'TRIP_PRINCIPAL_STANDARD_V1'").get() as any;

    assert.strictEqual(vTripStandard.priority, 200);
    assert.strictEqual(vTripPrincipal.priority, 200);

    // 両者が同一Priority 200であっても、Semantic Partitioning により AMBIGUOUS (400) にならず一意解決される
    const resPrincipal = resolveWorkflowPolicy({
      appTypeId: 'BUSINESS_TRIP',
      evaluationTime: '2026-10-20',
      subjectUserId: principalUser.id,
      submittedByUserId: principalUser.id,
    });
    assert.strictEqual(resPrincipal.policyVersionId, 'TRIP_PRINCIPAL_STANDARD_V1');

    const resTeacher = resolveWorkflowPolicy({
      appTypeId: 'BUSINESS_TRIP',
      evaluationTime: '2026-10-20',
      subjectUserId: teacherUser.id,
      submittedByUserId: teacherUser.id,
    });
    assert.strictEqual(resTeacher.policyVersionId, 'TRIP_STANDARD_V2');
  });
});
