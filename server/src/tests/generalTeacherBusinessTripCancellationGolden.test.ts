import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { WorkflowEngine } from '../workflow/engine';
import { resolveWorkflowPolicy } from '../workflow/policyResolver';
import { resolveCancellationDeclineSemantic } from '../workflow/historicalResolver';
import { ApplicationWorkflowService } from '../services/applicationWorkflowService';
import { UserContext } from '../types/express';

describe('General Teacher Business Trip Cancellation × Canonical V3 Policy Golden Tests (GT-GTBT-CANCEL-01〜13)', () => {
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

  const createTripData = (date: string, purpose: string = '教科指導研修会出席') => ({
    startDate: date,
    endDate: date,
    startAt: `${date}T09:00:00`,
    endAt: `${date}T17:00:00`,
    destination: '地区教育センター',
    departurePlace: '本校',
    arrivalPlace: '本校',
    purpose,
    transport: '公共交通機関',
    fundingSource: '市費',
  });

  /**
   * Helper: 一般教員の出張を提出・審査・承認・決裁完了 (TRIP_APPROVED) 状態にする
   */
  function createApprovedTeacherTrip(date: string = '2026-10-20'): number {
    const db = getDb();
    const submitRes = WorkflowEngine.submitApplication(teacherUser, {
      typeId: 'BUSINESS_TRIP',
      title: '教員研究研修出張',
      formData: createTripData(date),
    });
    assert.strictEqual(submitRes.success, true, submitRes.message);
    const appId = submitRes.data.id;

    // Step 1: 事務係審査 (OFFICE REVIEW)
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r1 = WorkflowEngine.approveApplication(officeUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r1.success, true, r1.message);

    // Step 2: 教頭確認 (VP APPROVE)
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r2 = WorkflowEngine.approveApplication(vpUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r2.success, true, r2.message);

    // Step 3: 校長決裁 (PRINCIPAL DECIDE)
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r3 = WorkflowEngine.approveApplication(principalUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r3.success, true, r3.message);

    app = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'TRIP_APPROVED');

    return appId;
  }

  /**
   * Helper: 校長本人の出張を提出・審査・承認・受領確認完了 (TRIP_APPROVED) 状態にする
   */
  function createApprovedPrincipalTrip(date: string = '2026-10-25'): number {
    const db = getDb();
    const submitRes = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'BUSINESS_TRIP',
      title: '校長会総会出張',
      formData: { ...createTripData(date), destination: '県庁教育委員会', purpose: '校長会総会出席' },
    });
    assert.strictEqual(submitRes.success, true, submitRes.message);
    const appId = submitRes.data.id;

    // Step 1: 事務係審査 (OFFICE REVIEW)
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r1 = WorkflowEngine.approveApplication(officeUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r1.success, true, r1.message);

    // Step 2: 教頭確認 (VP REVIEW)
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r2 = WorkflowEngine.approveApplication(vpUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r2.success, true, r2.message);

    // Step 3: 校長受領確認 (PRINCIPAL ACK)
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r3 = WorkflowEngine.approveApplication(principalUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r3.success, true, r3.message);

    app = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'TRIP_APPROVED');

    return appId;
  }

  // ============================================================================
  // GT-GTBT-CANCEL-01: 新規一般教員出張取消が TRIP_STANDARD_CANCEL_V3 へBinding
  // ============================================================================
  it('GT-GTBT-CANCEL-01: 新規一般教員出張取消が TRIP_STANDARD_CANCEL_V3 へBindingされる', () => {
    const db = getDb();
    const appId = createApprovedTeacherTrip('2026-10-20');
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    const cancelRes = WorkflowEngine.requestCancellation(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '研修会の日程が中止・延期となったため',
    });

    assert.strictEqual(cancelRes.success, true, cancelRes.message);
    assert.strictEqual(cancelRes.statusCode, 201);

    const cycle = db.prepare(`
      SELECT * FROM application_workflow_cycles
      WHERE application_id = ? AND cycle_purpose = 'CANCELLATION'
    `).get(appId) as any;

    assert.ok(cycle);
    assert.strictEqual(cycle.workflow_policy_version_id, 'TRIP_STANDARD_CANCEL_V3');

    // Policy Resolver による直接検証
    const resolved = resolveWorkflowPolicy({
      appTypeId: 'BUSINESS_TRIP',
      evaluationTime: '2026-10-20',
      subjectUserId: teacherUser.id,
      submittedByUserId: teacherUser.id,
      policyPurpose: 'CANCELLATION',
    });
    assert.strictEqual(resolved.policyVersionId, 'TRIP_STANDARD_CANCEL_V3');
    assert.strictEqual(resolved.policyId, 'TRIP_STANDARD_CANCEL');
  });

  // ============================================================================
  // GT-GTBT-CANCEL-02: 提出直後：OFFICE = Pending, VICE_PRINCIPAL = Not Pending, PRINCIPAL = Not Pending
  // ============================================================================
  it('GT-GTBT-CANCEL-02: 提出直後：OFFICE = Pending, VICE_PRINCIPAL = Not Pending, PRINCIPAL = Not Pending', () => {
    const db = getDb();
    const appId = createApprovedTeacherTrip('2026-10-20');
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '研修中止',
    });

    // DB 上の各ステップの状態確認
    const steps = db.prepare(`
      SELECT step_order, step_name, step_key, action_type, required_role_id, status, is_final_decision_step
      FROM application_approval_steps
      WHERE application_id = ? AND approval_cycle = 2
      ORDER BY step_order ASC
    `).all(appId) as any[];

    assert.strictEqual(steps.length, 3);

    // Step 1: 事務係審査 (OFFICE REVIEW) - PENDING
    assert.strictEqual(steps[0].step_order, 1);
    assert.strictEqual(steps[0].step_key, 'OFFICE_TRIP_CANCEL_STEP');
    assert.strictEqual(steps[0].action_type, 'REVIEW');
    assert.strictEqual(steps[0].required_role_id, 'OFFICE');
    assert.strictEqual(steps[0].status, 'PENDING');

    // Step 2: 教頭取消確認 (VP APPROVE) - WAITING
    assert.strictEqual(steps[1].step_order, 2);
    assert.strictEqual(steps[1].step_key, 'VP_TRIP_CANCEL_STEP');
    assert.strictEqual(steps[1].action_type, 'APPROVE');
    assert.strictEqual(steps[1].required_role_id, 'VICE_PRINCIPAL');
    assert.strictEqual(steps[1].status, 'WAITING');

    // Step 3: 校長取消決裁 (PRINCIPAL DECIDE) - WAITING
    assert.strictEqual(steps[2].step_order, 3);
    assert.strictEqual(steps[2].step_key, 'PRINCIPAL_TRIP_CANCEL_STEP');
    assert.strictEqual(steps[2].action_type, 'DECIDE');
    assert.strictEqual(steps[2].required_role_id, 'PRINCIPAL');
    assert.strictEqual(steps[2].status, 'WAITING');
    assert.strictEqual(steps[2].is_final_decision_step, 1);

    // Pending Tasks API レベルでの可視性確認
    const officeTasks = ApplicationWorkflowService.getPendingApplicationsForUser(officeUser);
    const vpTasks = ApplicationWorkflowService.getPendingApplicationsForUser(vpUser);
    const principalTasks = ApplicationWorkflowService.getPendingApplicationsForUser(principalUser);

    const hasOfficeTask = officeTasks.some((t: any) => t.application_id === appId);
    const hasVpTask = vpTasks.some((t: any) => t.application_id === appId);
    const hasPrincipalTask = principalTasks.some((t: any) => t.application_id === appId);

    assert.strictEqual(hasOfficeTask, true, '事務の未処理一覧に出現すること');
    assert.strictEqual(hasVpTask, false, '教頭の未処理一覧には出現しないこと');
    assert.strictEqual(hasPrincipalTask, false, '校長の未処理一覧には出現しないこと');
  });

  // ============================================================================
  // GT-GTBT-CANCEL-03: OFFICE が REVIEW 実行後、VICE_PRINCIPAL へ進む
  // ============================================================================
  it('GT-GTBT-CANCEL-03: OFFICE が REVIEW 実行後、VICE_PRINCIPAL へ進む', () => {
    const db = getDb();
    const appId = createApprovedTeacherTrip('2026-10-20');
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '研修延期',
    });

    // 事務が審査 (REVIEW)
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r1 = WorkflowEngine.approveCancellation(officeUser, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '旅費払戻し確認済み、キャンセル料なし',
    });
    assert.strictEqual(r1.success, true, r1.message);

    // DB ステップ状態確認
    const steps = db.prepare(`
      SELECT step_order, status FROM application_approval_steps
      WHERE application_id = ? AND approval_cycle = 2
      ORDER BY step_order ASC
    `).all(appId) as any[];

    assert.strictEqual(steps[0].status, 'APPROVED', 'Step 1 (事務) は完了');
    assert.strictEqual(steps[1].status, 'PENDING', 'Step 2 (教頭) が PENDING に遷移');
    assert.strictEqual(steps[2].status, 'WAITING', 'Step 3 (校長) は WAITING');

    // 教頭の Pending Tasks に出現、事務・校長には出現しない
    const officeTasks = ApplicationWorkflowService.getPendingApplicationsForUser(officeUser);
    const vpTasks = ApplicationWorkflowService.getPendingApplicationsForUser(vpUser);
    const principalTasks = ApplicationWorkflowService.getPendingApplicationsForUser(principalUser);

    assert.strictEqual(officeTasks.some((t: any) => t.application_id === appId), false);
    assert.strictEqual(vpTasks.some((t: any) => t.application_id === appId), true, '教頭の未処理一覧に出現すること');
    assert.strictEqual(principalTasks.some((t: any) => t.application_id === appId), false);
  });

  // ============================================================================
  // GT-GTBT-CANCEL-04: VICE_PRINCIPAL が APPROVE 実行後、PRINCIPAL へ進む
  // ============================================================================
  it('GT-GTBT-CANCEL-04: VICE_PRINCIPAL が APPROVE 実行後、PRINCIPAL へ進む', () => {
    const db = getDb();
    const appId = createApprovedTeacherTrip('2026-10-20');
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '研修延期',
    });

    // Step 1: 事務 REVIEW
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(officeUser, { applicationId: appId, expectedVersion: app.version });

    // Step 2: 教頭 APPROVE
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r2 = WorkflowEngine.approveCancellation(vpUser, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '校務分担再調整完了・副申',
    });
    assert.strictEqual(r2.success, true, r2.message);

    // DB ステップ状態確認
    const steps = db.prepare(`
      SELECT step_order, status FROM application_approval_steps
      WHERE application_id = ? AND approval_cycle = 2
      ORDER BY step_order ASC
    `).all(appId) as any[];

    assert.strictEqual(steps[0].status, 'APPROVED');
    assert.strictEqual(steps[1].status, 'APPROVED');
    assert.strictEqual(steps[2].status, 'PENDING', 'Step 3 (校長) が PENDING に遷移');

    // 校長の Pending Tasks に出現
    const vpTasks = ApplicationWorkflowService.getPendingApplicationsForUser(vpUser);
    const principalTasks = ApplicationWorkflowService.getPendingApplicationsForUser(principalUser);

    assert.strictEqual(vpTasks.some((t: any) => t.application_id === appId), false);
    assert.strictEqual(principalTasks.some((t: any) => t.application_id === appId), true, '校長の未処理一覧に出現すること');
  });

  // ============================================================================
  // GT-GTBT-CANCEL-05: PRINCIPAL が DECIDE により、isFinalDecisionStep = 1 でWorkflow完了
  // ============================================================================
  it('GT-GTBT-CANCEL-05: PRINCIPAL が DECIDE により、isFinalDecisionStep = 1 でWorkflow完了', () => {
    const db = getDb();
    const appId = createApprovedTeacherTrip('2026-10-20');
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '研修延期',
    });

    // Step 1: 事務 REVIEW
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(officeUser, { applicationId: appId, expectedVersion: app.version });

    // Step 2: 教頭 APPROVE
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vpUser, { applicationId: appId, expectedVersion: app.version });

    // Step 3: 校長 DECIDE
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r3 = WorkflowEngine.approveCancellation(principalUser, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '旅行命令取消決裁',
    });
    assert.strictEqual(r3.success, true, r3.message);

    // サイクル状態が APPROVED
    const cycle = db.prepare(`
      SELECT status FROM application_workflow_cycles
      WHERE application_id = ? AND approval_cycle = 2
    `).get(appId) as any;
    assert.strictEqual(cycle.status, 'APPROVED');
  });

  // ============================================================================
  // GT-GTBT-CANCEL-06: Cancellation成立後、CANCELLED へ正しく遷移
  // ============================================================================
  it('GT-GTBT-CANCEL-06: Cancellation成立後、CANCELLED へ正しく遷移', () => {
    const db = getDb();
    const appId = createApprovedTeacherTrip('2026-10-20');
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '研修延期',
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(officeUser, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vpUser, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(principalUser, { applicationId: appId, expectedVersion: app.version });

    // アプリケーション本体のステータスが CANCELLED
    const finalApp = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(finalApp.current_status, 'CANCELLED');
  });

  // ============================================================================
  // GT-GTBT-CANCEL-07: V3導入前にV2 Binding済みのWorkflowは、V2 Route を維持
  // ============================================================================
  it('GT-GTBT-CANCEL-07: V3導入前にV2 Binding済みのWorkflowは、V2 Route を維持', () => {
    const db = getDb();
    const appId = createApprovedTeacherTrip('2026-10-20');

    // 1. 一時的に V2 を ACTIVE、V3 を INACTIVE にして取消申請を提出（V2バインディング再現）
    db.prepare("UPDATE workflow_policy_versions SET status = 'INACTIVE' WHERE id = 'TRIP_STANDARD_CANCEL_V3'").run();
    db.prepare("UPDATE workflow_policy_versions SET status = 'ACTIVE' WHERE id = 'TRIP_STANDARD_CANCEL_V2'").run();

    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const cancelRes = WorkflowEngine.requestCancellation(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: 'V2バインドテスト',
    });
    assert.strictEqual(cancelRes.success, true);

    const cycle = db.prepare("SELECT id, workflow_policy_version_id FROM application_workflow_cycles WHERE application_id = ? AND cycle_purpose = 'CANCELLATION'").get(appId) as any;
    assert.strictEqual(cycle.workflow_policy_version_id, 'TRIP_STANDARD_CANCEL_V2');

    // 2. V3 を ACTIVE に切り替え（移行シミュレーション）
    db.prepare("UPDATE workflow_policy_versions SET status = 'INACTIVE' WHERE id = 'TRIP_STANDARD_CANCEL_V2'").run();
    db.prepare("UPDATE workflow_policy_versions SET status = 'ACTIVE' WHERE id = 'TRIP_STANDARD_CANCEL_V3'").run();

    // 3. V3 が ACTIVE な環境下でも、この既存ワークフローは V2 スナップショット（教頭 APPROVE → 校長 DECIDE → 事務 ACK）に従って動作する
    // Step 1: 教頭 APPROVE
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r1 = WorkflowEngine.approveCancellation(vpUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r1.success, true);

    // Step 2: 校長 DECIDE
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r2 = WorkflowEngine.approveCancellation(principalUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r2.success, true);

    // Step 3: 事務 ACK
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r3 = WorkflowEngine.approveCancellation(officeUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r3.success, true);

    // サイクルが保持していたバージョン ID が TRIP_STANDARD_CANCEL_V2 のままであること
    const finalCycle = db.prepare('SELECT workflow_policy_version_id, status FROM application_workflow_cycles WHERE id = ?').get(cycle.id) as any;
    assert.strictEqual(finalCycle.workflow_policy_version_id, 'TRIP_STANDARD_CANCEL_V2');
    assert.strictEqual(finalCycle.status, 'APPROVED');
  });

  // ============================================================================
  // GT-GTBT-CANCEL-08: V3 Activation後の新規Cancellationだけ、V3 へBinding
  // ============================================================================
  it('GT-GTBT-CANCEL-08: V3 Activation後の新規Cancellationだけ、V3 へBinding', () => {
    const db = getDb();
    const app1 = createApprovedTeacherTrip('2026-10-21');
    const app2 = createApprovedTeacherTrip('2026-10-22');

    let a1 = db.prepare('SELECT version FROM applications WHERE id = ?').get(app1) as any;
    let a2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(app2) as any;

    WorkflowEngine.requestCancellation(teacherUser, { applicationId: app1, expectedVersion: a1.version, cancellationReason: '理由1' });
    WorkflowEngine.requestCancellation(teacherUser, { applicationId: app2, expectedVersion: a2.version, cancellationReason: '理由2' });

    const c1 = db.prepare("SELECT workflow_policy_version_id FROM application_workflow_cycles WHERE application_id = ? AND cycle_purpose = 'CANCELLATION'").get(app1) as any;
    const c2 = db.prepare("SELECT workflow_policy_version_id FROM application_workflow_cycles WHERE application_id = ? AND cycle_purpose = 'CANCELLATION'").get(app2) as any;

    assert.strictEqual(c1.workflow_policy_version_id, 'TRIP_STANDARD_CANCEL_V3');
    assert.strictEqual(c2.workflow_policy_version_id, 'TRIP_STANDARD_CANCEL_V3');
  });

  // ============================================================================
  // GT-GTBT-CANCEL-09: 通常一般教員出張：TRIP_STANDARD_V2 非回帰
  // ============================================================================
  it('GT-GTBT-CANCEL-09: 通常一般教員出張：TRIP_STANDARD_V2 非回帰 (事務 REVIEW → 教頭 APPROVE → 校長 DECIDE)', () => {
    const db = getDb();
    const submitRes = WorkflowEngine.submitApplication(teacherUser, {
      typeId: 'BUSINESS_TRIP',
      title: '通常出張非回帰検証',
      formData: createTripData('2026-10-20'),
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    // ポリシー解決が TRIP_STANDARD_V2
    const cycle = db.prepare('SELECT workflow_policy_version_id FROM application_workflow_cycles WHERE application_id = ?').get(appId) as any;
    assert.strictEqual(cycle.workflow_policy_version_id, 'TRIP_STANDARD_V2');

    // Step 1: 事務 REVIEW
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r1 = WorkflowEngine.approveApplication(officeUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r1.success, true);

    // Step 2: 教頭 APPROVE
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r2 = WorkflowEngine.approveApplication(vpUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r2.success, true);

    // Step 3: 校長 DECIDE
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r3 = WorkflowEngine.approveApplication(principalUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r3.success, true);

    app = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'TRIP_APPROVED');
  });

  // ============================================================================
  // GT-GTBT-CANCEL-10: 校長本人出張：TRIP_PRINCIPAL_STANDARD_V1 非回帰
  // ============================================================================
  it('GT-GTBT-CANCEL-10: 校長本人出張：TRIP_PRINCIPAL_STANDARD_V1 非回帰 (事務 REVIEW → 教頭 REVIEW → 校長 ACK)', () => {
    const db = getDb();
    const submitRes = WorkflowEngine.submitApplication(principalUser, {
      typeId: 'BUSINESS_TRIP',
      title: '校長出張本体非回帰検証',
      formData: { ...createTripData('2026-10-20'), destination: '県庁教育委員会', purpose: '校長会出席' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    // ポリシー解決が TRIP_PRINCIPAL_STANDARD_V1
    const cycle = db.prepare('SELECT workflow_policy_version_id FROM application_workflow_cycles WHERE application_id = ?').get(appId) as any;
    assert.strictEqual(cycle.workflow_policy_version_id, 'TRIP_PRINCIPAL_STANDARD_V1');

    // Step 1: 事務 REVIEW
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r1 = WorkflowEngine.approveApplication(officeUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r1.success, true);

    // Step 2: 教頭 REVIEW
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r2 = WorkflowEngine.approveApplication(vpUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r2.success, true);

    // Step 3: 校長 ACK
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r3 = WorkflowEngine.approveApplication(principalUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r3.success, true);

    app = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'TRIP_APPROVED');
  });

  // ============================================================================
  // GT-GTBT-CANCEL-11: 校長本人出張取消：TRIP_PRINCIPAL_STANDARD_CANCEL_V1 非回帰
  // ============================================================================
  it('GT-GTBT-CANCEL-11: 校長本人出張取消：TRIP_PRINCIPAL_STANDARD_CANCEL_V1 非回帰 (事務 REVIEW → 教頭 REVIEW → 校長 ACK)', () => {
    const db = getDb();
    const appId = createApprovedPrincipalTrip('2026-10-20');
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    const cancelRes = WorkflowEngine.requestCancellation(principalUser, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '校長出張取消非回帰検証',
    });
    assert.strictEqual(cancelRes.success, true);

    // 取消サイクルが TRIP_PRINCIPAL_STANDARD_CANCEL_V1
    const cycle = db.prepare("SELECT workflow_policy_version_id FROM application_workflow_cycles WHERE application_id = ? AND cycle_purpose = 'CANCELLATION'").get(appId) as any;
    assert.strictEqual(cycle.workflow_policy_version_id, 'TRIP_PRINCIPAL_STANDARD_CANCEL_V1');

    // Step 1: 事務 REVIEW
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r1 = WorkflowEngine.approveCancellation(officeUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r1.success, true);

    // Step 2: 教頭 REVIEW
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r2 = WorkflowEngine.approveCancellation(vpUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r2.success, true);

    // Step 3: 校長 ACK
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const r3 = WorkflowEngine.approveCancellation(principalUser, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(r3.success, true);

    app = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'CANCELLED');
  });

  // ============================================================================
  // GT-GTBT-CANCEL-12: Historical: TRIP_STANDARD_CANCEL_V1, TRIP_STANDARD_CANCEL_V2 のStep Definition非破壊
  // ============================================================================
  it('GT-GTBT-CANCEL-12: Historical: TRIP_STANDARD_CANCEL_V1, TRIP_STANDARD_CANCEL_V2 のStep Definition非破壊', () => {
    const db = getDb();

    // V1 確認 (INACTIVE, 3 steps: VP APPROVE → PRINCIPAL DECIDE → OFFICE CHECK)
    const v1 = db.prepare("SELECT status FROM workflow_policy_versions WHERE id = 'TRIP_STANDARD_CANCEL_V1'").get() as any;
    assert.ok(v1);
    assert.strictEqual(v1.status, 'INACTIVE');
    const v1Steps = db.prepare("SELECT step_order, action_type, step_key FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_CANCEL_V1' ORDER BY step_order").all() as any[];
    assert.strictEqual(v1Steps.length, 3);
    assert.strictEqual(v1Steps[0].action_type, 'APPROVE');
    assert.strictEqual(v1Steps[0].step_key, 'VP_TRIP_CANCEL_STEP');
    assert.strictEqual(v1Steps[1].action_type, 'DECIDE');
    assert.strictEqual(v1Steps[1].step_key, 'PRINCIPAL_TRIP_CANCEL_STEP');
    assert.strictEqual(v1Steps[2].action_type, 'CHECK');
    assert.strictEqual(v1Steps[2].step_key, 'OFFICE_CANCEL_STEP');

    // V2 確認 (INACTIVE, 3 steps: VP APPROVE → PRINCIPAL DECIDE → OFFICE ACK)
    const v2 = db.prepare("SELECT status FROM workflow_policy_versions WHERE id = 'TRIP_STANDARD_CANCEL_V2'").get() as any;
    assert.ok(v2);
    assert.strictEqual(v2.status, 'INACTIVE');
    const v2Steps = db.prepare("SELECT step_order, action_type, step_key FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_CANCEL_V2' ORDER BY step_order").all() as any[];
    assert.strictEqual(v2Steps.length, 3);
    assert.strictEqual(v2Steps[0].action_type, 'APPROVE');
    assert.strictEqual(v2Steps[0].step_key, 'VP_TRIP_CANCEL_STEP');
    assert.strictEqual(v2Steps[1].action_type, 'DECIDE');
    assert.strictEqual(v2Steps[1].step_key, 'PRINCIPAL_TRIP_CANCEL_STEP');
    assert.strictEqual(v2Steps[2].action_type, 'ACK');
    assert.strictEqual(v2Steps[2].step_key, 'OFFICE_CANCEL_STEP');

    // V3 確認 (ACTIVE, 3 steps: OFFICE REVIEW → VP APPROVE → PRINCIPAL DECIDE)
    const v3 = db.prepare("SELECT status FROM workflow_policy_versions WHERE id = 'TRIP_STANDARD_CANCEL_V3'").get() as any;
    assert.ok(v3);
    assert.strictEqual(v3.status, 'ACTIVE');
    const v3Steps = db.prepare("SELECT step_order, action_type, step_key FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_CANCEL_V3' ORDER BY step_order").all() as any[];
    assert.strictEqual(v3Steps.length, 3);
    assert.strictEqual(v3Steps[0].action_type, 'REVIEW');
    assert.strictEqual(v3Steps[0].step_key, 'OFFICE_TRIP_CANCEL_STEP');
    assert.strictEqual(v3Steps[1].action_type, 'APPROVE');
    assert.strictEqual(v3Steps[1].step_key, 'VP_TRIP_CANCEL_STEP');
    assert.strictEqual(v3Steps[2].action_type, 'DECIDE');
    assert.strictEqual(v3Steps[2].step_key, 'PRINCIPAL_TRIP_CANCEL_STEP');
  });

  // ============================================================================
  // GT-GTBT-CANCEL-13: DECLINE_CANCELLATION Semantic非回帰
  // ============================================================================
  it('GT-GTBT-CANCEL-13: DECLINE_CANCELLATION Semantic非回帰 (中間ステップは却下不可・終端校長のみDECLINE_CANCELLATION実行可能)', () => {
    const db = getDb();

    // 1. Step 1 (事務 REVIEW) は取消不同意 (reject) 不可（INV-01, INVALID_ACTION_FOR_REVIEW 422）
    const app1 = createApprovedTeacherTrip('2026-10-20');
    let a1 = db.prepare('SELECT version FROM applications WHERE id = ?').get(app1) as any;
    WorkflowEngine.requestCancellation(teacherUser, { applicationId: app1, expectedVersion: a1.version, cancellationReason: '取消申出1' });
    a1 = db.prepare('SELECT version FROM applications WHERE id = ?').get(app1) as any;
    const rejRes1 = WorkflowEngine.rejectCancellation(officeUser, {
      applicationId: app1,
      expectedVersion: a1.version,
      comment: '事務却下試行',
    });
    assert.strictEqual(rejRes1.success, false);
    assert.strictEqual(rejRes1.statusCode, 422);
    assert.strictEqual(rejRes1.errorCode, 'INVALID_ACTION_FOR_REVIEW');

    // 2. Step 2 (教頭 APPROVE) も中間ステップのため取消不同意 (reject) 不可（INV-01, INVALID_ACTION_FOR_REVIEW 422）
    const app2 = createApprovedTeacherTrip('2026-10-21');
    let a2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(app2) as any;
    WorkflowEngine.requestCancellation(teacherUser, { applicationId: app2, expectedVersion: a2.version, cancellationReason: '取消申出2' });
    a2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(app2) as any;
    WorkflowEngine.approveCancellation(officeUser, { applicationId: app2, expectedVersion: a2.version });
    a2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(app2) as any;
    const rejRes2 = WorkflowEngine.rejectCancellation(vpUser, {
      applicationId: app2,
      expectedVersion: a2.version,
      comment: '教頭却下試行',
    });
    assert.strictEqual(rejRes2.success, false);
    assert.strictEqual(rejRes2.statusCode, 422);
    assert.strictEqual(rejRes2.errorCode, 'INVALID_ACTION_FOR_REVIEW');

    // 3. Step 3 (校長 DECIDE / 終端) は取消不同意 (DECLINE_CANCELLATION) 実行可能
    const app3 = createApprovedTeacherTrip('2026-10-22');
    let a3 = db.prepare('SELECT version FROM applications WHERE id = ?').get(app3) as any;
    WorkflowEngine.requestCancellation(teacherUser, { applicationId: app3, expectedVersion: a3.version, cancellationReason: '取消申出3' });
    a3 = db.prepare('SELECT version FROM applications WHERE id = ?').get(app3) as any;
    WorkflowEngine.approveCancellation(officeUser, { applicationId: app3, expectedVersion: a3.version });
    a3 = db.prepare('SELECT version FROM applications WHERE id = ?').get(app3) as any;
    WorkflowEngine.approveCancellation(vpUser, { applicationId: app3, expectedVersion: a3.version });
    a3 = db.prepare('SELECT version FROM applications WHERE id = ?').get(app3) as any;
    const rejRes3 = WorkflowEngine.rejectCancellation(principalUser, {
      applicationId: app3,
      expectedVersion: a3.version,
      comment: '旅行命令撤回を不認可',
    });
    assert.strictEqual(rejRes3.success, true);
    const declinedApp3 = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(app3) as any;
    assert.strictEqual(declinedApp3.current_status, 'TRIP_APPROVED', '校長決裁却下時も元出張は TRIP_APPROVED を維持');

    // セマンティクス解決関数の直接検証
    const semantic = resolveCancellationDeclineSemantic({
      cyclePurpose: 'CANCELLATION',
      stepActionType: 'DECIDE',
      isFinalDecisionStep: true,
      engineAction: 'REJECT',
    });
    assert.strictEqual(semantic, 'DECLINE_CANCELLATION');
  });
});
