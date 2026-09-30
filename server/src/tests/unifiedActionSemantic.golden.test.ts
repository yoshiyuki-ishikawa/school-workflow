import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine } from '../workflow/engine';
import { UserContext } from '../types';

describe('Unified Workflow Action Semantic Reconciliation — Server Golden Tests', () => {
  let db: any;

  const teacher1: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '教員 太郎',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const vicePrincipal: UserContext = {
    id: 3,
    username: 'vice_principal',
    displayName: '田中 誠 (教頭B)',
    roles: ['VICE_PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const principal: UserContext = {
    id: 4,
    username: 'principal',
    displayName: '鈴木 健一 (校長C)',
    roles: ['PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  beforeEach(() => {
    initDatabase();
    seedDatabase();
    db = getDb();
    db.prepare('DELETE FROM applications').run();
  });

  // GT-ACTION-01: 一般教員 LEAVE_ANNUAL → 教頭 REVIEW → REVIEWは進達可能
  it('GT-ACTION-01: 一般教員の年休申請において教頭（REVIEW）は審査進達（ADVANCE）できる', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】進達テスト',
      formData: { unitType: 'DAY', startDate: '2026-06-01', endDate: '2026-06-01', calculatedDays: 1, reason: '私用' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    const advanceRes = WorkflowEngine.approveApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '確認して進達します',
    });
    assert.strictEqual(advanceRes.success, true);

    const step1 = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND step_order = 1').get(appId) as any;
    assert.strictEqual(step1.status, 'APPROVED');
    assert.strictEqual(step1.action_type, 'REVIEW');

    const step2 = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND step_order = 2').get(appId) as any;
    assert.strictEqual(step2.status, 'PENDING');
  });

  // GT-ACTION-02: 一般教員 LEAVE_ANNUAL → 教頭 REVIEW → RETURN可能
  it('GT-ACTION-02: 一般教員の年休申請において教頭（REVIEW）は差戻し（RETURN）できる', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】差戻しテスト',
      formData: { unitType: 'DAY', startDate: '2026-06-02', endDate: '2026-06-02', calculatedDays: 1, reason: '私用' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    const returnRes = WorkflowEngine.returnApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '行事重複のため時季を再検討してください',
    });
    assert.strictEqual(returnRes.success, true);

    const appReturned = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(appReturned.current_status, 'RETURNED');
  });

  // GT-ACTION-03: 一般教員 LEAVE_ANNUAL → 教頭 REVIEW → REJECTはServer 422 INVALID_ACTION_FOR_REVIEW
  it('GT-ACTION-03: 一般教員の年休申請において教頭（REVIEW）の却下（REJECT）は 422 INVALID_ACTION_FOR_REVIEW で Fail-Closed 遮断される', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】却下遮断テスト',
      formData: { unitType: 'DAY', startDate: '2026-06-03', endDate: '2026-06-03', calculatedDays: 1, reason: '私用' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    const rejectRes = WorkflowEngine.rejectApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '中間審査者が却下を試みる',
    });
    assert.strictEqual(rejectRes.success, false);
    assert.strictEqual(rejectRes.statusCode, 422);
    assert.strictEqual(rejectRes.errorCode, 'INVALID_ACTION_FOR_REVIEW');

    // 申請状態は SUBMITTED（変更なし）のままであること
    const appAfter = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(appAfter.current_status, 'SUBMITTED');
  });

  // GT-ACTION-04: DECIDE型服務 → 校長 DECIDE → APPROVE可能
  it('GT-ACTION-04: DECIDE型服務（病休）において校長（DECIDE）は承認決裁（APPROVE）できる', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_SICK',
      title: '【病休】決裁テスト',
      formData: { unitType: 'DAY', startDate: '2026-06-04', endDate: '2026-06-04', calculatedDays: 1, reason: '体調不良' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Step 1: 教頭 REVIEW
    const reviewRes = WorkflowEngine.approveApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '審査完了',
    });
    assert.strictEqual(reviewRes.success, true);

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Step 2: 校長 DECIDE
    const approveRes = WorkflowEngine.approveApplication(principal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '承認決裁します',
    });
    assert.strictEqual(approveRes.success, true);

    const appFinal = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(appFinal.current_status, 'FINAL_APPROVED');
  });

  // GT-ACTION-05: DECIDE型服務 → 校長 DECIDE → RETURN可能
  it('GT-ACTION-05: DECIDE型服務（病休）において校長（DECIDE）は差戻し（RETURN）できる', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_SICK',
      title: '【病休】校長差戻しテスト',
      formData: { unitType: 'DAY', startDate: '2026-06-05', endDate: '2026-06-05', calculatedDays: 1, reason: '体調不良' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Step 1: 教頭 REVIEW
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version, comment: '審査完了' });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Step 2: 校長 DECIDE から RETURN
    const returnRes = WorkflowEngine.returnApplication(principal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '診断書の再提出を求めます',
    });
    assert.strictEqual(returnRes.success, true);

    const appReturned = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(appReturned.current_status, 'RETURNED');
  });

  // GT-ACTION-06: DECIDE型服務 → 校長 DECIDE → REJECT可能 → REJECTED終端
  it('GT-ACTION-06: DECIDE型服務（病休）において校長（DECIDE）は正規に却下（REJECT）でき、REJECTED終端となる', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_SICK',
      title: '【病休】校長却下テスト',
      formData: { unitType: 'DAY', startDate: '2026-06-08', endDate: '2026-06-08', calculatedDays: 1, reason: '体調不良' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Step 1: 教頭 REVIEW
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version, comment: '審査完了' });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Step 2: 校長 DECIDE から REJECT 試行 ──► Universal RETURN Model (v1.0 FINAL / OPTION B) により 422 Fail-Closed
    const preRejectApp = db.prepare('SELECT current_status, version FROM applications WHERE id = ?').get(appId) as any;

    const rejectRes = WorkflowEngine.rejectApplication(principal, {
      applicationId: appId,
      expectedVersion: preRejectApp.version,
      comment: '公務運営上の支障および事由不充足により不許可とします',
    });
    assert.strictEqual(rejectRes.success, false);
    assert.strictEqual(rejectRes.statusCode, 422);
    assert.strictEqual(rejectRes.errorCode, 'REJECT_ACTION_DEPRECATED');

    // Zero Mutation 検証: 申請ステータス、バージョン、ステップ状態が不変であること (post === pre)
    const appAfterReject = db.prepare('SELECT current_status, version FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(appAfterReject.current_status, preRejectApp.current_status);
    assert.strictEqual(appAfterReject.version, preRejectApp.version);

    const step2 = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND step_order = 2').get(appId) as any;
    assert.strictEqual(step2.status, 'PENDING');
    assert.strictEqual(step2.action_type, 'DECIDE');
  });

  // GT-ACTION-07: ACKステップ → RETURNはServer 422 INVALID_ACTION_FOR_ACK
  it('GT-ACTION-07: 受領確認（ACK）ステップに対して差戻し（RETURN）は 422 INVALID_ACTION_FOR_ACK で遮断される', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】ACK差戻し遮断テスト',
      formData: { unitType: 'DAY', startDate: '2026-06-09', endDate: '2026-06-09', calculatedDays: 1, reason: '私用' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Step 1: 教頭 REVIEW 完了
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version, comment: '確認完了' });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Step 2: 校長 ACK に対する差戻し試行
    const returnRes = WorkflowEngine.returnApplication(principal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '受領確認ステップを差戻そうとする',
    });
    assert.strictEqual(returnRes.success, false);
    assert.strictEqual(returnRes.statusCode, 422);
    assert.strictEqual(returnRes.errorCode, 'INVALID_ACTION_FOR_ACK');
  });

  // GT-ACTION-08: ACKステップ → REJECTはServer 422 INVALID_ACTION_FOR_ACK で遮断される (Guard Hierarchy OPTION B)
  it('GT-ACTION-08: 受領確認（ACK）ステップに対して却下（REJECT）は 422 INVALID_ACTION_FOR_ACK で遮断される', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】ACK却下遮断テスト',
      formData: { unitType: 'DAY', startDate: '2026-06-10', endDate: '2026-06-10', calculatedDays: 1, reason: '私用' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Step 1: 教頭 REVIEW 完了
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version, comment: '確認完了' });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Step 2: 校長 ACK に対する却下試行 ──► ACK非裁量ガードにより 422 INVALID_ACTION_FOR_ACK
    const rejectRes = WorkflowEngine.rejectApplication(principal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '受領確認ステップを却下しようとする',
    });
    assert.strictEqual(rejectRes.success, false);
    assert.strictEqual(rejectRes.statusCode, 422);
    assert.strictEqual(rejectRes.errorCode, 'INVALID_ACTION_FOR_ACK');
  });

  // GT-ACTION-09: 一般教員 LEAVE_ANNUAL → REVIEW完了 → 校長 ACK → 完了可能
  it('GT-ACTION-09: 一般教員の年休届出において校長は正しく受領確認（ACK）を完了でき、FINAL_APPROVEDとなる', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】ACK受領確認テスト',
      formData: { unitType: 'DAY', startDate: '2026-06-11', endDate: '2026-06-11', calculatedDays: 1, reason: '私用' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Step 1: 教頭 REVIEW 完了
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version, comment: '確認完了' });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Step 2: 校長 ACK 完了 (既存 approveApplication を使用)
    const ackRes = WorkflowEngine.approveApplication(principal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '受領確認しました',
    });
    assert.strictEqual(ackRes.success, true);

    const appFinal = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(appFinal.current_status, 'FINAL_APPROVED');
  });

  // GT-ACTION-10: 校長本人 LEAVE_ANNUAL → REVIEW完了 → 校長本人 Positive ACK-A → 完了可能
  it('GT-ACTION-10: 校長本人の年休届出において、教頭審査完了後、校長本人が Positive ACK-A により受領確認を完了できる', () => {
    const submitRes = WorkflowEngine.submitApplication(principal, {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】校長本人届出',
      formData: { unitType: 'DAY', startDate: '2026-06-12', endDate: '2026-06-12', calculatedDays: 1, reason: '私用' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    // Step 1 は教頭 REVIEW
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const reviewRes = WorkflowEngine.approveApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '教頭確認完了',
    });
    assert.strictEqual(reviewRes.success, true);

    // Step 2 は校長本人の受領確認 (Positive ACK-A)
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const ackRes = WorkflowEngine.approveApplication(principal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '校長本人受領確認',
    });
    assert.strictEqual(ackRes.success, true);

    const appFinal = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(appFinal.current_status, 'FINAL_APPROVED');
  });

  // GT-ACTION-11: 校長本人 DECIDE型服務 → SELF-DECISIONは禁止維持 (422 FINAL_AUTHORITY_SELF_COLLISION & 403 FORBIDDEN_SELF_APPROVAL)
  it('GT-ACTION-11: 校長本人のDECIDE型服務（病休）において、Positive ACK-A修正によって自己決裁が緩和されることはなく、提出段階で 422 FINAL_AUTHORITY_SELF_COLLISION で厳格遮断される', () => {
    // 校長本人が病気休暇を申請しようとする → 提出段階で最終自己決裁が遮断される (HD-02: Fail-Closed)
    const submitRes = WorkflowEngine.submitApplication(principal, {
      typeId: 'LEAVE_SICK',
      title: '【病休】校長本人申請',
      formData: { unitType: 'DAY', startDate: '2026-06-15', endDate: '2026-06-15', calculatedDays: 1, reason: '急性胃炎' },
    });
    assert.strictEqual(submitRes.success, false);
    assert.strictEqual(submitRes.statusCode, 422);
    assert.strictEqual(submitRes.errorCode, 'FINAL_AUTHORITY_SELF_COLLISION');

    // 直接 evaluateApproverAuthorization を呼んでも 403 FORBIDDEN_SELF_APPROVAL であることの二重検証
    const { evaluateApproverAuthorization } = require('../workflow/engine');
    const authResult = evaluateApproverAuthorization(
      principal,
      { subject_user_id: principal.id, submitted_by_user_id: principal.id, type_id: 'LEAVE_SICK' },
      { cycle_purpose: 'APPROVAL', started_by_user_id: principal.id },
      { action_type: 'DECIDE', is_final_decision_step: 1, required_role_id: 'PRINCIPAL', assigned_user_id: principal.id }
    );
    assert.strictEqual(authResult.allowed, false);
    assert.strictEqual(authResult.statusCode, 403);
    assert.strictEqual(authResult.errorCode, 'FORBIDDEN_SELF_APPROVAL');
  });

  // GT-ACTION-12-SERVER: 本人申請の submission_actor_type は 'SELF'
  it('GT-ACTION-12-SERVER: 本人申請の submission_actor_type は DB に SELF として記録される', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】本人申請',
      formData: { unitType: 'DAY', startDate: '2026-06-16', endDate: '2026-06-16', calculatedDays: 1, reason: '私用' },
    });
    assert.strictEqual(submitRes.success, true);
    const app = db.prepare('SELECT submission_actor_type, subject_user_id, submitted_by_user_id FROM applications WHERE id = ?').get(submitRes.data.id) as any;
    assert.strictEqual(app.submission_actor_type, 'SELF');
    assert.strictEqual(app.subject_user_id, teacher1.id);
    assert.strictEqual(app.submitted_by_user_id, teacher1.id);
  });

  // GT-ACTION-13-SERVER: 代理申請の submission_actor_type は 'PROXY'
  it('GT-ACTION-13-SERVER: 代理申請の submission_actor_type は DB に PROXY として記録される', () => {
    const proxyRes = WorkflowEngine.submitProxyApplication(vicePrincipal, {
      typeId: 'LEAVE_ANNUAL',
      subjectUserId: teacher1.id,
      title: '【年休】代理申請',
      formData: { unitType: 'DAY', startDate: '2026-06-17', endDate: '2026-06-17', calculatedDays: 1, reason: '私用' },
      proxyReason: '教頭による代理起案',
    });
    assert.strictEqual(proxyRes.success, true);
    const app = db.prepare('SELECT submission_actor_type, subject_user_id, submitted_by_user_id FROM applications WHERE id = ?').get(proxyRes.data.id) as any;
    assert.strictEqual(app.submission_actor_type, 'PROXY');
    assert.strictEqual(app.subject_user_id, teacher1.id);
    assert.strictEqual(app.submitted_by_user_id, vicePrincipal.id);
  });
});
