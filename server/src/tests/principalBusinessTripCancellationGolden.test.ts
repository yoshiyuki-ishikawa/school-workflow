import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { WorkflowEngine, evaluateApproverAuthorization, resolveAndValidateWorkflowSteps } from '../workflow/engine';
import { resolveWorkflowPolicy } from '../workflow/policyResolver';
import { FinalAuthoritySelfCollisionError } from '../workflow/collisionResolver';
import { UserContext } from '../types/express';

describe('Principal Self Business Trip Cancellation × TYPE-D ACK Golden Tests (GT-CANCEL-PSBT-01〜18)', () => {
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

  const validTripData = {
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

  /**
   * Helper: 校長本人の出張を提出・審査・承認完了 (TRIP_APPROVED) 状態にする
   */
  function createApprovedPrincipalTrip(): number {
    const db = getDb();
    const submitRes = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'BUSINESS_TRIP',
      title: '校長会総会出張',
      formData: validTripData,
    });
    assert.strictEqual(submitRes.success, true, submitRes.message);
    const appId = submitRes.data.id;

    // Step 1: 事務係審査
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r1 = WorkflowEngine.approveApplication(officeUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r1.success, true, r1.message);

    // Step 2: 教頭確認
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r2 = WorkflowEngine.approveApplication(vpUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r2.success, true, r2.message);

    // Step 3: 校長受領確認 (ACK)
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r3 = WorkflowEngine.approveApplication(principalUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r3.success, true, r3.message);

    app = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'TRIP_APPROVED');

    return appId;
  }

  /**
   * Helper: 一般教職員の出張を提出・確認・決裁完了 (TRIP_APPROVED) 状態にする
   */
  function createApprovedTeacherTrip(): number {
    const db = getDb();
    const submitRes = WorkflowEngine.submitApplication(teacherUser, {
      typeId: 'BUSINESS_TRIP',
      title: '教員研究協議会出張',
      formData: { ...validTripData, purpose: '研究協議会出席' },
    });
    assert.strictEqual(submitRes.success, true, submitRes.message);
    const appId = submitRes.data.id;

    // Step 1: 事務係審査
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r1 = WorkflowEngine.approveApplication(officeUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r1.success, true, r1.message);

    // Step 2: 教頭確認
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r2 = WorkflowEngine.approveApplication(vpUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r2.success, true, r2.message);

    // Step 3: 校長決裁 (DECIDE)
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r3 = WorkflowEngine.approveApplication(principalUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r3.success, true, r3.message);

    app = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'TRIP_APPROVED');

    return appId;
  }

  // ============================================================================
  // GT-CANCEL-PSBT-01〜14: 基本要件 & 非回帰契約
  // ============================================================================

  it('GT-CANCEL-PSBT-01: Principal Selfの確定済みBusiness TripからCancellation Request成功 (201)', () => {
    const db = getDb();
    const appId = createApprovedPrincipalTrip();
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    const cancelRes = WorkflowEngine.requestCancellation(principalUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '台風接近により校長会総会が延期のため',
    });

    assert.strictEqual(cancelRes.success, true, cancelRes.message);
    assert.strictEqual(cancelRes.statusCode, 201);
    assert.ok(cancelRes.data?.cycleId);
    assert.strictEqual(cancelRes.data?.approvalCycle, 2);
  });

  it('GT-CANCEL-PSBT-02: Cancellation CycleがTRIP_PRINCIPAL_STANDARD_CANCEL_V1を使用', () => {
    const db = getDb();
    const appId = createApprovedPrincipalTrip();
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(principalUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '日程変更',
    });

    const cycle = db.prepare(`
      SELECT * FROM application_workflow_cycles
      WHERE application_id = ? AND approval_cycle = 2 AND cycle_purpose = 'CANCELLATION'
    `).get(appId) as any;

    assert.ok(cycle);
    assert.strictEqual(cycle.workflow_policy_version_id, 'TRIP_PRINCIPAL_STANDARD_CANCEL_V1');
  });

  it('GT-CANCEL-PSBT-03: 生成Route: OFFICE REVIEW → VP REVIEW → PRINCIPAL SELF ACK (DECIDE不使用)', () => {
    const db = getDb();
    const appId = createApprovedPrincipalTrip();
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(principalUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '日程変更',
    });

    const steps = db.prepare(`
      SELECT * FROM application_approval_steps
      WHERE application_id = ? AND approval_cycle = 2
      ORDER BY step_order ASC
    `).all(appId) as any[];

    assert.strictEqual(steps.length, 3);

    // Step 1: 事務係審査 (REVIEW)
    assert.strictEqual(steps[0].step_order, 1);
    assert.strictEqual(steps[0].step_key, 'OFFICE_TRIP_CANCEL_STEP');
    assert.strictEqual(steps[0].action_type, 'REVIEW');
    assert.strictEqual(steps[0].required_role_id, 'OFFICE');
    assert.strictEqual(steps[0].is_final_decision_step, 0);

    // Step 2: 教頭確認 (REVIEW)
    assert.strictEqual(steps[1].step_order, 2);
    assert.strictEqual(steps[1].step_key, 'VP_TRIP_CANCEL_REVIEW_STEP');
    assert.strictEqual(steps[1].action_type, 'REVIEW');
    assert.strictEqual(steps[1].required_role_id, 'VICE_PRINCIPAL');
    assert.strictEqual(steps[1].is_final_decision_step, 0);

    // Step 3: 校長受領確認 (ACK / isFinal: 1)
    assert.strictEqual(steps[2].step_order, 3);
    assert.strictEqual(steps[2].step_key, 'PRINCIPAL_TRIP_CANCEL_ACK_STEP');
    assert.strictEqual(steps[2].action_type, 'ACK');
    assert.strictEqual(steps[2].required_role_id, 'PRINCIPAL');
    assert.strictEqual(steps[2].is_final_decision_step, 1);

    // 終端アクションが DECIDE / ORDER ではないことを保証
    const decideSteps = steps.filter((s) => s.action_type === 'DECIDE' || s.action_type === 'ORDER');
    assert.strictEqual(decideSteps.length, 0, 'No DECIDE or ORDER allowed in Principal Self Cancellation');
  });

  it('GT-CANCEL-PSBT-04: OFFICE REVIEW 正常完了 (REVIEW)', () => {
    const db = getDb();
    const appId = createApprovedPrincipalTrip();
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(principalUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '日程変更',
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r1 = WorkflowEngine.approveCancellation(officeUser, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '旅費取消確認済',
    });
    assert.strictEqual(r1.success, true, r1.message);

    const step1 = db.prepare('SELECT status FROM application_approval_steps WHERE application_id = ? AND approval_cycle = 2 AND step_order = 1').get(appId) as any;
    assert.strictEqual(step1.status, 'APPROVED');

    const step2 = db.prepare('SELECT status FROM application_approval_steps WHERE application_id = ? AND approval_cycle = 2 AND step_order = 2').get(appId) as any;
    assert.strictEqual(step2.status, 'PENDING');
  });

  it('GT-CANCEL-PSBT-05: VICE_PRINCIPAL REVIEW 正常完了 (REVIEW)', () => {
    const db = getDb();
    const appId = createApprovedPrincipalTrip();
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(principalUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '日程変更',
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(officeUser, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r2 = WorkflowEngine.approveCancellation(vpUser, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '校務調整完了',
    });
    assert.strictEqual(r2.success, true, r2.message);

    const step2 = db.prepare('SELECT status FROM application_approval_steps WHERE application_id = ? AND approval_cycle = 2 AND step_order = 2').get(appId) as any;
    assert.strictEqual(step2.status, 'APPROVED');

    const step3 = db.prepare('SELECT status FROM application_approval_steps WHERE application_id = ? AND approval_cycle = 2 AND step_order = 3').get(appId) as any;
    assert.strictEqual(step3.status, 'PENDING');
  });

  it('GT-CANCEL-PSBT-06: PRINCIPAL SELF ACK 正常完了 (Rule 1 / Rule 3 で誤遮断されない)', () => {
    const db = getDb();
    const appId = createApprovedPrincipalTrip();
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(principalUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '日程変更',
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(officeUser, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vpUser, { applicationId: appId, expectedVersion: app.version });

    // 校長本人による最終 ACK 操作 (Rule 1 & Rule 3 を通過すること)
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r3 = WorkflowEngine.approveCancellation(principalUser, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '取消確認',
    });
    assert.strictEqual(r3.success, true, r3.message);

    const step3 = db.prepare('SELECT status FROM application_approval_steps WHERE application_id = ? AND approval_cycle = 2 AND step_order = 3').get(appId) as any;
    assert.strictEqual(step3.status, 'APPROVED');
  });

  it('GT-CANCEL-PSBT-07: Final ACK後: applications.current_status === CANCELLED, cycle.status === APPROVED, version increment', () => {
    const db = getDb();
    const appId = createApprovedPrincipalTrip();
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const initialVersion = app.version;

    WorkflowEngine.requestCancellation(principalUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '日程変更',
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(officeUser, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vpUser, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(principalUser, { applicationId: appId, expectedVersion: app.version });

    // 最終検証
    app = db.prepare('SELECT current_status, version FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'CANCELLED');
    assert.ok(app.version > initialVersion);

    const cycle = db.prepare(`
      SELECT status, ended_at FROM application_workflow_cycles
      WHERE application_id = ? AND approval_cycle = 2
    `).get(appId) as any;
    assert.strictEqual(cycle.status, 'APPROVED');
    assert.ok(cycle.ended_at);
  });

  it('GT-CANCEL-PSBT-08: trip_event_members.participation_status === CANCELLED', () => {
    const db = getDb();
    const appId = createApprovedPrincipalTrip();
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(principalUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '日程変更',
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(officeUser, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vpUser, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(principalUser, { applicationId: appId, expectedVersion: app.version });

    const member = db.prepare('SELECT participation_status FROM trip_event_members WHERE application_id = ?').get(appId) as any;
    if (member) {
      assert.strictEqual(member.participation_status, 'CANCELLED');
    }
  });

  it('GT-CANCEL-PSBT-09: 一般教職員Cancellation: TRIP_STANDARD_CANCEL_V3 を解決 (Step 3: 校長取消決裁 DECIDE)', () => {
    const db = getDb();
    const appId = createApprovedTeacherTrip();
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    const cancelRes = WorkflowEngine.requestCancellation(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '研修中止',
    });
    assert.strictEqual(cancelRes.success, true);

    const cycle = db.prepare(`
      SELECT workflow_policy_version_id FROM application_workflow_cycles
      WHERE application_id = ? AND approval_cycle = 2
    `).get(appId) as any;
    assert.strictEqual(cycle.workflow_policy_version_id, 'TRIP_STANDARD_CANCEL_V3');

    const step3 = db.prepare(`
      SELECT step_name, action_type, is_final_decision_step FROM application_approval_steps
      WHERE application_id = ? AND approval_cycle = 2 AND step_order = 3
    `).get(appId) as any;
    assert.strictEqual(step3.step_name, '校長取消決裁');
    assert.strictEqual(step3.action_type, 'DECIDE');
    assert.strictEqual(step3.is_final_decision_step, 1);
  });

  it('GT-CANCEL-PSBT-10: 一般教職員が自ら起案したCancellation Stepを実行しようとすると 403 FORBIDDEN_SELF_APPROVAL', () => {
    const db = getDb();
    const appId = createApprovedTeacherTrip();
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '研修中止',
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // 教員本人が取消ステップを実行しようとする
    const illegalApprove = WorkflowEngine.approveCancellation(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(illegalApprove.success, false);
    assert.strictEqual(illegalApprove.statusCode, 403);
    assert.strictEqual(illegalApprove.errorCode, 'FORBIDDEN_SELF_APPROVAL');
  });

  it('GT-CANCEL-PSBT-11: Principal Self Cancellation終端をDECIDEにした不正Routeは HD-02 (422 FinalAuthoritySelfCollisionError)', () => {
    const invalidRouteWithDecide = [
      { stepOrder: 1, stepName: '事務係審査', stepKey: 'OFFICE_STEP', actionType: 'REVIEW', approverUserId: 5, isFinalDecisionStep: 0 },
      { stepOrder: 2, stepName: '教頭確認', stepKey: 'VP_STEP', actionType: 'REVIEW', approverUserId: 3, isFinalDecisionStep: 0 },
      { stepOrder: 3, stepName: '校長決裁', stepKey: 'PRINCIPAL_DECIDE_STEP', actionType: 'DECIDE', approverUserId: 4, isFinalDecisionStep: 1 },
    ];

    assert.throws(
      () => resolveAndValidateWorkflowSteps(4, invalidRouteWithDecide, 'BUSINESS_TRIP'),
      (err: any) => {
        assert.strictEqual(err.name, 'FinalAuthoritySelfCollisionError');
        assert.strictEqual(err.statusCode, 422);
        assert.match(err.message, /HD-02: Fail-Closed/);
        return true;
      }
    );
  });

  it('GT-CANCEL-PSBT-12: Principal本人が自己APPROVEを試行した場合 Fail-Closed (403)', () => {
    const authRes = evaluateApproverAuthorization(
      principalUser,
      { subject_user_id: 4, submitted_by_user_id: 4 },
      { cycle_purpose: 'CANCELLATION', started_by_user_id: 4 },
      { action_type: 'APPROVE', is_final_decision_step: 0, approver_user_id_snapshot: 4 }
    );
    assert.strictEqual(authRes.allowed, false);
    assert.strictEqual(authRes.statusCode, 403);
    assert.strictEqual(authRes.errorCode, 'FORBIDDEN_SELF_APPROVAL');
  });

  it('GT-CANCEL-PSBT-13: 一般教職員Policy Resolutionで TRIP_PRINCIPAL_STANDARD_CANCEL が候補から除外される (負例)', () => {
    const res = resolveWorkflowPolicy({
      appTypeId: 'BUSINESS_TRIP',
      evaluationTime: '2026-10-20T10:00:00Z',
      subjectUserId: teacherUser.id,
      policyPurpose: 'CANCELLATION',
    });
    assert.strictEqual(res.policyId, 'TRIP_STANDARD_CANCEL');
    assert.strictEqual(res.policyVersionId, 'TRIP_STANDARD_CANCEL_V3');
    assert.notStrictEqual(res.policyId, 'TRIP_PRINCIPAL_STANDARD_CANCEL');
  });

  it('GT-CANCEL-PSBT-14: Principal Self Business Trip本体が完全非回帰 (SUBMIT → TRIP_APPROVED)', () => {
    const appId = createApprovedPrincipalTrip();
    const db = getDb();
    const app = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'TRIP_APPROVED');
  });

  // ============================================================================
  // DELTA-01: Positive ACK-A Negative Matrix Golden Tests (GT-15〜18)
  // ============================================================================

  it('GT-CANCEL-PSBT-15 (NEG-A): ACK + NOT FINAL (isFinal: 0) + Principal + Subject本人 → 403 FORBIDDEN_SELF_APPROVAL', () => {
    const authRes = evaluateApproverAuthorization(
      principalUser,
      { subject_user_id: 4, submitted_by_user_id: 4 },
      { cycle_purpose: 'CANCELLATION', started_by_user_id: 4 },
      { action_type: 'ACK', is_final_decision_step: 0, approver_user_id_snapshot: 4 }
    );
    assert.strictEqual(authRes.allowed, false);
    assert.strictEqual(authRes.statusCode, 403);
    assert.strictEqual(authRes.errorCode, 'FORBIDDEN_SELF_APPROVAL');
  });

  it('GT-CANCEL-PSBT-16 (NEG-B): Final (isFinal: 1) + NOT ACK (DECIDE / APPROVE) → Fail-Closed', () => {
    // Case 1: DECIDE
    const authDecide = evaluateApproverAuthorization(
      principalUser,
      { subject_user_id: 4, submitted_by_user_id: 4 },
      { cycle_purpose: 'CANCELLATION', started_by_user_id: 4 },
      { action_type: 'DECIDE', is_final_decision_step: 1, approver_user_id_snapshot: 4 }
    );
    assert.strictEqual(authDecide.allowed, false);
    assert.strictEqual(authDecide.statusCode, 403);
    assert.strictEqual(authDecide.errorCode, 'FORBIDDEN_SELF_APPROVAL');

    // Case 2: APPROVE
    const authApprove = evaluateApproverAuthorization(
      principalUser,
      { subject_user_id: 4, submitted_by_user_id: 4 },
      { cycle_purpose: 'CANCELLATION', started_by_user_id: 4 },
      { action_type: 'APPROVE', is_final_decision_step: 1, approver_user_id_snapshot: 4 }
    );
    assert.strictEqual(authApprove.allowed, false);
    assert.strictEqual(authApprove.statusCode, 403);
    assert.strictEqual(authApprove.errorCode, 'FORBIDDEN_SELF_APPROVAL');
  });

  it('GT-CANCEL-PSBT-17 (NEG-C): Final ACK (isFinal: 1, ACK) + NOT PRINCIPAL (Teacher) → Fail-Closed', () => {
    const authRes = evaluateApproverAuthorization(
      teacherUser,
      { subject_user_id: 1, submitted_by_user_id: 1 },
      { cycle_purpose: 'CANCELLATION', started_by_user_id: 1 },
      { action_type: 'ACK', is_final_decision_step: 1, approver_user_id_snapshot: 1 }
    );
    assert.strictEqual(authRes.allowed, false);
    assert.strictEqual(authRes.statusCode, 403);
    assert.strictEqual(authRes.errorCode, 'FORBIDDEN_SELF_APPROVAL');
  });

  it('GT-CANCEL-PSBT-18 (NEG-D): Final ACK + Wrong Actor / Subject Relation (教頭が校長のACKステップ実行) → 403 FORBIDDEN_APPROVAL_ROLE', () => {
    const db = getDb();
    const appId = createApprovedPrincipalTrip();
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(principalUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '日程変更',
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(officeUser, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vpUser, { applicationId: appId, expectedVersion: app.version });

    // 教頭 (User 3) が校長受領確認ステップ (Step 3: 指定担当者 User 4) の承認を試みる
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const illegalStep3 = WorkflowEngine.approveCancellation(vpUser, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(illegalStep3.success, false);
    assert.strictEqual(illegalStep3.statusCode, 403);
    assert.match(illegalStep3.message, /このステップの承認権限がありません/);

    // evaluateApproverAuthorization レベルでも FORBIDDEN_APPROVAL_ROLE を直接検証
    const authRes = evaluateApproverAuthorization(
      vpUser,
      { subject_user_id: 4, submitted_by_user_id: 4 },
      { cycle_purpose: 'CANCELLATION', started_by_user_id: 4 },
      { action_type: 'ACK', is_final_decision_step: 1, approver_user_id_snapshot: 4 }
    );
    assert.strictEqual(authRes.allowed, false);
    assert.strictEqual(authRes.statusCode, 403);
    assert.strictEqual(authRes.action, 'FORBIDDEN_APPROVAL_ROLE');
  });
});
